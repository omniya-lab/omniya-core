/**
 * Is this comment the contributor saying "it works"? Decided with no agent.
 *
 * A confirmation used to cost a full agent run (macOS, Claude tokens) only for
 * the agent to read the comment and answer `approved`. This is the same decision
 * made by an allow list, in the cheap gate job.
 *
 * It is a confirmation only if ALL of these hold:
 *   1. The WHOLE comment is one of PHRASES, once an optional leading `@claude`,
 *      case, punctuation and emoji are taken away. `it works but the button is
 *      wrong` is not one. Bare `yes` and `good` are not on the list: they could
 *      be the answer to a question.
 *   2. The commenter is the issue's author, or the owner.
 *   3. The newest comment by `github-actions[bot]` on the issue is a reply in a
 *      READY_STATES state (a build to try), and it is older than this comment.
 *      A question, a design refusal, a stuck message or an unmarked notice
 *      is not, so a bare phrase that answers one does nothing.
 *   4. Exactly one open fix pull request is awaiting confirmation (the caller
 *      passes the count from `find-fix-pr.mjs`).
 *   5. The pull request's head commit has a successful `pack-mac` build that
 *      FINISHED before that build comment, by GitHub's own clock, so the build
 *      the contributor tried is the commit that would merge. A git commit date
 *      is written by whoever pushed, so it is never used. The commit comes from
 *      ONE read, in the caller, and is the very commit that is pinned: the
 *      hand-off refuses to act on any other.
 *
 * Anything else prints `confirm=false` and posts nothing.
 *
 * Usage (needs GH_TOKEN and GITHUB_REPOSITORY):
 *   COMMENT_ID=... node scripts/ci/confirm.mjs <issue> <comment-id> <commenter> <issue-author> <association> <pr-count> <pr> <head-sha>
 *   node scripts/ci/confirm.mjs --shape   (reads COMMENT_ID, or INPUT_BODY; prints shaped, mention)
 *
 * Step outputs: confirm (true|false), reason, and with `--shape` shaped and mention.
 */

import { pathToFileURL } from 'node:url';

import { gh, requireNumber, setOutputs } from './gh.mjs';
import { AUTHOR, PIPELINE_PREFIX } from './reply.mjs';

export const PHRASES = [
  'it works',
  'it works now',
  'works',
  'it is fixed',
  'its fixed',
  'fixed',
  'it works great',
  'looks good'
];

/** The reply states that hand the contributor a build to try. */
export const READY_STATES = ['ready', 'revised'];

const MAX_LENGTH = 200;

