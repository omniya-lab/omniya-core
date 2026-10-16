import assert from 'node:assert/strict';
import test from 'node:test';

import { pickRun, tail, verifyBranch } from '../../../scripts/ci/verify-branch.mjs';

const REPO = 'a/b';
const BRANCH = 'claude/fix-22-x';
const SHA = 'abc123';

// A fake `gh` that remembers what it was asked and answers like GitHub would.
function fakeGh({ conclusions = {}, startDelayPolls = 0, shaOf = SHA, mergeable = ['MERGEABLE'] } = {}) {
  const calls = [];
  let clock = 1_000_000;
  const polls = {};
  const runs = { 'pr-checks.yml': 501, 'pr-build.yml': 502 };
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api') return `${shaOf}\n`;
    if (args[0] === 'pr' && args[1] === 'view') {
      assert.ok(args.includes('mergeable') && args.includes('26'), 'asks the pull request whether it is mergeable');
      // Answers in order, then repeats the last answer.
      return `${mergeable.length > 1 ? mergeable.shift() : mergeable[0]}\n`;
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const workflow = args[args.indexOf('--workflow') + 1];
      polls[workflow] = (polls[workflow] ?? 0) + 1;
      if (polls[workflow] <= startDelayPolls) return '[]';
      assert.ok(args.includes('pull_request') && !args.includes('workflow_dispatch'), 'looks for the runs the push started');
      const finished = polls[workflow] > startDelayPolls + 1;
      return JSON.stringify([
        // An older run on the same commit, from an earlier round. It must be ignored.
        { databaseId: 1, headSha: SHA, createdAt: new Date(clock - 3_600_000).toISOString(), status: 'completed', conclusion: 'failure' },
        {
          databaseId: runs[workflow],
          headSha: SHA,
          createdAt: new Date(clock + 5_000).toISOString(),
          status: finished ? 'completed' : 'in_progress',
          conclusion: finished ? (conclusions[workflow] ?? 'success') : null
        }
      ]);
    }
    if (args[0] === 'run' && args[1] === 'view') return `log for ${args[2]}\n`;
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, calls, now: () => clock, sleep: async (ms) => { clock += ms; } };
}

test('both runs green means green, and nothing is dispatched', async () => {
  const f = fakeGh();
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.equal(result.green, true);
  assert.equal(result.sha, SHA);
  assert.ok(!f.calls.some((c) => c.startsWith('workflow run')), 'the push starts the runs, not this script');
});

test('one red run means not green, and the log of that run, and only that run, is kept', async () => {
  const f = fakeGh({ conclusions: { 'pr-checks.yml': 'failure' } });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.equal(result.green, false);
  assert.deepEqual(result.failed, ['pr-checks.yml']);
  assert.match(result.log, /pr-checks\.yml run 501: failure/);
  assert.match(result.log, /log for 501/);
  assert.doesNotMatch(result.log, /pr-build\.yml/);
});

test('a cancelled run is not green', async () => {
  const f = fakeGh({ conclusions: { 'pr-build.yml': 'cancelled' } });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.equal(result.green, false);
});

test('it waits for a run that has not appeared yet', async () => {
  const f = fakeGh({ startDelayPolls: 3 });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.equal(result.green, true);
});

test('a run that never appears is a fault, not a red check', async () => {
  const f = fakeGh({ startDelayPolls: 10_000 });
  await assert.rejects(
    verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 60_000, appearMs: 120_000 }),
    /did not start/
  );
});

test('a conflicting pull request is red with the conflict log, and no run is waited for', async () => {
  const f = fakeGh({ mergeable: ['CONFLICTING'], startDelayPolls: 10_000 });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.equal(result.green, false);
  assert.equal(result.sha, SHA);
  assert.deepEqual(result.failed, ['conflict']);
  assert.match(result.log, /conflicts with `testing`/);
  assert.match(result.log, /did not start its checks/);
  assert.match(result.log, /Merge `origin\/testing`/);
  assert.ok(!f.calls.some((c) => c.startsWith('run list')), 'it did not look for runs');
});

test('UNKNOWN is asked again until GitHub says CONFLICTING', async () => {
  const f = fakeGh({ mergeable: ['UNKNOWN', 'UNKNOWN', 'CONFLICTING'] });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.deepEqual(result.failed, ['conflict']);
  assert.equal(f.calls.filter((c) => c.startsWith('pr view')).length, 3);
});

test('UNKNOWN for the whole limit goes on to the normal wait', async () => {
  const f = fakeGh({ mergeable: ['UNKNOWN'] });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10_000, mergeableMs: 30_000 });
  assert.equal(result.green, true);
  const asked = f.calls.filter((c) => c.startsWith('pr view')).length;
  assert.ok(asked >= 3 && asked <= 6, `asked ${asked} times, then gave up`);
});

test('a mergeable pull request waits for its runs as before', async () => {
  const f = fakeGh({ mergeable: ['MERGEABLE'], conclusions: { 'pr-build.yml': 'failure' } });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.deepEqual(result.failed, ['pr-build.yml']);
  assert.equal(f.calls.filter((c) => c.startsWith('pr view')).length, 1);
});

