import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { issueOf, keepCurrent, outcomeOf, plan } from '../../../scripts/ci/keep-current.mjs';

const pr = (over = {}) => ({
  number: 7,
  body: 'text\n\nFixes #70\n',
  headRefName: 'claude/fix-70-x',
  headRefOid: 'abc',
  isCrossRepository: false,
  baseRefName: 'testing',
  labels: [],
  ...over
});

test('the issue is the Fixes line, last, and nothing else', () => {
  assert.equal(issueOf('a\n\nFixes #70\n'), '70');
  assert.equal(issueOf('Fixes #70\nand more'), '');
  assert.equal(issueOf('see Fixes #70 above'), '');
  assert.equal(issueOf(null), '');
});

test('only the pipeline\'s own fix branches into testing, from this repository, are looked at', () => {
  const { pick } = plan([
    pr({ number: 1 }),
    pr({ number: 2, headRefName: 'feature/x' }),
    pr({ number: 3, isCrossRepository: true }),
    pr({ number: 4, baseRefName: 'main' }),
    pr({ number: 5, body: 'no fixes line' })
  ]);
  assert.deepEqual(pick.map((p) => p.number), [1]);
});

test('a pull request that already waits on a person is left alone, so a failed repair is not retried on every push', () => {
  const { pick, skipped } = plan([
    pr({ number: 1, labels: [{ name: 'needs-owner' }] }),
    pr({ number: 2, labels: [{ name: 'needs-maintainer' }] }),
    pr({ number: 3, labels: [{ name: 'nemeth' }] })
  ]);
  assert.deepEqual(pick.map((p) => p.number), [3]);
  assert.deepEqual(skipped.map((s) => s.pr), [1, 2]);
});

test('one pull request can be asked for by number', () => {
  assert.deepEqual(plan([pr({ number: 1 }), pr({ number: 2 })], '2').pick.map((p) => p.number), [2]);
});

test('what GitHub says back is read as updated, current, conflict or error', () => {
  assert.equal(outcomeOf('', true), 'updated');
  assert.equal(outcomeOf('merge conflict between base and head', false), 'conflict');
  assert.equal(outcomeOf('There are no new commits on the base branch.', false), 'current');
  assert.equal(outcomeOf('Bad credentials', false), 'error');
});

