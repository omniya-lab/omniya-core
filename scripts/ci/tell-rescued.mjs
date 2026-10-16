/**
 * Tell the contributor when a person has rescued their fix.
 *
 * `pipeline-verify.yml` ends in one of two ways. Green: it posts the test build
 * on the issue. Red after three repairs: it says a person has to look, and puts
 * `needs-maintainer` (or the agent puts `needs-owner`) on the pull request.
 * After that, nobody told the contributor anything when the person fixed it.
 * The checks went green, the build was replaced behind the same links, and the
 * issue still said "the maintainer will write here when there is news".
 *
 * This is the missing second half. It runs after the checks or the build of a
 * fix branch finish, and it posts only when ALL of these are true:
 *   - exactly one open `claude/fix-` pull request is on that branch, from this
 *     repository, and it names its issue on its last line (`Fixes #N`)
 *   - it still carries a "a person has to look" label
 *   - the newest comment from this pipeline on the issue IS the `maintainer`
 *     reply, so the contributor is still waiting on that sentence
 *   - the checks AND the build of the branch's current commit both passed
 *
 * A second kind of wait: the hand-off told the contributor "the maintainer has to look" (`sent-automation`
 * or `sent-owner`) because of WHERE the fix's files were, and then the rules or the files changed so the
 * same hand-off would now let it through (the build scripts moved into a folder that merges by itself, or
 * a person moved the fix's two generators there). Nobody has to look, and the contributor still waits on
 * that sentence. It counts as a wait only when the hand-off's own rules (`hand-off.mjs`, run on the
 * pull request as it is now) no longer protect it. A fix that is still protected stays silent.
 *
 * Then it posts one comment, `ready` if the contributor never saw a build and
 * `revised` if they did, and takes the label off. Both writers go through
 * `reply.mjs`, so the text and the marker are the ones every other reply has.
 *
 * Why it cannot post twice. The newest pipeline comment is now `ready` or
 * `revised`, not `maintainer`, so a second run finds nothing to say. The
 * workflow also runs one at a time per branch. The ordinary green path never
 * sets the label and never leaves the `maintainer` reply as the newest, so it
 * and this script cannot both speak for the same event.
 *
 * Usage (needs GH_TOKEN and GITHUB_REPOSITORY):
 *   node scripts/ci/tell-rescued.mjs <branch>
 */

import { pathToFileURL } from 'node:url';

import { BRANCH_PREFIX, matchFixPrs } from './find-fix-pr.mjs';
import { gh, requireNumber } from './gh.mjs';
import { decide as handOffDecide } from './hand-off.mjs';
import { AUTHOR, PIPELINE_PREFIX, isReplyOfState, postReply } from './reply.mjs';

/** The labels that mean "a person has to look at this fix". */
export const LOOK_LABELS = ['needs-maintainer', 'needs-owner'];

/** The two workflows whose result decides whether a test build is ready. */
export const WORKFLOWS = ['pr-checks', 'pr-build'];

/** The hand-off replies that say a person must look first. They stop being true when the rules stop protecting the fix. */
export const HAND_OFF_WAITS = ['sent-automation', 'sent-owner'];

/** The first words of a comment that gave the contributor a build. */
const GAVE_A_BUILD = ['A test build is ready.', 'A new test build is ready.'];

/** @param {string} body */
function issueOf(body) {
  const match = /(?:^|\n)[Ff]ixes #([0-9]+)[ \t\r\n]*$/.exec(body ?? '');
  return match ? match[1] : '';
}

/**
 * Decide what to say. Pure: the same inputs always give the same answer.
 *
 * @param {object} input
 * @param {{labels: string[], body: string}} input.pr
 * @param {Array<{body: string, user?: {login: string}}>} input.comments the issue's comments, oldest first
 * @param {Record<string, string>} input.runs conclusion of the newest run of each workflow, on the branch's current commit
 * @param {boolean} [input.stillProtected] whether the hand-off would still protect the pull request. Only a
 *   hand-off wait (`sent-automation`, `sent-owner`) is lifted by `false`; anything else, or nothing, keeps it.
 * @returns {{say: 'ready'|'revised'|null, why: string}}
 */
