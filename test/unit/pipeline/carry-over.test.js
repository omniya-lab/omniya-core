import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { carryAll, carryDecision, findApproval, historyOutsideAutomatic, makeGit, netChange, ownWords, sameChange } from '../../../scripts/ci/carry-over.mjs';
import { replyState } from '../../../scripts/ci/confirm.mjs';
import { renderReply } from '../../../scripts/ci/reply.mjs';

// A real repository in a scratch folder. `testing` is the base branch; `fix` is the fix branch.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'carry-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim();
  git('init', '-q', '-b', 'testing');
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message, files = {}) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const lines = (n, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}`).join('\n') + '\n';
  commit('base', { 'src/a.js': lines(20), 'src/other.js': 'other\n', 'test/a.test.js': 'test\n' });
  const show = (ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: dir, encoding: 'utf8' });
  return { dir, git, commit, write, lines, show, run: makeGit(dir) };
}

// The fix on a branch, then `testing` moves on and is merged in.
function scenario({ testingEdit = (r) => r.commit('testing moves', { 'src/other.js': 'other changed\n' }) } = {}) {
  const r = repo();
  r.git('checkout', '-q', '-b', 'fix');
  const base = r.lines(20).split('\n');
  base.splice(10, 0, 'FIX ADDED');
  const A = r.commit('the fix', { 'src/a.js': base.join('\n'), 'test/a.test.js': 'test\nmore\n' });
  r.git('checkout', '-q', 'testing');
  testingEdit(r);
  r.git('checkout', '-q', 'fix');
  r.git('merge', '-q', '--no-ff', '-m', 'Merge branch testing into fix', 'testing');
  const M = r.git('rev-parse', 'HEAD');
  return { ...r, A, M };
}

const decide = (s, extra = {}) => carryDecision({ git: s.run, from: s.A, head: s.git('rev-parse', 'HEAD'), testing: 'testing', isPipelineMerge: (sha) => sha === s.M, ...extra });

test('testing merged in by the pipeline: the approval carries', () => {
  const s = scenario();
  assert.deepEqual(decide(s), { carry: true, reason: 'same-fix' });
});

test('the lines around the fix moved, because testing added lines above it: still the same fix', () => {
  const s = scenario({ testingEdit: (r) => r.commit('testing adds lines at the top of the same file', { 'src/a.js': 'new first line\nanother\n' + r.lines(20) }) });
  assert.deepEqual(decide(s), { carry: true, reason: 'same-fix' });
});

test('a head that is the approved commit is not a carry', () => {
  const s = scenario();
  assert.equal(carryDecision({ git: s.run, from: s.A, head: s.A, testing: 'testing', isPipelineMerge: () => true }).reason, 'same-commit');
});

test('rule 1: a force-pushed branch, where the approved commit is not an ancestor, does not carry', () => {
  const s = scenario();
  // The branch is rebuilt from testing with the same change: a different commit, not a descendant of A.
  s.git('checkout', '-q', '-b', 'rebuilt', 'testing');
  const same = s.git('show', `${s.A}:src/a.js`);
  const H = s.commit('the same fix again', { 'src/a.js': same, 'test/a.test.js': 'test\nmore\n' });
  assert.equal(carryDecision({ git: s.run, from: s.A, head: H, testing: 'testing', isPipelineMerge: () => true }).reason, 'not-ancestor');
});

test('rule 1: a commit that is not in the clone does not carry', () => {
  const s = scenario();
  assert.equal(carryDecision({ git: s.run, from: 'a'.repeat(40), head: s.M, testing: 'testing', isPipelineMerge: () => true }).reason, 'commit-missing');
});

test('rule 2: a repair commit that changes one added line does not carry', () => {
  const s = scenario();
  const changed = s.show('HEAD', 'src/a.js').replace('FIX ADDED', 'FIX ADDED DIFFERENTLY');
  s.commit('repair', { 'src/a.js': changed });
  const verdict = decide(s);
  assert.equal(verdict.carry, false);
  assert.match(verdict.reason, /^fix-changed: src\/a\.js$/);
});

test('rule 2: a commit that does something and then undoes it in the next commit is still refused', () => {
  const s = scenario();
  const before = s.show('HEAD', 'src/a.js');
  s.commit('oops', { 'src/a.js': before + 'extra\n' });
  s.commit('undo', { 'src/a.js': before });
  const verdict = decide(s);
  assert.equal(verdict.carry, false);
  assert.match(verdict.reason, /^commit-changes-fix: /);
});

test('rule 2: a merge made by a person, that changes the fix file, does not carry', () => {
  const s = scenario({ testingEdit: (r) => r.commit('testing moves the file', { 'src/a.js': 'top\n' + r.lines(20) }) });
  // The same history as the first test, but nobody vouches for the merge as the pipeline's.
  const verdict = decide(s, { isPipelineMerge: () => false });
  assert.equal(verdict.carry, false);
  assert.match(verdict.reason, /^commit-changes-fix: /);
});

test('rule 2: a non-pipeline commit with no effect on the fix files is allowed, because it changes nothing the contributor tried', () => {
  const s = scenario();
  s.commit('empty commit by a person');
  assert.equal(decide(s).carry, true);
});

test('rule 2: a person who adds a file after the approval does not carry (the file list differs)', () => {
  const s = scenario();
  s.commit('a person adds a file', { 'src/extra.js': 'new\n' });
  const verdict = decide(s);
  assert.equal(verdict.carry, false);
  assert.match(verdict.reason, /^fix-changed: src\/extra\.js$/);
});

test('rule 3: a renamed file does not carry, either way round', () => {
  const s = scenario();
  s.git('mv', 'src/a.js', 'src/b.js');
  s.git('commit', '-q', '-m', 'a person moves the file');
  const verdict = decide(s);
  assert.equal(verdict.carry, false);
  assert.match(verdict.reason, /^(commit-changes-fix|fix-changed)/);
  // And with a rename that is already in A and not in H.
  const t = scenario();
  assert.equal(carryDecision({ git: t.run, from: s.git('rev-parse', 'HEAD'), head: t.git('rev-parse', 'HEAD'), testing: 'testing', isPipelineMerge: () => true }).carry, false);
});

test('rule 3: a file the fix removes is part of the comparison', () => {
  const s = scenario();
  s.git('rm', '-q', 'src/other.js');
  s.git('commit', '-q', '-m', 'a person deletes a file');
  assert.equal(decide(s).carry, false);
});

test('rule 3: a changed line count in the fix does not carry even if the lines are the same text', () => {
  const s = scenario();
  const now = s.show('HEAD', 'src/a.js');
  s.commit('adds the same line twice', { 'src/a.js': now.replace('FIX ADDED\n', 'FIX ADDED\nFIX ADDED\n') });
  assert.equal(decide(s).carry, false);
});

test('rule 3: a binary file is compared by its content', () => {
  const s = repo();
  s.git('checkout', '-q', '-b', 'fix');
  writeFileSync(join(s.dir, 'src/pic.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  const A = s.commit('fix with a binary');
  s.git('checkout', '-q', 'testing');
  s.commit('testing moves', { 'src/other.js': 'x\n' });
  s.git('checkout', '-q', 'fix');
  s.git('merge', '-q', '--no-ff', '-m', 'merge', 'testing');
  const M = s.git('rev-parse', 'HEAD');
  assert.equal(carryDecision({ git: s.run, from: A, head: M, testing: 'testing', isPipelineMerge: (x) => x === M }).carry, true);
  writeFileSync(join(s.dir, 'src/pic.bin'), Buffer.from([0, 1, 2, 3, 0, 254]));
  s.git('add', '-A');
  s.git('commit', '-q', '-m', 'changed binary');
  const H = s.git('rev-parse', 'HEAD');
  assert.equal(carryDecision({ git: s.run, from: A, head: H, testing: 'testing', isPipelineMerge: (x) => x === M }).carry, false);
});

test('a symlink in the fix is not compared, so it does not carry', () => {
  const s = repo();
  s.git('checkout', '-q', '-b', 'fix');
  symlinkSync('other.js', join(s.dir, 'src/link.js'));
  const A = s.commit('fix with a link');
  s.git('checkout', '-q', 'testing');
  s.commit('testing moves', { 'src/other.js': 'x\n' });
  s.git('checkout', '-q', 'fix');
  s.git('merge', '-q', '--no-ff', '-m', 'merge', 'testing');
  const M = s.git('rev-parse', 'HEAD');
  const verdict = carryDecision({ git: s.run, from: A, head: M, testing: 'testing', isPipelineMerge: () => true });
  assert.equal(verdict.carry, false);
  assert.match(verdict.reason, /^cannot-compare/);
});

test('netChange drops hunk headers and sorts the lines', () => {
  const s = scenario();
  const change = netChange(s.run, s.M, 'testing');
  assert.deepEqual([...change.keys()].sort(), ['src/a.js', 'test/a.test.js']);
  assert.deepEqual(change.get('src/a.js').lines, ['+FIX ADDED']);
  assert.equal(sameChange(change, change).same, true);
});

// findApproval(): the hand-off's record, the person behind it, and whether the conversation moved on.
const bot = (id, state, at = '2026-10-10T10:00:00Z') => ({ id, created_at: at, body: renderReply(state, { repo: 'o/r', pr: 5, message: 'Some words.' }), user: { login: 'github-actions[bot]' } });
const person = (id, body, login = 'blind-user', at = id <= 2 ? '2026-10-10T11:00:00Z' : `2026-10-10T12:${String(id).padStart(2, '0')}:00Z`) => ({ id, created_at: at, body, user: { login } });
const SHA_A = 'a'.repeat(40);
const record = (id, sha = SHA_A, at = '2026-10-10T11:02:00Z', login = 'github-actions[bot]') => ({ id, created_at: at, body: `The contributor installed the build and says it works.\n\nCommit tested: ${sha}\n\nunit, nemeth, e2e are green on that commit. Auto-merge is on for that commit only.`, user: { login } });
const issueThread = [bot(1, 'ready'), person(2, 'it works')];

test('approval: the hand-off record, with the author having written just before it', () => {
  const a = findApproval({ issueAuthor: 'blind-user', comments: issueThread, prComments: [record(10)] });
  assert.equal(a.approval.from, SHA_A);
  assert.equal(a.approval.commentId, 2);
  assert.equal(a.approval.alreadyTold, false);
});

test('approval: no record, no approval; a record written by a person is not a record', () => {
  assert.equal(findApproval({ issueAuthor: 'blind-user', comments: issueThread, prComments: [] }).reason, 'no-record');
  assert.equal(findApproval({ issueAuthor: 'blind-user', comments: issueThread, prComments: [record(10, SHA_A, undefined, 'blind-user')] }).reason, 'no-record');
});

test('approval: a record with nobody behind it (the author wrote nothing before it) is not an approval', () => {
  assert.equal(findApproval({ issueAuthor: 'blind-user', comments: [bot(1, 'ready')], prComments: [record(10)] }).reason, 'no-comment-by-the-author-before-the-record');
  assert.equal(findApproval({ issueAuthor: 'blind-user', comments: [bot(1, 'ready'), person(2, 'it works', 'stranger')], prComments: [record(10)] }).reason, 'no-comment-by-the-author-before-the-record');
});

test('approval: the record has to be about that comment, not written days later', () => {
  const late = record(10, SHA_A, '2026-10-13T11:02:00Z');
  assert.equal(findApproval({ issueAuthor: 'blind-user', comments: issueThread, prComments: [late] }).reason, 'the-record-is-not-about-that-comment');
});

test('approval: it is void if anyone wrote after it, the author included', () => {
  const r = findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, person(3, '@claude wait, now it crashes')], prComments: [record(10)] });
  assert.equal(r.reason, 'someone-wrote-after-approval');
  assert.equal(findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, person(3, 'thanks', 'maintainer')], prComments: [record(10)] }).approval, null);
});

test('approval: the author saying it works again does not void it, even with the mail quote glued on', () => {
  const again = person(3, '@claude it works.On Oct 12, 2026, at 8:45 PM, github-actions[bot] ***@***.***> wrote:\r\n\r\nA new test build is ready.');
  assert.equal(ownWords(again.body), '@claude it works.');
  assert.ok(findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, again], prComments: [record(10)] }).approval);
});

test('approval: it is void if the pipeline said anything but its hand-off, wait and notice words after it', () => {
  for (const state of ['behind', 'asked', 'answered', 'stuck', 'design', 'started', 'ready', 'routed']) {
    const r = findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, bot(3, state)], prComments: [record(10)] });
    assert.equal(r.approval, null, state);
  }
  for (const state of ['sent', 'sent-owner', 'sent-automation', 'maintainer', 'failed', 'revised', 'carried']) {
    const r = findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, bot(3, state)], prComments: [record(10)] });
    assert.ok(r.approval, state);
  }
  // An unmarked bot comment is not a state either.
  const plain = { id: 3, created_at: 'x', body: 'Thank you for testing. I could not send this fix on yet', user: { login: 'github-actions[bot]' } };
  assert.equal(findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, plain], prComments: [record(10)] }).approval, null);
});

test('approval: the wording from before the hidden state line existed is allowed, word for word', () => {
  const legacySent = { id: 3, created_at: 'x', body: '<!-- omniya-pipeline-reply -->\nThank you. I sent this fix to the maintainer to review and merge.\nThis issue closes when the maintainer merges the fix.\nYou do not need to do anything.\n', user: { login: 'github-actions[bot]' } };
  const legacyMaintainer = { id: 4, created_at: 'x', body: '<!-- omniya-pipeline-reply -->\nThe maintainer needs to look at a technical problem with this fix.\nYou do not need to do anything.\nThe maintainer will write here when there is news.\n', user: { login: 'github-actions[bot]' } };
  assert.ok(findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, legacySent, legacyMaintainer], prComments: [record(10)] }).approval);
  const changed = { ...legacySent, body: legacySent.body.replace('Thank you.', 'Thank you very much.') };
  assert.equal(findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, changed], prComments: [record(10)] }).approval, null);
});

test('approval: a person who writes the bot marker is not the bot', () => {
  const forgedSent = { ...bot(3, 'sent'), user: { login: 'someone' } };
  assert.equal(findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, forgedSent], prComments: [record(10)] }).reason, 'someone-wrote-after-approval');
});

test('approval: the newest record names the commit; a carried record counts, an older one does not', () => {
  const carried = { id: 12, created_at: '2026-10-11T09:00:00Z', body: `The contributor tested an earlier commit of this fix and said it works. The fix itself has not changed.\n\nApproval carried from: ${SHA_A}\n\nCommit tested: ${'b'.repeat(40)}\n\nunit, nemeth, e2e are green on that commit.`, user: { login: 'github-actions[bot]' } };
  const a = findApproval({ issueAuthor: 'blind-user', comments: [...issueThread, bot(3, 'carried')], prComments: [record(10), carried] });
  assert.equal(a.approval.from, 'b'.repeat(40));
  assert.equal(a.approval.alreadyTold, true);
});

test('ownWords cuts the quoted mail and nothing else', () => {
  assert.equal(ownWords('it works'), 'it works');
  assert.equal(ownWords('@claude it works.On Oct 12, 2026, at 8:45 PM, github-actions[bot] ***@***.***> wrote:\r\n\r\nxyz'), '@claude it works.');
  assert.equal(ownWords('It works\n> quoted'), 'It works');
});

test('the carried reply says it once, in plain words, with no links and no instruction to test again', () => {
  const text = renderReply('carried', { repo: 'o/r' });
  assert.equal(replyState(text), 'carried');
  assert.match(text, /You do not need to test again/);
  assert.doesNotMatch(text, /https?:|@claude/);
  assert.doesNotMatch(text, /Download/);
});

// The whole path, with a fake GitHub and a real clone.
function fakeGitHub(s, { statuses = '0', checks = 'green', issueComments, prComments = [record(30, s.A)], author = 'blind-user', labels = [], bot = 'omniya-app[bot]', headSha } = {}) {
  const calls = [];
  const head = headSha ?? s.git('rev-parse', 'HEAD');
  const builtAt = { [s.A]: '2026-10-10T09:00:00Z' };
  const gh = (args, opts) => {
    calls.push({ args, token: opts?.token });
    const [a, b] = args;
    const path = a === 'api' ? args.find((x) => x.startsWith('repos/')) : '';
    if (a === 'pr' && b === 'list') return JSON.stringify([{ number: 5, body: 'Fix.\n\nFixes #9', headRefName: 'claude/fix-9-x', headRefOid: head, isCrossRepository: false, baseRefName: 'testing', labels: labels.map((name) => ({ name })) }]);
    if (a === 'pr' && b === 'view') return JSON.stringify({ headRefOid: head, mergeable: 'MERGEABLE', body: 'Fix.\n\nFixes #9', changedFiles: 2, isCrossRepository: false, baseRefName: 'testing', headRefName: 'claude/fix-9-x', state: 'OPEN' });
    if (path === 'repos/o/r/issues/9') return JSON.stringify({ user: { login: author } });
    if (path === 'repos/o/r/issues/9/comments' && !args.includes('-f')) return issueComments.map((c) => JSON.stringify(c)).join('\n');
    if (path === 'repos/o/r/issues/5/comments') return prComments.map((c) => JSON.stringify(c)).join('\n');
    if (path === 'repos/o/r/pulls/5/commits') return [[s.A, '2026-10-10T08:00:00Z'], [head, '2026-10-11T08:00:00Z']].map(([sha, date]) => JSON.stringify({ sha, date })).join('\n');
    if (path === `repos/o/r/commits/${head}/statuses`) return `${statuses}\n`;
    if (path?.endsWith('/check-runs')) {
      const sha = path.split('/')[4];
      if (sha === s.A) return JSON.stringify({ name: 'pack-mac', app: 'github-actions', conclusion: 'success', completed_at: builtAt[s.A] });
      const ok = checks === 'green' ? 'success' : 'failure';
      return ['unit', 'nemeth', 'e2e', 'pack-mac'].map((name) => JSON.stringify({ name, app: 'github-actions', conclusion: ok, completed_at: '2026-10-11T10:00:00Z' })).join('\n');
    }
    if (path === 'repos/o/r/pulls/5/files') return ['src/a.js', 'test/a.test.js'].map((filename) => JSON.stringify({ filename, status: 'modified', additions: 2, deletions: 0 })).join('\n');
    if (path === `repos/o/r/commits/${s.M}`) return JSON.stringify({ author: { login: bot, type: 'Bot' } });
    if (path?.startsWith('repos/o/r/commits/')) return JSON.stringify({ author: { login: 'person', type: 'User' } });
    return '';
  };
  return { gh, calls };
}
const writes = (calls) => calls.filter((c) => c.args[0] === 'pr' && ['ready', 'merge', 'comment'].includes(c.args[1]) || (c.args[0] === 'api' && c.args.includes('-f')));
const thread = issueThread;
const carryArgs = (s) => ({ repo: 'o/r', git: s.run, testing: 'testing', logins: ['omniya-app[bot]'], mergeToken: 'app-token' });

test('whole path: the head moved, the fix did not: the lock is set on the new head, pinned, and the contributor is told once', () => {
  const s = scenario();
  const { gh, calls } = fakeGitHub(s, { issueComments: thread });
  const [result] = carryAll(carryArgs(s), gh);
  assert.equal(result.outcome, 'carried', JSON.stringify(result));
  const head = s.git('rev-parse', 'HEAD');
  const merge = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.deepEqual(merge.args.slice(-4), ['--auto', '--squash', '--match-head-commit', head]);
  assert.equal(merge.token, 'app-token');
  const status = calls.find((c) => c.args.includes(`repos/o/r/statuses/${head}`));
  assert.ok(status.args.includes('context=contributor-tested'));
  const replies = calls.filter((c) => c.args[0] === 'api' && c.args.some((x) => String(x).startsWith('body=')) && c.args.includes('repos/o/r/issues/9/comments'));
  assert.equal(replies.length, 1);
  assert.equal(replyState(replies[0].args.find((x) => x.startsWith('body=')).slice(5)), 'carried');
  const prComment = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'comment').args.at(-1);
  assert.match(prComment, new RegExp(`Approval carried from: ${s.A}`));
  assert.match(prComment, new RegExp(`Commit tested: ${head}`));
});

test('whole path: a carried notice already on the issue is not said again, but the merge is still set', () => {
  const s = scenario();
  const { gh, calls } = fakeGitHub(s, { issueComments: [...thread, bot(3, 'carried')] });
  assert.equal(carryAll(carryArgs(s), gh)[0].outcome, 'carried');
  assert.equal(calls.filter((c) => c.args.includes('repos/o/r/issues/9/comments') && c.args.includes('-f')).length, 0);
});

test('whole path: the checks are not green yet: nothing is written and nothing is said', () => {
  const s = scenario();
  const { gh, calls } = fakeGitHub(s, { issueComments: thread, checks: 'red' });
  const [result] = carryAll(carryArgs(s), gh);
  assert.equal(result.outcome, 'skip');
  assert.deepEqual(writes(calls), []);
});

test('whole path: the lock is already set on this head: it is not done twice', () => {
  const s = scenario();
  const { gh, calls } = fakeGitHub(s, { issueComments: thread, statuses: '1' });
  assert.equal(carryAll(carryArgs(s), gh)[0].reason, 'already-carried-or-approved-for-this-head');
  assert.deepEqual(writes(calls), []);
});

test('whole path: the fix changed after the approval: nothing is written (the revised notice path is unchanged)', () => {
  const s = scenario();
  const changed = s.show('HEAD', 'src/a.js').replace('FIX ADDED', 'FIX CHANGED');
  s.commit('repair', { 'src/a.js': changed });
  const { gh, calls } = fakeGitHub(s, { issueComments: thread });
  const [result] = carryAll(carryArgs(s), gh);
  assert.equal(result.outcome, 'skip');
  assert.match(result.reason, /^fix-changed/);
  assert.deepEqual(writes(calls), []);
});

test('whole path: the merge was not made by the pipeline: no carry when it touched the fix file', () => {
  const s = scenario({ testingEdit: (r) => r.commit('testing', { 'src/a.js': 'top\n' + r.lines(20) }) });
  const { gh, calls } = fakeGitHub(s, { issueComments: thread, bot: 'a-person' });
  assert.equal(carryAll(carryArgs(s), gh)[0].outcome, 'skip');
  assert.deepEqual(writes(calls), []);
});

test('whole path: the contributor wrote again before the lock: nothing is set', () => {
  const s = scenario();
  let reads = 0;
  const { gh: inner, calls } = fakeGitHub(s, { issueComments: thread });
  const gh = (args, opts) => {
    if (args.includes('repos/o/r/issues/9/comments') && !args.includes('-f')) {
      reads += 1;
      if (reads >= 2) return [...thread, person(9, '@claude wait')].map((c) => JSON.stringify(c)).join('\n');
    }
    return inner(args, opts);
  };
  const [result] = carryAll(carryArgs(s), gh);
  assert.equal(result.outcome, 'skip');
  assert.equal(calls.some((c) => c.args[1] === 'merge'), false);
  assert.equal(calls.some((c) => c.args.some((x) => String(x).includes('/statuses/'))), false);
});

test('whole path: a pull request a person is already looking at is left alone', () => {
  const s = scenario();
  const { gh } = fakeGitHub(s, { issueComments: thread, labels: ['needs-owner'] });
  assert.equal(carryAll(carryArgs(s), gh)[0].reason, 'a-person-is-already-looking');
});

test('whole path: dry run writes nothing and says what it would do', () => {
  const s = scenario();
  const { gh, calls } = fakeGitHub(s, { issueComments: thread });
  const [result] = carryAll({ ...carryArgs(s), dry: true, mergeToken: '' }, gh);
  assert.equal(result.outcome, 'would-carry', JSON.stringify(result));
  assert.deepEqual(writes(calls), []);
});

test('without the App token nothing is carried', () => {
  const s = scenario();
  assert.throws(() => carryAll({ ...carryArgs(s), mergeToken: '' }, () => ''), /MERGE_TOKEN/);
});

test('whole path: the record names a commit that is not an ancestor of the head: nothing is written', () => {
  const s = scenario();
  const { gh, calls } = fakeGitHub(s, { issueComments: thread, prComments: [record(30, 'c'.repeat(40))] });
  const [result] = carryAll(carryArgs(s), gh);
  assert.equal(result.reason, 'commit-missing');
  assert.deepEqual(writes(calls), []);
});

test('whole path: a branch that once held a workflow, removed again, does not carry', () => {
  const s = repo();
  s.git('checkout', '-q', '-b', 'fix');
  s.commit('a workflow, only for a moment', { '.github/workflows/x.yml': 'name: x\n' });
  s.git('rm', '-q', '.github/workflows/x.yml');
  s.git('commit', '-q', '-m', 'and gone again');
  s.commit('the fix', { 'src/a.js': s.lines(21) });
  const A = s.git('rev-parse', 'HEAD');
  s.git('checkout', '-q', 'testing');
  s.commit('testing moves', { 'src/other.js': 'x\n' });
  s.git('checkout', '-q', 'fix');
  s.git('merge', '-q', '--no-ff', '-m', 'merge', 'testing');
  const M = s.git('rev-parse', 'HEAD');
  // The net change is the same fix, and the pipeline made the merge. Only the history gives it away.
  const verdict = carryDecision({ git: s.run, from: A, head: M, testing: 'testing', isPipelineMerge: () => true });
  assert.equal(verdict.carry, false);
  assert.match(verdict.reason, /^history-outside-the-automatic-zone: \.github\/workflows\/x\.yml$/);
});

test('history: what testing brought in through a merge is not the branch\'s own, but a path the merge itself changed is', () => {
  const s = scenario({ testingEdit: (r) => r.commit('testing changes a script', { 'scripts/ci/x.mjs': 'x\n' }) });
  assert.equal(historyOutsideAutomatic(s.run, s.M, 'testing'), '');
  // An evil merge: the merge commit itself adds a file that is on neither side.
  s.write('scripts/ci/evil.mjs', 'evil\n');
  s.git('add', '-A');
  s.git('commit', '-q', '--amend', '--no-edit');
  assert.equal(historyOutsideAutomatic(s.run, s.git('rev-parse', 'HEAD'), 'testing'), 'scripts/ci/evil.mjs');
});

test('history: a fix commit that touches the corpus, a script or a workflow is outside the automatic zone', () => {
  for (const file of ['test/corpus/x.json', 'scripts/ci/x.mjs', '.github/workflows/x.yml', 'package.json']) {
    const s = repo();
    s.git('checkout', '-q', '-b', 'fix');
    s.commit('fix', { [file]: 'x\n' });
    assert.equal(historyOutsideAutomatic(s.run, 'fix', 'testing'), file, file);
  }
});
