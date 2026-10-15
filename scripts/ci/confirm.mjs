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
 *   5. The pull request's head commit is older than that build comment, so the
 *      build the contributor tried is the commit that would merge. The commit is
 *      then pinned: the hand-off refuses to act on any other.
 *
 * Anything else prints `confirm=false` and posts nothing.
 *
 * Usage (needs GH_TOKEN and GITHUB_REPOSITORY):
 *   COMMENT_ID=... node scripts/ci/confirm.mjs <issue> <comment-id> <commenter> <issue-author> <association> <pr-count> <pr>
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
 *   headDate:string}} input
 * @returns {{confirm:boolean, reason:string}}
 */
export function decide({ commenter, issueAuthor, association, prCount, commentId, issueComments, headDate }) {
  if (!commenter || (commenter !== issueAuthor && association !== 'OWNER')) return { confirm: false, reason: 'not-author' };
  if (Number(prCount) !== 1) return { confirm: false, reason: 'no-single-fix' };
  const bot = (issueComments ?? [])
    .filter((c) => c.user?.login === AUTHOR)
    .sort((a, b) => a.id - b.id)
    .at(-1);
  if (!bot) return { confirm: false, reason: 'no-bot-comment' };
  if (bot.id > Number(commentId)) return { confirm: false, reason: 'bot-spoke-after' };
  if (!READY_STATES.includes(replyState(bot.body))) return { confirm: false, reason: 'newest-not-a-build' };
  if (!headDate || !(Date.parse(headDate) <= Date.parse(bot.created_at))) return { confirm: false, reason: 'head-newer-than-build' };
  return { confirm: true, reason: 'ok' };
}

export function confirmFromGitHub({ issue, commentId, commenter, issueAuthor, association, prCount, pr, repo }, run = gh) {
  const n = requireNumber(issue, 'issue number');
  const issueComments = run(['api', `repos/${repo}/issues/${n}/comments`, '--paginate', '--jq', '.[] | {id, created_at, body, user: {login: .user.login}}'])
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let headDate = '';
  if (Number(prCount) === 1) {
    const p = requireNumber(pr, 'pull request number');
    const sha = JSON.parse(run(['pr', 'view', p, '--repo', repo, '--json', 'headRefOid'])).headRefOid;
    headDate = run(['api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.committer.date']).trim();
  }
  return decide({ commenter, issueAuthor, association, prCount, commentId: Number(commentId), issueComments, headDate });
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
    const [issue, commentId, commenter, issueAuthor, association, prCount, pr] = process.argv.slice(2);
    const result = isConfirmPhrase(body)
      ? confirmFromGitHub({ issue, commentId, commenter, issueAuthor, association, prCount, pr, repo: process.env.GITHUB_REPOSITORY })
      : { confirm: false, reason: 'not-a-phrase' };
    setOutputs(result);
  }
}
