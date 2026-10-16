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
import { AUTHOR, PIPELINE_PREFIX, isReplyOfState, postReply } from './reply.mjs';

/** The labels that mean "a person has to look at this fix". */
export const LOOK_LABELS = ['needs-maintainer', 'needs-owner'];

/** The two workflows whose result decides whether a test build is ready. */
export const WORKFLOWS = ['pr-checks', 'pr-build'];

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
 * @returns {{say: 'ready'|'revised'|null, why: string}}
 */
export function decide({ pr, comments, runs }) {
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
  if (!newest || !isReplyOfState(newest.body, 'maintainer')) {
    return { say: null, why: 'the contributor is not waiting on the maintainer reply' };
  }
  const notGreen = WORKFLOWS.filter((workflow) => runs[workflow] !== 'success');
  if (notGreen.length > 0) {
    return { say: null, why: `not green yet: ${notGreen.join(', ')}` };
  }
  const saw = ours.some((comment) => GAVE_A_BUILD.some((words) => comment.body.includes(words)));
  return { say: saw ? 'revised' : 'ready', why: 'a person fixed it and it is green' };
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

  const decision = decide({ pr: { labels: pr.labels.map((label) => label.name), body: pr.body }, comments, runs });
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