function fakeGh(prs, fail = {}) {
  const calls = [];
  const gh = (args, opts = {}) => {
    calls.push({ args, token: opts.token });
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
    if (args[0] === 'api') {
      const n = args[3].match(/pulls\/(\d+)\//)[1];
      if (fail[n]) throw Object.assign(new Error('x'), { stderr: fail[n] });
      return '{}';
    }
    return '';
  };
  return { gh, calls };
}

test('each branch is updated with the App token, pinned to the head it looked at, and a conflict is reported for repair', () => {
  const prs = [pr({ number: 1, headRefOid: 'aaa' }), pr({ number: 2, body: 'x\n\nFixes #71\n', headRefName: 'claude/fix-71-y', headRefOid: 'bbb' }), pr({ number: 3, body: 'x\n\nFixes #72\n', headRefName: 'claude/fix-72-z' })];
  const f = fakeGh(prs, { 2: 'merge conflict between base and head', 3: 'There are no new commits on the base branch.' });
  const out = keepCurrent({ repo: 'a/b', mergeToken: 'APP' }, f.gh);
  assert.deepEqual(out.updated, [1]);
  assert.deepEqual(out.current, [3]);
  assert.deepEqual(out.conflicts, [{ issue: '71', pr: '2', branch: 'claude/fix-71-y' }]);
  const first = f.calls.find((c) => c.args[0] === 'api');
  assert.equal(first.token, 'APP', 'the App token, so the push starts the checks');
  assert.ok(first.args.includes('expected_head_sha=aaa'));
  assert.ok(first.args.includes('PUT'));
});

test('an error on one branch does not stop the others', () => {
  const prs = [pr({ number: 1 }), pr({ number: 2, body: 'x\n\nFixes #71\n', headRefName: 'claude/fix-71-y' })];
  const out = keepCurrent({ repo: 'a/b', mergeToken: 'APP' }, fakeGh(prs, { 1: 'Bad credentials' }).gh);
  assert.equal(out.errors.length, 1);
  assert.deepEqual(out.updated, [2]);
});

test('refuses to run without the App token, and for a number that is not digits', () => {
  assert.throws(() => keepCurrent({ repo: 'a/b', mergeToken: '' }, () => '[]'), /MERGE_TOKEN/);
  assert.throws(() => keepCurrent({ repo: 'a/b', only: '1; rm', mergeToken: 'APP' }, () => '[]'), /digits/);
});

test('the workflow asks the App for only contents and pull requests, never statuses, and runs in the locked environment', () => {
  const yml = readFileSync('.github/workflows/pipeline-keep-current.yml', 'utf8');
  assert.match(yml, /environment: pipeline/);
  assert.doesNotMatch(yml, /permission-statuses/);
  assert.match(yml, /permission-contents: write/);
  assert.match(yml, /permission-pull-requests: write/);
  assert.match(yml, /uses: \.\/\.github\/workflows\/pipeline-verify\.yml/);
  assert.match(yml, /max-parallel: 1/, 'each repair spends the maintainer\'s quota');
  assert.match(yml, /group: contributor-issue-\$\{\{ matrix\.item\.issue \}\}/, 'a contributor\'s own run on the issue waits for it');
  assert.doesNotMatch(yml, /run:[^\n]*\$\{\{/, 'no expression inside a run line');
});

test('the agent never runs in a run that a push started, because the action refuses that event', async () => {
  // Seen live: "Unsupported event type: push". Five repairs failed in one step and five
  // contributors were told a maintainer had to look, when no agent had even started.
  const { load } = await import('js-yaml');
  const wf = load(readFileSync('.github/workflows/pipeline-keep-current.yml', 'utf8'));
  assert.match(wf.jobs.repair.if, /github\.event_name != 'push'/);
  assert.match(wf.jobs.redispatch.if, /github\.event_name == 'push'/);
  // A repair cannot be reached from a push, and a manual run cannot start another manual run.
  assert.doesNotMatch(wf.jobs.redispatch.if, /workflow_dispatch|schedule/);
});

test('the push starts ONE manual run for all conflicts, not one per pull request, with no secret', async () => {
  const { load } = await import('js-yaml');
  const wf = load(readFileSync('.github/workflows/pipeline-keep-current.yml', 'utf8'));
  const job = wf.jobs.redispatch;
  assert.deepEqual(job.permissions, { actions: 'write' });
  assert.equal(job.environment, undefined);
  assert.doesNotMatch(JSON.stringify(job), /secrets\.|app-token|MERGE_TOKEN/);
  const run = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(run, /gh workflow run pipeline-keep-current\.yml/);
  assert.doesNotMatch(run, /pr_number|for |while |xargs/, 'one start: GitHub keeps one waiting run per group, so a loop would lose all but the last');
});

test('the job that starts the update holds no secret, and the hand-off job still holds no actions permission', async () => {
  const { load } = await import('js-yaml');
  const followup = load(readFileSync('.github/workflows/pipeline-followup.yml', 'utf8'));
  const start = followup.jobs['bring-up-to-date'];
  assert.deepEqual(start.permissions, { actions: 'write' });
  assert.deepEqual(start.needs, ['allowlist', 'handoff']);
  assert.match(start.if, /needs\.handoff\.outputs\.conflict == 'true'/);
  assert.doesNotMatch(JSON.stringify(start), /secrets\./, 'it can start a workflow, so it must hold no secret');
  assert.equal(start.environment, undefined);
  assert.equal(followup.jobs.handoff.permissions.actions, undefined, 'the job with the App key starts nothing');
  assert.equal(followup.jobs.handoff.outputs.conflict, '${{ steps.hand.outputs.conflict }}');
});

test('the agent accepts the Actions bot for a manual run and for nothing else', async () => {
  // Seen live: "Workflow initiated by non-human actor: github-actions (type: Bot)". A push starts
  // `keep-current`, which starts a manual run, and the Actions bot is that run's actor.
  const { load } = await import('js-yaml');
  const wf = load(readFileSync('.github/workflows/pipeline-agent.yml', 'utf8'));
  const step = Object.values(wf.jobs).flatMap((job) => job.steps ?? []).find((s) => s.id === 'agent');
  const allowed = step.with.allowed_bots;
  assert.match(allowed, /github\.event_name == 'workflow_dispatch'/, 'only for a manual run');
  assert.match(allowed, /'github-actions'/);
  assert.doesNotMatch(allowed, /\*/, 'never every bot');
  assert.match(allowed, /\|\| ''/, 'every other event allows no bot');
  assert.doesNotMatch(allowed.replace(/'github-actions'/, ''), /github-actions|dependabot|\[bot\]/, 'only that one bot is named');
});
