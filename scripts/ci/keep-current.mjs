/**
 * Keep every open fix branch up to date with `testing`.
 *
 * The backlog built up because `testing` moves on while a contributor tests a
 * fix. The fix branch falls behind, then conflicts, and nothing brings it back.
 * It only comes back when a person does it by hand. This is the part that does
 * it, after every push to `testing` and once a week.
 *
 * For each open `claude/fix-*` pull request into `testing`, from this repository:
 *   - ask GitHub to merge `testing` into the branch (`update-branch`), pinned to
 *     the head it looked at, so a push in between is not overwritten
 *   - if that works, the branch has new commits, the App's push starts the checks
 *     and the build, and nothing else needs saying: the links stay the same
 *   - if it conflicts, the repair agent has to resolve it. The caller does that,
 *     through `pipeline-verify.yml`, for the pull requests this reports
 *
 * It leaves alone a pull request that already carries `needs-owner` or
 * `needs-maintainer`. A repair that failed three times is waiting for a person,
 * and trying again on every push would spend the maintainer's quota for nothing.
 *
 * One exception, and only one: a pull request stuck by a pipeline FAULT (a job of the
 * pipeline failed, see `heal.mjs`) carries `pipeline-fault`, or is old enough to be
 * recognised from the run its comment names. It is picked ONCE: when a run that is not
 * a push (`CLAIM=true`) takes it, `pipeline-fault` becomes `pipeline-fault-retried`, and
 * it is handed to the repair with `heal: true`. A second fault keeps `needs-owner`.
 *
 * It never touches a branch that does not start with `claude/fix-`, a fork, or a
 * pull request into another base.
 *
 * Usage (needs GH_TOKEN, MERGE_TOKEN and GITHUB_REPOSITORY; PR_NUMBER limits it to one):
 *   node scripts/ci/keep-current.mjs
 *
 * Step outputs: conflicts (JSON array of {issue, pr, branch}), updated, current, skipped.
 */

import { pathToFileURL } from 'node:url';

import { BRANCH_PREFIX } from './find-fix-pr.mjs';
import { gh as realGh, requireNumber, setOutputs } from './gh.mjs';
import { ensureLabel, FAULT, legacyFault, OWNER, RETRIED } from './heal.mjs';

/** A person is already needed here, so do not spend a repair on it. */
export const WAITING_LABELS = ['needs-owner', 'needs-maintainer'];

/** The issue a pull request fixes: the `Fixes #N` line the fix agent writes last. */
export function issueOf(body) {
  const match = /(?:^|\n)[Ff]ixes #([0-9]+)[ \t\r\n]*$/.exec(body ?? '');
  return match ? match[1] : '';
}

/**
 * Pure: which pull requests to look at, and which to leave alone.
 * @param {Array<{number:number, body?:string|null, headRefName:string, headRefOid:string, isCrossRepository:boolean, baseRefName:string, labels?:Array<{name:string}>}>} prs
 * @param {string} [only] a pull request number, to look at that one only
 * @param {(pr: object) => boolean} [isLegacyFault] asked of a needs-owner pull request with no fault label
 */
export function plan(prs, only = '', isLegacyFault = () => false) {
  const pick = [];
  const skipped = [];
  const heal = new Set();
  for (const pr of prs) {
    if (only && String(pr.number) !== String(only)) continue;
    const fix =
      pr.isCrossRepository === false &&
      pr.baseRefName === 'testing' &&
      typeof pr.headRefName === 'string' &&
      pr.headRefName.startsWith(BRANCH_PREFIX) &&
      issueOf(pr.body) !== '';
    if (!fix) continue;
    const names = (pr.labels ?? []).map((label) => label.name);
    const waiting = names.some((name) => WAITING_LABELS.includes(name));
    // Once: a fault already retried is a person's now.
    const faulty =
      waiting &&
      !names.includes(RETRIED) &&
      (names.includes(FAULT) || (names.includes(OWNER) && !names.includes('needs-maintainer') && isLegacyFault(pr)));
    if (faulty) {
      heal.add(pr.number);
      pick.push(pr);
    } else if (waiting) {
      skipped.push({ pr: pr.number, why: 'a person is already looking at it' });
    } else {
      pick.push(pr);
    }
  }
  return { pick, skipped, heal };
}

