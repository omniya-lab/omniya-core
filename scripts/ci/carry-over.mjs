/**
 * Carry a contributor's "it works" over a branch update.
 *
 * The contributor tests a build and says it works. The hand-off accepts that for the EXACT
 * commit they tested. Then a fix lands on `testing`, `keep-current.mjs` merges `testing` into the
 * fix branch, the head moves, and the approval is for a commit that is no longer the head.
 * Nothing merges, and nobody is told why. The fix is the same fix. Only the lines around it moved.
 *
 * An approval for commit A carries to the head H only if ALL of these hold. Anything else is
 * today's behaviour (the contributor is asked to try the new build). Every rule fails closed.
 *
 *  1. A is an ancestor of H. A force-pushed branch fails here.
 *  2. Every commit that is on the branch between A and H (not already in `testing`) is EITHER a
 *     merge of `testing` into the branch, authored by the pipeline (GitHub made it, GitHub signed
 *     it, and its author is the pipeline's App or github-actions), OR it changes none of the fix's
 *     own files.
 *  3. The fix's net change is the same. For A and for H, take the change from the merge base with
 *     `testing` to the commit: per file, the sorted lines it adds and removes (`git diff -U0`,
 *     hunk headers dropped). The file lists must be the same and so must every line list. A
 *     patch id is not used: the context lines move when `testing` moves, and the id with them.
 *  4. Every file is in the zone the hand-off allows. That is the hand-off's own `decide`.
 *  5. The other hand-off rules are unchanged, because the hand-off runs: conflict, test removed,
 *     test weakened, standing note, draft, green checks, the author-only approval.
 *
 * Where the approval comes from. The ONLY source is a comment by the issue's author that is
 * exactly a confirmation phrase (`confirm.mjs`). A "Commit tested" comment on the pull request
 * is not a source: any workflow on a branch can post as `github-actions`. The commit A is the one
 * built when the contributor was last handed a build (a bot `ready` or `revised` comment), by
 * GitHub's own clock. The approval is void if ANYONE but the pipeline wrote on the issue after it,
 * or the pipeline said anything but `sent`, `revised` or `carried`: a question, a refusal, a
 * conflict notice all mean the conversation went on.
 *
 * The merge is pinned to H. The contributor is told once, with the reply state `carried`.
 *
 * Usage (needs GH_TOKEN and GITHUB_REPOSITORY; MERGE_TOKEN unless --dry; run in a full clone):
 *   node scripts/ci/carry-over.mjs [--dry] [--pr <n>] [--json]
 * Env: TESTING_REF (default origin/testing), PIPELINE_BOT_LOGINS (comma list, default github-actions[bot]).
 * --dry changes nothing and prints what each pull request would get.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { builtAt, isConfirmPhrase, replyState } from './confirm.mjs';
import { BRANCH_PREFIX } from './find-fix-pr.mjs';
import { gh as realGh, requireNumber } from './gh.mjs';
import { decide as decideHandOff, handOff, notGreen } from './hand-off.mjs';
import { issueOf, WAITING_LABELS } from './keep-current.mjs';
import { AUTHOR } from './reply.mjs';

const SHA = /^[0-9a-f]{40}$/;

/** What the pipeline may say on the issue after "it works" without voiding it. */
export const SAYS_AFTER_APPROVAL = ['sent', 'revised', 'carried'];
/** How many of the newest commits of a pull request are looked at to find the one that was built. */
export const MAX_COMMITS = 60;

/** A git runner for a clone at `cwd`. No pager, no prompt, no external diff or text filter. */
export function makeGit(cwd) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '' };
  return (args) =>
    execFileSync('git', ['-c', 'core.quotepath=off', '-c', 'core.pager=cat', ...args], {
      cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env, stdio: ['ignore', 'pipe', 'pipe']
    });
}

const succeeds = (git, args) => {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
};

const literal = (path) => `:(literal)${path}`;

/**
 * The fix's change as a comparable value: from the merge base with `testing` to `tip`.
 * @returns {Map<string, {status:string, mode:string, binary:string|null, lines:string[]}>}
 */