test('runs that never appear on a pull request that has turned CONFLICTING are red, not a fault', async () => {
  const f = fakeGh({ mergeable: ['MERGEABLE', 'CONFLICTING'], startDelayPolls: 10_000 });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 60_000, appearMs: 120_000 });
  assert.equal(result.green, false);
  assert.deepEqual(result.failed, ['conflict']);
});

test('a branch outside claude/fix- is refused before anything is asked of GitHub', async () => {
  const f = fakeGh();
  await assert.rejects(verifyBranch(f, { repo: REPO, branch: 'testing', pr: 26 }), /refusing branch/);
  assert.equal(f.calls.length, 0);
});

test('a pull request number that is not digits is refused before anything is asked of GitHub', async () => {
  const f = fakeGh();
  await assert.rejects(verifyBranch(f, { repo: REPO, branch: BRANCH, pr: '26; echo' }), /digits/);
  assert.equal(f.calls.length, 0);
});

test('pickRun takes the newest run on the commit, and ignores other commits', () => {
  const runs = [
    { databaseId: 1, headSha: 'other', createdAt: '2026-10-10T10:00:10Z' },
    { databaseId: 2, headSha: SHA, createdAt: '2026-10-10T09:00:00Z' },
    { databaseId: 3, headSha: SHA, createdAt: '2026-10-10T10:00:05Z' }
  ];
  // The run starts at the push, before verify does, so there is no earliest time.
  assert.equal(pickRun(runs, { sha: SHA }).databaseId, 3, 'the newest match');
  assert.equal(pickRun(runs, { sha: 'none' }), undefined);
});

test('tail keeps the end of a long log, where the failure is', () => {
  const text = `${'start\n'.repeat(50)}THE FAILURE`;
  const cut = tail(text, 40);
  assert.match(cut, /THE FAILURE$/);
  assert.match(cut, /earlier output cut/);
  assert.equal(tail('short'), 'short');
});

// A fake `gh` for a branch behind testing whose checks never started.
function flakyGh({ failedJobs = ['e2e'], secondTry = 'success', behind = 0, mergeable = 'UNKNOWN', started = true } = {}) {
  const calls = [];
  let clock = 1_000_000;
  let attempt = 1;
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api' && args[1].includes('/compare/')) return `${behind}\n`;
    if (args[0] === 'api') return `${SHA}\n`;
    if (args[0] === 'pr' && args[1] === 'view') return `${mergeable}\n`;
    if (args[0] === 'run' && args[1] === 'list') {
      if (!started) return '[]';
      const workflow = args[args.indexOf('--workflow') + 1];
      return JSON.stringify([{ databaseId: workflow === 'pr-checks.yml' ? 501 : 502, headSha: SHA, createdAt: new Date(clock).toISOString(), status: 'completed', conclusion: workflow === 'pr-checks.yml' ? 'failure' : 'success' }]);
    }
    if (args[0] === 'run' && args[1] === 'rerun') { attempt = 2; return ''; }
    if (args[0] === 'run' && args[1] === 'view' && args.includes('jobs')) return JSON.stringify(failedJobs);
    if (args[0] === 'run' && args[1] === 'view' && args.includes('--json')) return JSON.stringify({ status: 'completed', conclusion: attempt > 1 ? secondTry : 'failure', attempt, databaseId: 501 });
    if (args[0] === 'run' && args[1] === 'view') return 'the failed log\n';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, calls, now: () => clock, sleep: async (ms) => { clock += ms; } };
}

test('no checks, mergeability UNKNOWN, branch behind testing: it is a conflict for the repair agent', async () => {
  const f = flakyGh({ started: false, behind: 3 });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.equal(result.green, false);
  assert.deepEqual(result.failed, ['conflict']);
});

test('no checks and not behind testing is still a fault', async () => {
  const f = flakyGh({ started: false, behind: 0 });
  await assert.rejects(verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 }), /did not start/);
});

test('a cancelled run on a head that has moved is not an answer: it looks at the new head', async () => {
  const base = fakeGh();
  const heads = ['old1', 'new1', 'new1', 'new1'];
  const gh = (args) => {
    if (args[0] === 'api') return `${heads.length > 1 ? heads.shift() : heads[0]}\n`;
    if (args[0] === 'run' && args[1] === 'list') {
      const at = new Date(1_000_000).toISOString();
      const workflow = args[args.indexOf('--workflow') + 1];
      const id = workflow === 'pr-checks.yml' ? 501 : 502;
      return JSON.stringify([
        { databaseId: id, headSha: 'old1', createdAt: at, status: 'completed', conclusion: 'cancelled' },
        { databaseId: id + 10, headSha: 'new1', createdAt: at, status: 'completed', conclusion: 'success' }
      ]);
    }
    return base.gh(args);
  };
  const result = await verifyBranch({ ...base, gh }, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.equal(result.green, true);
  assert.equal(result.sha, 'new1');
});

test('a cancelled run on a head that has NOT moved is still red', async () => {
  const f = fakeGh({ conclusions: { 'pr-checks.yml': 'cancelled' } });
  const result = await verifyBranch(f, { repo: REPO, branch: BRANCH, pr: 26, pollMs: 10 });
  assert.equal(result.green, false);
});