/**
 * What GitHub's answer to `update-branch` means.
 * @param {string} text what came back, success or failure
 * @returns {'updated'|'current'|'conflict'|'error'}
 */
export function outcomeOf(text, ok) {
  if (ok) return 'updated';
  if (/no new commits|already up to date|up-to-date/i.test(text)) return 'current';
  if (/conflict/i.test(text)) return 'conflict';
  return 'error';
}

/**
 * @param {{repo: string, only?: string, mergeToken: string}} args
 * @param {(args: string[], opts?: {token?: string}) => string} [gh]
 */
export function keepCurrent({ repo, only = '', mergeToken, claim = false }, gh = realGh) {
  if (!mergeToken) throw new Error('MERGE_TOKEN is not set. Refusing to update branches without the App token.');
  if (only) requireNumber(only, 'pull request number');

  const prs = JSON.parse(
    gh([
      'pr', 'list', '--repo', repo, '--base', 'testing', '--state', 'open', '--limit', '100',
      '--json', 'number,body,headRefName,headRefOid,isCrossRepository,baseRefName,labels'
    ])
  );
  const { pick, skipped, heal } = plan(prs, only, (pr) => legacyFault({ repo, pr: pr.number }, gh));

  const result = { updated: [], current: [], conflicts: [], healed: [], errors: [], skipped };
  // A push only looks. The run that does the repairs takes the retry, so it is taken once.
  if (claim) {
    for (const number of heal) {
      ensureLabel(gh, repo, RETRIED, 'A pipeline fault, retried once', mergeToken);
      gh(['issue', 'edit', String(number), '--repo', repo, '--add-label', RETRIED, '--remove-label', FAULT], { token: mergeToken });
    }
  }
  for (const pr of pick) {
    const number = requireNumber(pr.number, 'pull request number');
    let text = '';
    let ok = false;
    try {
      // The head it looked at is pinned. If the branch moved, GitHub refuses and the next run tries again.
      text = gh([
        'api', '--method', 'PUT', `repos/${repo}/pulls/${number}/update-branch`,
        '-f', `expected_head_sha=${pr.headRefOid}`
      ], { token: mergeToken });
      ok = true;
    } catch (error) {
      text = String(error.stderr ?? error.message ?? error);
    }
    const outcome = outcomeOf(text, ok);
    if (outcome === 'updated') result.updated.push(pr.number);
    else if (outcome === 'current') result.current.push(pr.number);
    else if (outcome === 'conflict') result.conflicts.push({ issue: issueOf(pr.body), pr: String(pr.number), branch: pr.headRefName, ...(heal.has(pr.number) ? { heal: 'true' } : {}) });
    else result.errors.push({ pr: pr.number, text: text.slice(0, 200) });
    // A fault is repaired from the start: the checks are read again, whether or not it conflicts.
    if (heal.has(pr.number) && outcome !== 'conflict') result.healed.push({ issue: issueOf(pr.body), pr: String(pr.number), branch: pr.headRefName, heal: 'true' });
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = keepCurrent({
    repo: process.env.GITHUB_REPOSITORY,
    only: process.env.PR_NUMBER ?? '',
    mergeToken: process.env.MERGE_TOKEN,
    claim: process.env.CLAIM === 'true'
  });
  setOutputs({
    // Both kinds go to the repair job: a conflict, and a fault given its one retry.
    conflicts: JSON.stringify([...result.conflicts, ...result.healed]),
    updated: JSON.stringify(result.updated),
    current: JSON.stringify(result.current),
    skipped: JSON.stringify(result.skipped.map((s) => s.pr))
  });
  console.log(
    `updated ${result.updated.length}, already current ${result.current.length}, ` +
      `conflicts ${result.conflicts.length}, faults to retry ${result.healed.length}, left alone ${result.skipped.length}, errors ${result.errors.length}`
  );
  for (const e of result.errors) console.log(`::warning::#${e.pr} could not be updated: ${e.text}`);
}