/** Cut an optional leading `@claude`, then lower case, drop punctuation and emoji, squeeze spaces. */
export function normalise(body) {
  const text = String(body ?? '').normalize('NFKC');
  if (text.length > MAX_LENGTH) return null;
  return text
    .replace(/^\s*@claude\b/i, '')
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pure: is the whole comment a confirmation phrase? */
export function isConfirmPhrase(body) {
  const n = normalise(body);
  return n !== null && PHRASES.includes(n);
}

export const mentionsClaude = (body) => String(body ?? '').includes('@claude');

/**
 * The state named on a bot comment, or '' if it is not one of the pipeline's
 * replies. The first line must carry the prefix and the state line must be the
 * second, exactly as `reply.mjs` writes them.
 */
export function replyState(body) {
  const [first, second] = String(body ?? '').split('\n');
  if (!first?.startsWith(PIPELINE_PREFIX)) return '';
  const m = /^<!-- omniya-pipeline-state ([a-z-]+) -->$/.exec((second ?? '').trim());
  return m ? m[1] : '';
}

/**
 * Pure: the GitHub-facing conditions.
 *
 * @param {{commenter:string, issueAuthor:string, association:string, prCount:number|string,
 *   commentId:number, issueComments:Array<{id:number,created_at:string,body:string,user:{login:string}}>,
 *   headBuiltAt:string}} input `headBuiltAt` is when GitHub finished the successful build check of the head commit ('' if none).
 * @returns {{confirm:boolean, reason:string}}
 */
export function decide({ commenter, issueAuthor, association, prCount, commentId, issueComments, headBuiltAt }) {
  if (!commenter || (commenter !== issueAuthor && association !== 'OWNER')) return { confirm: false, reason: 'not-author' };
  if (Number(prCount) !== 1) return { confirm: false, reason: 'no-single-fix' };
  const bot = (issueComments ?? [])
    .filter((c) => c.user?.login === AUTHOR)
    .sort((a, b) => a.id - b.id)
    .at(-1);
  if (!bot) return { confirm: false, reason: 'no-bot-comment' };
  if (bot.id > Number(commentId)) return { confirm: false, reason: 'bot-spoke-after' };
  if (!READY_STATES.includes(replyState(bot.body))) return { confirm: false, reason: 'newest-not-a-build' };
  if (!headBuiltAt || !(Date.parse(headBuiltAt) <= Date.parse(bot.created_at))) return { confirm: false, reason: 'head-not-built-before-build-comment' };
  return { confirm: true, reason: 'ok' };
}

/** The build job whose result says "this commit was built": the job name in `pr-build.yml`. */
export const BUILD_CHECK = 'pack-mac';
/** Only a check run made by GitHub Actions counts. Any app can create a check run with any name. */
export const BUILD_APP = 'github-actions';

/**
 * Pure: when did GitHub finish the newest build check of a commit, if that check passed?
 * The check run must come from GitHub Actions itself (`app`), and its result and time are
 * written by GitHub, not by whoever pushed the commit.
 * @param {Array<{name:string, app?:string, conclusion:string|null, completed_at:string|null}>} checkRuns
 * @returns {string} an ISO time, or '' when the newest build check did not pass
 */
export function builtAt(checkRuns) {
  const done = (checkRuns ?? [])
    .filter((c) => c?.name === BUILD_CHECK && c.app === BUILD_APP && c.completed_at)
    .sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at))
    .at(-1);
  return done && done.conclusion === 'success' ? done.completed_at : '';
}

/**
 * @param {{issue:string|number, commentId:string|number, commenter:string, issueAuthor:string, association:string,
 *   prCount:string|number, sha:string, repo:string}} args `sha` is the head commit, read ONCE by the caller and pinned by it.
 */
export function confirmFromGitHub({ issue, commentId, commenter, issueAuthor, association, prCount, sha, repo }, run = gh) {
  const n = requireNumber(issue, 'issue number');
  const issueComments = run(['api', `repos/${repo}/issues/${n}/comments`, '--paginate', '--jq', '.[] | {id, created_at, body, user: {login: .user.login}}'])
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let headBuiltAt = '';
  if (Number(prCount) === 1) {
    if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) return { confirm: false, reason: 'no-head-commit' };
    const checkRuns = run(['api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate', '--jq', '.check_runs[] | {name, app: .app.slug, conclusion, completed_at}'])
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    headBuiltAt = builtAt(checkRuns);
  }
  return decide({ commenter, issueAuthor, association, prCount, commentId: Number(commentId), issueComments, headBuiltAt });
}

/** The comment's text. A real comment is read from GitHub by its number; a rehearsal passes INPUT_BODY. */
export function loadBody(env = process.env, run = gh) {
  if (!env.COMMENT_ID) return env.INPUT_BODY ?? '';
  const id = requireNumber(env.COMMENT_ID, 'comment id');
  return run(['api', `repos/${env.GITHUB_REPOSITORY}/issues/comments/${id}`, '--jq', '.body']).replace(/\n$/, '');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const body = loadBody();
  if (process.argv[2] === '--shape') {
    setOutputs({ shaped: isConfirmPhrase(body), mention: mentionsClaude(body) });
  } else {
    const [issue, commentId, commenter, issueAuthor, association, prCount, , sha] = process.argv.slice(2);
    const result = isConfirmPhrase(body)
      ? confirmFromGitHub({ issue, commentId, commenter, issueAuthor, association, prCount, sha, repo: process.env.GITHUB_REPOSITORY })
      : { confirm: false, reason: 'not-a-phrase' };
    setOutputs(result);
  }
}