export function decide({ pr, comments, runs, stillProtected = true }) {
  if (!pr.labels.some((label) => LOOK_LABELS.includes(label))) {
    return { say: null, why: 'the pull request is not waiting on a person' };
  }
  // Anyone can comment on a public issue and start the text with the marker. Only
  // the Actions bot is the pipeline, so only its comments count.
  const ours = comments.filter(
    (comment) => comment.user?.login === AUTHOR && (comment.body ?? '').startsWith(PIPELINE_PREFIX)
  );
  const newest = ours.at(-1);
  // GitHub trims the trailing newline off a stored comment. Comments from before the state line
  // existed are the same words without it, and the contributor is still waiting on them.
  const handOffWait = Boolean(newest) && HAND_OFF_WAITS.some((state) => isReplyOfState(newest.body, state));
  if (!newest || !(isReplyOfState(newest.body, 'maintainer') || (handOffWait && stillProtected === false))) {
    return { say: null, why: 'the contributor is not waiting on the maintainer reply' };
  }
  const notGreen = WORKFLOWS.filter((workflow) => runs[workflow] !== 'success');
  if (notGreen.length > 0) {
    return { say: null, why: `not green yet: ${notGreen.join(', ')}` };
  }
  const saw = ours.some((comment) => GAVE_A_BUILD.some((words) => comment.body.includes(words)));
  return { say: saw ? 'revised' : 'ready', why: 'a person fixed it and it is green' };
}

/** Would the hand-off still protect this pull request as it is now? True when anything cannot be read. */
export function stillProtectedNow({ pr, repo }, run = gh) {
  try {
    const view = JSON.parse(run(['pr', 'view', String(pr), '--repo', repo, '--json', 'mergeable,body,changedFiles']));
    const files = run(['api', `repos/${repo}/pulls/${pr}/files`, '--paginate', '--jq', '.[] | {filename, previous_filename, status, additions, deletions}'])
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const filesComplete = Number.isInteger(view.changedFiles) && files.length === view.changedFiles && files.length < 3000;
    return handOffDecide({ files, filesComplete, fixBranch: true, mergeable: view.mergeable, body: view.body, missing: [] }).action === 'protected';
  } catch {
    return true;
  }
}

/**
 * @param {{branch: string, repo: string}} args
 * @param {(args: string[]) => string} [run]
 */
export function tellRescued({ branch, repo }, run = gh) {
  if (!branch.startsWith(BRANCH_PREFIX)) throw new Error(`refusing branch ${branch}: not a ${BRANCH_PREFIX} branch`);

  const listed = JSON.parse(
    run([
      'pr', 'list', '--repo', repo, '--base', 'testing', '--state', 'open', '--head', branch, '--limit', '5',
      '--json', 'number,body,headRefName,headRefOid,isCrossRepository,labels'
    ])
  );
  const candidates = listed.filter((pr) => issueOf(pr.body));
  const matches = candidates.flatMap((pr) => matchFixPrs([pr], issueOf(pr.body)));
  if (matches.length !== 1) return { said: null, why: `${matches.length} fix pull requests on ${branch}` };
  const [pr] = matches;
  const issue = requireNumber(issueOf(pr.body), 'issue number');

  const comments = JSON.parse(
    run(['api', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--slurp'])
  ).flat();

  const runs = {};
  for (const workflow of WORKFLOWS) {
    const newest = JSON.parse(
      run([
        'run', 'list', '--repo', repo, '--workflow', workflow, '--branch', branch, '--limit', '20',
        '--json', 'headSha,status,conclusion,createdAt'
      ])
    ).find((entry) => entry.headSha === pr.headRefOid);
    runs[workflow] = newest && newest.status === 'completed' ? newest.conclusion : '';
  }

  const labels = pr.labels.map((label) => label.name);
  // The files are read only when the contributor's last word is a hand-off wait and the checks are green.
  const lastOurs = comments.filter((c) => c.user?.login === AUTHOR && (c.body ?? '').startsWith(PIPELINE_PREFIX)).at(-1);
  const mayLift = labels.some((label) => LOOK_LABELS.includes(label)) && lastOurs && HAND_OFF_WAITS.some((state) => isReplyOfState(lastOurs.body, state)) && WORKFLOWS.every((workflow) => runs[workflow] === 'success');
  const stillProtected = mayLift ? stillProtectedNow({ pr: pr.number, repo }, run) : true;
  const decision = decide({ pr: { labels, body: pr.body }, comments, runs, stillProtected });
  if (!decision.say) return { said: null, why: decision.why };

  postReply({ issue, state: decision.say, repo, pr: pr.number }, run);
  for (const label of LOOK_LABELS) {
    if (pr.labels.some((entry) => entry.name === label)) {
      run(['issue', 'edit', String(pr.number), '--repo', repo, '--remove-label', label]);
    }
  }
  return { said: decision.say, why: decision.why, issue, pr: pr.number };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = tellRescued({ branch: process.argv[2] ?? '', repo: process.env.GITHUB_REPOSITORY });
  console.log(result.said ? `told issue #${result.issue}: ${result.said}` : `nothing to say: ${result.why}`);
}