export function netChange(git, tip, testing) {
  const base = git(['merge-base', tip, testing]).trim();
  if (!SHA.test(base)) throw new Error('no merge base');
  const raw = git(['diff-tree', '-r', '--raw', '--no-renames', '--no-abbrev', '-z', base, tip]).split('\0');
  const change = new Map();
  for (let i = 0; i < raw.length; i += 1) {
    const header = raw[i];
    if (!header.startsWith(':')) continue;
    const path = raw[i + 1];
    i += 1;
    const [, newMode, , newBlob, status] = header.split(/[ \t]/);
    // A submodule or a symlink is not a thing a text comparison can vouch for.
    if (newMode === '160000' || (newMode === '120000')) throw new Error(`not comparable: ${path}`);
    const text = git(['diff', '-U0', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', base, tip, '--', literal(path)]);
    const binary = /^Binary files |^GIT binary patch/m.test(text);
    const lines = [];
    if (!binary) {
      let inHunk = false;
      for (const line of text.split('\n')) {
        if (line.startsWith('@@')) { inHunk = true; continue; }
        if (!inHunk) continue;
        if (line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')) lines.push(line);
      }
      lines.sort();
    }
    change.set(path, { status, mode: newMode, binary: binary ? newBlob : null, lines });
  }
  return change;
}

/** @returns {{same: boolean, path?: string}} the first difference, if any. */
export function sameChange(a, b) {
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const path of paths) {
    const x = a.get(path);
    const y = b.get(path);
    if (!x || !y) return { same: false, path };
    if (x.status !== y.status || x.mode !== y.mode || x.binary !== y.binary) return { same: false, path };
    if (x.lines.length !== y.lines.length || x.lines.some((line, k) => line !== y.lines[k])) return { same: false, path };
  }
  return { same: true };
}

/**
 * Pure of GitHub: does an approval for commit `from` carry to commit `head`?
 *
 * @param {{git: (args: string[]) => string, from: string, head: string, testing: string,
 *   isPipelineMerge: (sha: string) => boolean}} args `isPipelineMerge` says GitHub made and signed the
 *   commit and its author is the pipeline. It is asked only of merge commits.
 * @returns {{carry: boolean, reason: string}}
 */
export function carryDecision({ git, from, head, testing, isPipelineMerge }) {
  if (!SHA.test(String(from)) || !SHA.test(String(head))) return { carry: false, reason: 'bad-commit' };
  if (from === head) return { carry: false, reason: 'same-commit' };
  // 1. A force-push leaves A somewhere the branch no longer goes (or gone from the clone).
  if (!succeeds(git, ['cat-file', '-e', `${from}^{commit}`]) || !succeeds(git, ['cat-file', '-e', `${head}^{commit}`])) {
    return { carry: false, reason: 'commit-missing' };
  }
  if (!succeeds(git, ['merge-base', '--is-ancestor', from, head])) return { carry: false, reason: 'not-ancestor' };
  // 3. The same fix.
  let before;
  let after;
  try {
    before = netChange(git, from, testing);
    after = netChange(git, head, testing);
  } catch (error) {
    return { carry: false, reason: `cannot-compare: ${String(error.message).slice(0, 80)}` };
  }
  if (after.size === 0) return { carry: false, reason: 'empty-fix' };
  const same = sameChange(before, after);
  if (!same.same) return { carry: false, reason: `fix-changed: ${same.path}` };
  // 2. Only testing merged in by the pipeline, or commits that do nothing to the fix.
  const fixPaths = [...after.keys()].map(literal);
  const commits = git(['rev-list', '--reverse', '--topo-order', head, `^${from}`, `^${testing}`]).split('\n').filter(Boolean);
  for (const sha of commits) {
    const parents = git(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1);
    if (parents.length === 0 || parents.length > 2) return { carry: false, reason: `odd-commit: ${sha}` };
    if (parents.length === 2 && succeeds(git, ['merge-base', '--is-ancestor', parents[1], testing]) && isPipelineMerge(sha)) continue;
    const touched = git(['diff-tree', '-r', '--name-only', '--no-renames', '-z', parents[0], sha, '--', ...fixPaths]);
    if (touched.replace(/\0/g, '') !== '') return { carry: false, reason: `commit-changes-fix: ${sha}` };
  }
  return { carry: true, reason: 'same-fix' };
}

const isBot = (c) => c.user?.login === AUTHOR;

/**
 * Pure: has the issue's author said "it works" in a way that is still standing?
 *
 * @param {{issueAuthor: string, comments: Array<{id:number, created_at:string, body:string, user:{login:string}}>}} input
 * @returns {{approval: null|{commentId:number, builtBefore:string, alreadyTold:boolean}, reason: string}}
 *   `builtBefore` is when the build comment the contributor was last given was posted.
 */
export function findApproval({ issueAuthor, comments }) {
  const all = [...(comments ?? [])].sort((a, b) => a.id - b.id);
  const said = all.filter((c) => c.user?.login === issueAuthor && !isBot(c) && isConfirmPhrase(c.body)).at(-1);
  if (!issueAuthor || !said) return { approval: null, reason: 'no-approval' };
  const build = all.filter((c) => c.id < said.id && isBot(c)).at(-1);
  if (!build || !['ready', 'revised'].includes(replyState(build.body))) return { approval: null, reason: 'no-build-before-approval' };
  for (const c of all.filter((x) => x.id > said.id)) {
    if (!isBot(c)) return { approval: null, reason: 'someone-wrote-after-approval' };
    const state = replyState(c.body);
    if (!SAYS_AFTER_APPROVAL.includes(state)) return { approval: null, reason: `pipeline-said-${state || 'something-else'}-after-approval` };
  }
  const alreadyTold = all.some((c) => c.id > said.id && isBot(c) && replyState(c.body) === 'carried');
  return { approval: { commentId: said.id, builtBefore: build.created_at, alreadyTold }, reason: 'ok' };
}

/**
 * Pure: the commit the contributor was last handed a build of: the newest commit whose build finished
 * (by GitHub's clock) at or before the build comment.
 * @param {Array<{sha:string, builtAt:string}>} commits oldest first. `builtAt` is '' for a commit with no good build.
 */
export function approvedCommit(commits, builtBefore) {
  const limit = Date.parse(builtBefore);
  let best = null;
  for (const c of commits) {
    const t = Date.parse(c.builtAt);
    if (!Number.isFinite(t) || !(t <= limit)) continue;
    if (!best || t >= best.t) best = { sha: c.sha, t };
  }
  return best?.sha ?? '';
}

const jsonLines = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Real `isPipelineMerge`: GitHub signed it as itself, and the author is one of `logins`. */
export function pipelineMergeCheck(repo, logins, gh = realGh) {
  return (sha) => {
    const c = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}`]));
    return (
      c.commit?.verification?.verified === true &&
      c.committer?.login === 'web-flow' &&
      logins.includes(c.author?.login) &&
      c.author?.type === 'Bot'
    );
  };
}

/**
 * One pull request. With `dry` nothing is written.
 *
 * @returns {{pr:number, outcome:'carried'|'would-carry'|'skip', reason:string, from?:string, head?:string}}
 */
export function carryOne({ pr, repo, git, testing, logins, mergeToken, dry = false, ignoreLabels = false }, gh = realGh) {
  const out = (outcome, reason, extra = {}) => ({ pr: pr.number, outcome, reason, head: pr.headRefOid, ...extra });
  const issue = issueOf(pr.body);
  const labels = (pr.labels ?? []).map((l) => l.name);
  if (pr.isCrossRepository !== false || pr.baseRefName !== 'testing' || !String(pr.headRefName).startsWith(BRANCH_PREFIX) || !issue) return out('skip', 'not-a-fix-pr');
  const waiting = labels.some((n) => WAITING_LABELS.includes(n));
  if (waiting && !ignoreLabels) return out('skip', 'a-person-is-already-looking');

  const issueView = JSON.parse(gh(['api', `repos/${repo}/issues/${requireNumber(issue, 'issue')}`]));
  const comments = jsonLines(gh(['api', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--jq', '.[] | {id, created_at, body, user: {login: .user.login}}']));
  const found = findApproval({ issueAuthor: issueView.user?.login, comments });
  if (!found.approval) return out('skip', found.reason);

  // The commits of the pull request, newest last. Only the newest MAX_COMMITS are asked about.
  const listed = jsonLines(gh(['api', `repos/${repo}/pulls/${pr.number}/commits`, '--paginate', '--jq', '.[] | {sha}']));
  const recent = listed.slice(-MAX_COMMITS);
  const commits = recent.map(({ sha }) => {
    const runs = jsonLines(gh(['api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate', '--jq', '.check_runs[] | {name, app: .app.slug, conclusion, completed_at}']));
    return { sha, builtAt: builtAt(runs) };
  });
  const from = approvedCommit(commits, found.approval.builtBefore);
  if (!from) return out('skip', 'no-built-commit-before-the-build-comment');
  if (from === pr.headRefOid) return out('skip', 'approval-is-for-the-head');

  const verdict = carryDecision({ git, from, head: pr.headRefOid, testing, isPipelineMerge: pipelineMergeCheck(repo, logins, gh) });
  if (!verdict.carry) return out('skip', verdict.reason, { from });

  // Done already for this head: the lock is set. The next run must not do it, or say it, again.
  const locked = gh(['api', `repos/${repo}/commits/${pr.headRefOid}/statuses`, '--jq', '[.[] | select(.context == "contributor-tested" and .state == "success")] | length']).trim();
  if (locked !== '0') return out('skip', 'already-carried-or-approved-for-this-head', { from });

  if (dry) {
    // What the hand-off would do, read only: the zones and the rules, and whether the checks are green.
    const view = JSON.parse(gh(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'mergeable,body,changedFiles']));
    const files = jsonLines(gh(['api', `repos/${repo}/pulls/${pr.number}/files`, '--paginate', '--jq', '.[] | {filename, previous_filename, status, additions, deletions}']));
    const runs = jsonLines(gh(['api', `repos/${repo}/commits/${pr.headRefOid}/check-runs`, '--paginate', '--jq', '.check_runs[] | {name, conclusion, completed_at}']));
    const d = decideHandOff({
      files, filesComplete: files.length === view.changedFiles, fixBranch: true,
      mergeable: view.mergeable, body: view.body, missing: notGreen(runs)
    });
    if (d.action === 'merge') return out('would-carry', 'same-fix', { from });
    return out('skip', d.action === 'not-green' ? `waiting-for-checks: ${d.missing.join(',')}` : `hand-off-says-${d.reason}`, { from });
  }

  const stillValid = () => {
    const again = jsonLines(gh(['api', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--jq', '.[] | {id, created_at, body, user: {login: .user.login}}']));
    const f = findApproval({ issueAuthor: issueView.user?.login, comments: again });
    return Boolean(f.approval) && f.approval.commentId === found.approval.commentId;
  };
  const result = handOff({
    issue, pr: pr.number, repo, reviewer: undefined, mergeToken, expectedSha: pr.headRefOid,
    carry: { from, stillValid, alreadyTold: found.approval.alreadyTold }
  }, gh);
  return result.merge ? out('carried', 'same-fix', { from }) : out('skip', `hand-off-${result.reason ?? 'pending'}`, { from });
}

/** Every open fix pull request. A failure on one is reported and does not stop the others. */
export function carryAll({ repo, git, testing, logins, mergeToken, dry = false, only = '', ignoreLabels = false }, gh = realGh) {
  if (!dry && !mergeToken) throw new Error('MERGE_TOKEN is not set. Refusing to carry an approval without the App token.');
  if (only) requireNumber(only, 'pull request number');
  const prs = JSON.parse(gh([
    'pr', 'list', '--repo', repo, '--base', 'testing', '--state', 'open', '--limit', '100',
    '--json', 'number,body,headRefName,headRefOid,isCrossRepository,baseRefName,labels'
  ])).filter((pr) => !only || String(pr.number) === String(only));
  return prs.map((pr) => {
    try {
      return carryOne({ pr, repo, git, testing, logins, mergeToken, dry, ignoreLabels }, gh);
    } catch (error) {
      return { pr: pr.number, outcome: 'skip', reason: `error: ${String(error.message ?? error).split('\n')[0].slice(0, 120)}`, head: pr.headRefOid };
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  // The workflow passes DRY and ONLY in the environment, so its `run` line is just this script.
  const dry = args.includes('--dry') || process.env.DRY === 'true';
  const only = args.includes('--pr') ? args[args.indexOf('--pr') + 1] : (process.env.ONLY ?? '');
  const results = carryAll({
    repo: process.env.GITHUB_REPOSITORY,
    git: makeGit(process.cwd()),
    testing: process.env.TESTING_REF || 'origin/testing',
    logins: (process.env.PIPELINE_BOT_LOGINS || AUTHOR).split(',').map((s) => s.trim()).filter(Boolean),
    mergeToken: process.env.MERGE_TOKEN,
    dry, only, ignoreLabels: dry
  });
  const line = (r) => `#${r.pr} ${r.outcome}: ${r.reason}${r.from ? ` (approved ${r.from.slice(0, 8)}, head ${r.head.slice(0, 8)})` : ''}`;
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) console.log(line(r));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${results.map((r) => `- ${line(r)}`).join('\n')}\n`);
}
