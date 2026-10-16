/**
 * Wait for the checks and the build on a fix branch, and say whether they are
 * green. When they are not, keep the log of what failed for the repair agent.
 *
 * Nothing is dispatched here. The agent pushes with the pipeline App's token,
 * and a push or a pull request made with an App token starts the ordinary
 * `pull_request` runs. They start at the push, before this begins, so they are
 * found by the branch and the head commit and nothing else. A run from an
 * earlier round is on an earlier commit, so it is not picked.
 *
 * Usage (needs GH_TOKEN and GITHUB_REPOSITORY):
 *   node scripts/ci/verify-branch.mjs <branch> <pull-request-number> <out-dir>
 *
 * Step outputs: green (true|false), sha. Writes `<out-dir>/failed.log` when not
 * green. It exits non-zero only when it could not find or finish the runs, so a
 * red check is an answer and a missing run is a fault.
 *
 * One missing run is not a fault: a pull request that conflicts with `testing`
 * gets no `pull_request` runs at all. The agent can fix that itself, so it is
 * reported as red with the name `conflict`, and the repair agent merges `testing`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { BRANCH_PREFIX } from './find-fix-pr.mjs';
import { gh, requireNumber, setOutputs } from './gh.mjs';

export const WORKFLOWS = ['pr-checks.yml', 'pr-build.yml'];

/** Newest run on `sha`. */
export function pickRun(runs, { sha }) {
  return runs
    .filter((run) => run.headSha === sha)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

/** Keep the END of a log: the failure is at the bottom, the setup is at the top. */
export function tail(text, limit = 120_000) {
  return text.length <= limit ? text : `[earlier output cut]\n${text.slice(text.length - limit)}`;
}

/** Why a conflicting pull request has no checks, and what the agent does about it. */
export const CONFLICT_LOG =
  'The pull request conflicts with `testing`, so GitHub did not start its checks.\n' +
  'Merge `origin/testing` into the branch, resolve every conflict, regenerate the generated files, and push.\n' +
  'The checks will start after the push.\n';

/**
 * The branch can move while its checks run: `keep-current` merges `testing` into it, or a
 * repair pushes. The new head's runs CANCEL the old head's (one run per pull request), so a
 * wait on the old head ends in "cancelled" with no failing step, and the repair agent is sent
 * to fix nothing (seen live: three repairs, then the maintainer). A cancelled run on a head
 * that is no longer the head is not an answer. Look again at the new head, up to three times.
 * @param {object} io
 * @param {(args: string[]) => string} io.gh
 * @param {(ms: number) => Promise<void>} io.sleep
 * @param {() => number} io.now
 */
export async function verifyBranch(io, options) {
  let result;
  for (let round = 0; round < 3; round += 1) {
    result = await verifyOnce(io, options);
    if (!result.moved) break;
  }
  return result;
}

async function verifyOnce(
  { gh: run, sleep, now },
  { repo, branch, pr, pollMs = 30_000, mergeableMs = 60_000, appearMs = 5 * 60_000, finishMs = 80 * 60_000 }
) {
  if (!branch.startsWith(BRANCH_PREFIX)) throw new Error(`refusing branch ${branch}: not a ${BRANCH_PREFIX} branch`);
  requireNumber(pr, 'pull request number');

  const sha = run(['api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha']).trim();

  const mergeable = () =>
    run(['pr', 'view', String(pr), '--repo', repo, '--json', 'mergeable', '--jq', '.mergeable']).trim();
  const behind = () => {
    try {
      return Number(run(['api', `repos/${repo}/compare/testing...${branch}`, '--jq', '.behind_by']).trim()) || 0;
    } catch {
      return 0;
    }
  };
  const conflict = () => ({ green: false, sha, failed: ['conflict'], log: CONFLICT_LOG });

  // GitHub works the answer out in the background, so UNKNOWN means ask again.
  const mergeableBy = now() + mergeableMs;
  let state = mergeable();
  while (state === 'UNKNOWN' && now() <= mergeableBy) {
    await sleep(pollMs);
    state = mergeable();
  }
  if (state === 'CONFLICTING') return conflict();

  const list = (workflow) =>
    JSON.parse(
      run([
        'run', 'list', '--repo', repo, '--workflow', workflow, '--branch', branch,
        '--event', 'pull_request', '--limit', '20',
        '--json', 'databaseId,headSha,createdAt,status,conclusion'
      ])
    );

  const found = {};
  for (const workflow of WORKFLOWS) {
    const deadline = now() + appearMs;
    for (;;) {
      const picked = pickRun(list(workflow), { sha });
      if (picked) {
        found[workflow] = picked;
        break;
      }
      if (now() > deadline) {
        if (mergeable() === 'CONFLICTING') return conflict();
        // GitHub may never finish working out the answer (UNKNOWN), and starts no checks for
        // a pull request that conflicts. A branch that is BEHIND testing and has no checks is
        // sent to the repair agent, which merges testing in. That push starts the checks.
        if (behind() > 0) return conflict();
        throw new Error(`${workflow} did not start on ${branch} at ${sha}`);
      }
      await sleep(pollMs);
    }
  }

  const finishBy = now() + finishMs;
  const done = {};
  while (Object.keys(done).length < WORKFLOWS.length) {
    for (const workflow of WORKFLOWS) {
      if (done[workflow]) continue;
      const latest = pickRun(list(workflow), { sha });
      if (latest && latest.databaseId === found[workflow].databaseId && latest.status === 'completed') {
        done[workflow] = latest;
      }
    }
    if (Object.keys(done).length === WORKFLOWS.length) break;
    if (now() > finishBy) throw new Error(`the runs on ${branch} did not finish in time`);
    await sleep(pollMs);
  }

  const failed = WORKFLOWS.filter((workflow) => done[workflow].conclusion !== 'success');
  const logs = failed.map((workflow) => {
    const id = done[workflow].databaseId;
    let log;
    try {
      log = run(['run', 'view', String(id), '--repo', repo, '--log-failed']);
    } catch (error) {
      log = `(the log could not be read: ${error.message})`;
    }
    return `===== ${workflow} run ${id}: ${done[workflow].conclusion} =====\n${tail(log)}`;
  });

  const cancelled = failed.some((workflow) => done[workflow].conclusion === 'cancelled');
  const head = run(['api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha']).trim();
  return { green: failed.length === 0, sha, failed, log: logs.join('\n\n'), moved: cancelled && head !== sha };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [branch, pr, outDir] = process.argv.slice(2);
  const result = await verifyBranch(
    { gh, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now() },
    { repo: process.env.GITHUB_REPOSITORY, branch, pr }
  );
  if (!result.green) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/failed.log`, result.log);
  }
  setOutputs({ green: result.green, sha: result.sha });
}
