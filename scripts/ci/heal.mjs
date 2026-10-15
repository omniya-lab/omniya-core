/**
 * Tell a pipeline FAULT from "a person is needed", so a fault can heal itself once.
 *
 * `needs-owner` on a fix pull request used to mean one of several things, and
 * `keep-current.mjs` leaves every one of them alone forever. Seen live (run
 * 38622719115): four repairs failed because the Actions bot started them
 * ("Workflow initiated by non-human actor"), the label stayed, and after the code
 * was fixed nothing ever retried them. A broken pipeline put four contributors'
 * fixes on the owner's list.
 *
 * Two kinds of stuck:
 *   fault   a job of the pipeline itself FAILED (a crashed agent step, a verify that
 *           could not read the runs). Nobody judged the fix. Retrying is free.
 *   person  the repair agent said `needs-owner`, or the checks are still red after the
 *           repairs. A person decided or the code is wrong. Retrying is a waste.
 *
 * The difference is read from the job results, which GitHub reports and the agent
 * cannot write: a job that failed is a fault, a job that succeeded and said
 * `needs-owner` is not. A fault gets the label `pipeline-fault` next to `needs-owner`.
 * `keep-current.mjs` picks that one up after the next push to `testing`, swaps the label
 * for `pipeline-fault-retried` (so it happens once), and runs the same repair again.
 * Green clears all three labels. Red again keeps `needs-owner`, tells nobody a second time.
 *
 * Usage (needs GH_TOKEN and GITHUB_REPOSITORY):
 *   node scripts/ci/heal.mjs clear <pull-request>
 *   RESULTS="success failure skipped" HEAL=true node scripts/ci/heal.mjs stuck <pull-request>
 *     prints `tell=yes` when the contributor has not been told yet, `tell=no` when they have
 */

import { pathToFileURL } from 'node:url';

import { gh as realGh, requireNumber } from './gh.mjs';

export const FAULT = 'pipeline-fault';
export const RETRIED = 'pipeline-fault-retried';
export const OWNER = 'needs-owner';

export { ensureLabel };

/** Labels a green result takes off. */
export const CLEARED = [OWNER, FAULT, RETRIED];

/**
 * A fault is a job that FAILED. `skipped` is the repair that was not needed, `cancelled`
 * is somebody stopping the run, and neither says the pipeline broke.
 * @param {string[]} results job results as GitHub reports them
 */
export function isFault(results) {
  return results.some((result) => result === 'failure');
}

/**
 * Pure: the same question asked of a finished run's jobs, for a pull request that was
 * marked before faults had their own label. Job names look like
 * `repair (56, 60, claude/fix-56-x) / repair-1 / agent`.
 * @param {Array<{name: string, conclusion: string|null}>} jobs
 */
export function runWasFault(jobs) {
  return jobs.some((job) => /(^|\/ )(repair|verify)-\d/.test(job.name) && job.conclusion === 'failure');
}

/** The run a "still red after 3 repair attempts" comment points at: the newest one. */
export function lastStuckRun(comments) {
  const runs = comments
    .map((c) => /still red after 3 repair attempts[^\n]*actions\/runs\/([0-9]+)/.exec(c.body ?? ''))
    .filter(Boolean)
    .map((m) => m[1]);
  return runs.at(-1) ?? '';
}

/**
 * A needs-owner pull request that carries no fault label: was it a fault anyway?
 * @returns {boolean}
 */
export function legacyFault({ repo, pr }, gh = realGh) {
  try {
    const lines = (text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const comments = lines(gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--jq', '.[]|{body}']));
    const run = lastStuckRun(comments);
    if (!run) return false;
    const jobs = lines(gh(['api', `repos/${repo}/actions/runs/${run}/jobs`, '--paginate', '--jq', '.jobs[]|{name,conclusion}']));
    return runWasFault(jobs);
  } catch {
    return false;
  }
}

/** `label create` fails when the label exists. That is fine: it is there. */
function ensureLabel(gh, repo, name, description, token) {
  try {
    gh(['label', 'create', name, '--repo', repo, '--description', description], { token });
  } catch {
    // Already there.
  }
}

function edit(gh, repo, number, flag, label) {
  try {
    gh(['issue', 'edit', String(number), '--repo', repo, flag, label]);
  } catch {
    // The label was not there. Nothing to take off.
  }
}

/** Green: nobody is needed any more. */
export function clear({ repo, pr }, gh = realGh) {
  requireNumber(pr, 'pull request number');
  for (const label of CLEARED) edit(gh, repo, pr, '--remove-label', label);
}

/**
 * Red: a person has to look. Marks a fault so it can heal once.
 * @returns {{fault: boolean, tell: boolean}} `tell`: the contributor has not heard yet
 */
export function stuck({ repo, pr, results, retry }, gh = realGh) {
  requireNumber(pr, 'pull request number');
  const fault = isFault(results);
  ensureLabel(gh, repo, OWNER, 'A person has to look at this');
  gh(['issue', 'edit', String(pr), '--repo', repo, '--add-label', OWNER]);
  if (fault && !retry) {
    ensureLabel(gh, repo, FAULT, 'A pipeline job failed. It retries once by itself');
    gh(['issue', 'edit', String(pr), '--repo', repo, '--add-label', FAULT]);
  }
  // The contributor was told on the first try. A second red says nothing new.
  return { fault, tell: !retry };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, pr] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY;
  if (command === 'clear') {
    clear({ repo, pr });
  } else if (command === 'stuck') {
    const results = (process.env.RESULTS ?? '').split(/\s+/).filter(Boolean);
    const { fault, tell } = stuck({ repo, pr, results, retry: process.env.HEAL === 'true' });
    console.error(fault ? 'a pipeline job failed: marked as a fault' : 'no job failed: a person has to look');
    console.log(`tell=${tell ? 'yes' : 'no'}`);
  } else {
    console.error('usage: heal.mjs clear|stuck <pull-request>');
    process.exit(2);
  }
}
