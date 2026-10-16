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
 *     merge of `testing` into the branch, authored by the pipeline (a bot: github-actions, which the
 *     repair agent commits as, or the pipeline's App, which `keep-current` merges as), OR it changes
 *     none of the fix's own files.
 *  3. The fix's net change is the same. For A and for H, take the change from the merge base with
 *     `testing` to the commit: per file, the sorted lines it adds and removes (`git diff -U0`,
 *     hunk headers dropped). The file lists must be the same and so must every line list. A
 *     patch id is not used: the context lines move when `testing` moves, and the id with them.
 *  4. Every file is in the zone the hand-off allows. That is the hand-off's own `decide`.
 *  5. The other hand-off rules are unchanged, because the hand-off runs: conflict, test removed,
 *     test weakened, standing note, draft, green checks, the author-only approval.
 *
 *  6. Nothing on the branch, at ANY commit since it left `testing`, touched a file outside the
 *     AUTOMATIC zone. A commit that adds a workflow, runs once and is removed again leaves no mark in
 *     the net change, so the history is read too. (A merge counts only for the files it changed
 *     against BOTH parents, so what `testing` brought in is not the branch's.)
 *
 * Where the approval comes from. The hand-off records it on the pull request: "Commit tested: A", by
 * `github-actions`. That author is not proof: any workflow on a branch can post as `github-actions`. So a
 * record counts only with a person behind it: the issue's AUTHOR wrote a comment up to two hours before it
 * (the mail reply of a contributor carries the notification quoted below their words, which is why their
 * words are not parsed here: the hand-off already decided what they meant). And it stands only if, since
 * that comment, nobody else has written on the issue and the pipeline has said nothing but its own
 * hand-off, hand-off-wait and notice words: a question, a refusal or a conflict notice means the
 * conversation went on, and the contributor was promised a new build to try.
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

import { isConfirmPhrase, replyState } from './confirm.mjs';
import { BRANCH_PREFIX } from './find-fix-pr.mjs';
import { gh as realGh, requireNumber } from './gh.mjs';
import { decide as decideHandOff, handOff, notGreen } from './hand-off.mjs';
import { issueOf, WAITING_LABELS } from './keep-current.mjs';
import { AUTHOR, isReplyOfState, MARKER } from './reply.mjs';
import { loadCodeRules } from './standing-note.mjs';
import { zoneOf } from './zones.mjs';

const SHA = /^[0-9a-f]{40}$/;

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
  // 6. The whole history of the branch stays in the automatic zone.
  const outside = historyOutsideAutomatic(git, head, testing);
  if (outside) return { carry: false, reason: `history-outside-the-automatic-zone: ${outside}` };
  return { carry: true, reason: 'same-fix' };
}

/** @returns {string} the first file (or commit) in the branch's history that is outside the automatic zone, or '' */
export function historyOutsideAutomatic(git, head, testing) {
  const names = (a, b) => git(['diff-tree', '-r', '--name-only', '--no-renames', '-z', a, b]).split('\0').filter(Boolean);
  for (const sha of git(['rev-list', head, `^${testing}`]).split('\n').filter(Boolean)) {
    const parents = git(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1);
    if (parents.length === 0 || parents.length > 2) return `odd commit ${sha}`;
    let touched = names(parents[0], sha);
    if (parents.length === 2) {
      const other = new Set(names(parents[1], sha));
      touched = touched.filter((name) => other.has(name));
    }
    const bad = touched.find((name) => zoneOf(name).zone !== 'automatic');
    if (bad) return bad;
  }
  return '';
}

const isBot = (c) => c.user?.login === AUTHOR;

/**
 * Cut the quoted mail off a comment. A contributor who answers by e-mail sends their own words with the
 * whole notification glued on after them ("it works.On Oct 12, 2026, at 8:45 PM, github-actions[bot] ... wrote:").
 */
export function ownWords(body) {
  const text = String(body ?? '').replace(/\r/g, '');
  const cut = text.search(/On [A-Z][a-z]{2}[a-z]*,? [A-Za-z0-9, ]{4,40}(?:at [0-9:]+ ?[AP]M)?,?[^\n]{0,120}wrote:|\n>|-----Original Message|\nFrom: /);
  return (cut < 0 ? text : text.slice(0, cut)).trim();
}

/**
 * The words of the hand-off's own record on the pull request: "Commit tested: <sha>". The hand-off writes
 * it with the built-in token, so the author is `github-actions`. Two forms: the contributor said it works,
 * and an approval carried to a newer head (this script, below).
 */
export const HAND_OFF_RECORD = /^The contributor installed the build and says it works\.\s*\n\s*\nCommit tested: ([0-9a-f]{40})\b/;
export const CARRIED_RECORD = /^The contributor tested an earlier commit of this fix and said it works\.[\s\S]*?\n\s*\nCommit tested: ([0-9a-f]{40})\b/;

/** The longest the hand-off took to write its record after the contributor's comment. */
export const RECORD_WITHIN_MS = 2 * 60 * 60 * 1000;

/**
 * What the pipeline may say on the issue after the approval, without the conversation having gone on. Besides
 * the states, the wording from before the hidden state line existed (exact text, as `isReplyOfState` does).
 */
export const SAYS_AFTER_APPROVAL = ['sent', 'sent-owner', 'sent-automation', 'maintainer', 'failed', 'revised', 'carried'];
export const LEGACY_SENT = `${MARKER}\nThank you. I sent this fix to the maintainer to review and merge.\nThis issue closes when the maintainer merges the fix.\nYou do not need to do anything.`;
const mayFollowApproval = (c) => {
  const state = replyState(c.body);
  if (state) return SAYS_AFTER_APPROVAL.includes(state);
  const text = String(c.body ?? '').trim();
  return text === LEGACY_SENT || isReplyOfState(text, 'maintainer') || isReplyOfState(text, 'failed');
};

/**
 * Pure: is there an approval on record, and does it still stand?
 *
 * The record is the hand-off's comment on the pull request (`Commit tested: A`, by `github-actions`). It is
 * trusted only with a person behind it: the issue's AUTHOR wrote a comment shortly before it, and since that
 * comment nobody else has written, and the pipeline has said nothing but its own hand-off and notice words
 * (a question, a refusal or a conflict notice means the conversation went on). The author may say "it works"
 * again. Their words are not read: the hand-off decided what they meant, and this script only asks whether the
 * conversation moved on.
 *
 * @param {{issueAuthor: string, comments: Array<{id:number, created_at:string, body:string, user:{login:string}}>,
 *   prComments: Array<{id:number, created_at:string, body:string, user:{login:string}}>}} input
 * @returns {{approval: null|{from: string, commentId: number, alreadyTold: boolean}, reason: string}}
 */
export function findApproval({ issueAuthor, comments, prComments }) {
  const byBot = (list, re) => [...(list ?? [])].filter((c) => isBot(c) && re.test(String(c.body ?? ''))).sort((a, b) => a.id - b.id);
  const handOff = byBot(prComments, HAND_OFF_RECORD).at(-1);
  if (!handOff) return { approval: null, reason: 'no-record' };
  const newest = [...byBot(prComments, HAND_OFF_RECORD), ...byBot(prComments, CARRIED_RECORD)].sort((a, b) => a.id - b.id).at(-1);
  const from = (HAND_OFF_RECORD.exec(newest.body) ?? CARRIED_RECORD.exec(newest.body))[1];

  const all = [...(comments ?? [])].sort((a, b) => a.id - b.id);
  const said = all.filter((c) => c.user?.login === issueAuthor && !isBot(c) && Date.parse(c.created_at) <= Date.parse(handOff.created_at)).at(-1);
  if (!issueAuthor || !said) return { approval: null, reason: 'no-comment-by-the-author-before-the-record' };
  if (Date.parse(handOff.created_at) - Date.parse(said.created_at) > RECORD_WITHIN_MS) return { approval: null, reason: 'the-record-is-not-about-that-comment' };
  for (const c of all.filter((x) => x.id > said.id)) {
    if (isBot(c)) {
      if (!mayFollowApproval(c)) return { approval: null, reason: `pipeline-said-${replyState(c.body) || 'something-else'}-after-approval` };
    } else if (!(c.user?.login === issueAuthor && isConfirmPhrase(ownWords(c.body)))) {
      return { approval: null, reason: 'someone-wrote-after-approval' };
    }
  }
  const alreadyTold = all.some((c) => c.id > said.id && isBot(c) && replyState(c.body) === 'carried');
  return { approval: { from, commentId: said.id, alreadyTold }, reason: 'ok' };
}

const jsonLines = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * Real `isPipelineMerge`: GitHub says the author of the commit is a bot of the pipeline (`logins`: github-actions
 * and the App). That is what the repair agent's merge and `keep-current`'s merge look like. It is not proof: an
 * author is whatever the pusher wrote. It does not have to be. The commit is only waved past rule 2; rules 3 and 6
 * still read what the branch changes and every file it ever touched.
 */
export function pipelineMergeCheck(repo, logins, gh = realGh) {
  return (sha) => {
    const c = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}`]));
    return c.author?.type === 'Bot' && logins.includes(c.author?.login);
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

  const prComments = jsonLines(gh(['api', `repos/${repo}/issues/${pr.number}/comments`, '--paginate', '--jq', '.[] | {id, created_at, body, user: {login: .user.login}}']));
  // Cheap first: no record, no work.
  if (findApproval({ issueAuthor: 'x', comments: [], prComments }).reason === 'no-record') return out('skip', 'no-record');
  const issueView = JSON.parse(gh(['api', `repos/${repo}/issues/${requireNumber(issue, 'issue')}`]));
  const comments = jsonLines(gh(['api', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--jq', '.[] | {id, created_at, body, user: {login: .user.login}}']));
  const found = findApproval({ issueAuthor: issueView.user?.login, comments, prComments });
  if (!found.approval) return out('skip', found.reason);
  const from = found.approval.from;
  if (from === pr.headRefOid) return out('skip', 'the-record-is-for-the-head');

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
      mergeable: view.mergeable, body: view.body, missing: notGreen(runs), codeRules: loadCodeRules()
    });
    if (d.action === 'merge') return out('would-carry', 'same-fix', { from });
    return out('skip', d.action === 'not-green' ? `waiting-for-checks: ${d.missing.join(',')}` : `hand-off-says-${d.reason}`, { from });
  }

  const stillValid = () => {
    const again = jsonLines(gh(['api', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--jq', '.[] | {id, created_at, body, user: {login: .user.login}}']));
    const f = findApproval({ issueAuthor: issueView.user?.login, comments: again, prComments });
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
