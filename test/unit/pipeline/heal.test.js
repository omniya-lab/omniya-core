import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { clear, isFault, lastStuckRun, legacyFault, runWasFault, stuck } from '../../../scripts/ci/heal.mjs';

test('a job that failed is a fault; a skipped repair, a cancel and a green job are not', () => {
  assert.equal(isFault(['success', 'failure', 'skipped']), true);
  assert.equal(isFault(['success', 'skipped', 'cancelled']), false);
  assert.equal(isFault(['success', 'success']), false);
  assert.equal(isFault([]), false);
});

test('a finished run is read the same way, by the repair and verify jobs inside it', () => {
  assert.equal(runWasFault([{ name: 'update', conclusion: 'success' }, { name: 'repair (56, 60, b) / repair-1 / agent', conclusion: 'failure' }]), true);
  assert.equal(runWasFault([{ name: 'repair (56, 60, b) / repair-1 / agent', conclusion: 'success' }, { name: 'repair (56, 60, b) / verify-4', conclusion: 'success' }]), false);
  assert.equal(runWasFault([{ name: 'redispatch', conclusion: 'failure' }]), false, 'only the repair and verify jobs say anything about the fix');
});

test('the run to read is the newest one a stuck comment names', () => {
  const text = (id) => `The automatic checks or the build are still red after 3 repair attempts, or the repair agent asked for a person. The maintainer has to look. Run: https://github.com/o/r/actions/runs/${id}`;
  assert.equal(lastStuckRun([{ body: 'hello' }, { body: text('111') }, { body: text('222') }]), '222');
  assert.equal(lastStuckRun([{ body: 'The contributor installed the build' }]), '');
});

test('an old stuck pull request is a fault when its run failed in a repair, and not when anything goes wrong reading it', () => {
  const comment = JSON.stringify({ body: 'still red after 3 repair attempts, x. Run: https://github.com/o/r/actions/runs/222' });
  const gh = (jobs) => (args) => (args[1].includes('/comments') ? comment : jobs.map((j) => JSON.stringify(j)).join('\n'));
  assert.equal(legacyFault({ repo: 'o/r', pr: 1 }, gh([{ name: 'repair (1, 2, b) / repair-1 / agent', conclusion: 'failure' }])), true);
  assert.equal(legacyFault({ repo: 'o/r', pr: 1 }, gh([{ name: 'repair (1, 2, b) / repair-1 / agent', conclusion: 'success' }])), false);
  assert.equal(legacyFault({ repo: 'o/r', pr: 1 }, () => { throw new Error('404'); }), false);
});

function recorder() {
  const calls = [];
  return { calls, gh: (args) => { calls.push(args.join(' ')); return ''; } };
}

test('red with a failed job marks a fault and tells the contributor; the retry that fails again marks nothing new and tells nobody', () => {
  const first = recorder();
  assert.deepEqual(stuck({ repo: 'o/r', pr: '9', results: ['success', 'failure'], retry: false }, first.gh), { fault: true, tell: true });
  assert.ok(first.calls.some((c) => c.includes('--add-label needs-owner')));
  assert.ok(first.calls.some((c) => c.includes('--add-label pipeline-fault')));

  const again = recorder();
  assert.deepEqual(stuck({ repo: 'o/r', pr: '9', results: ['failure'], retry: true }, again.gh), { fault: true, tell: false });
  assert.ok(!again.calls.some((c) => c.includes('--add-label pipeline-fault')), 'no second chance');
});

test('red with every job finished is a person\'s problem: needs-owner and no fault label', () => {
  const r = recorder();
  assert.deepEqual(stuck({ repo: 'o/r', pr: '9', results: ['success', 'success', 'skipped'], retry: false }, r.gh), { fault: false, tell: true });
  assert.ok(!r.calls.some((c) => c.includes('pipeline-fault')));
});

test('green takes all three labels off, and a missing label is not an error', () => {
  const calls = [];
  clear({ repo: 'o/r', pr: '9' }, (args) => { calls.push(args.at(-1)); throw new Error('label not found'); });
  assert.deepEqual(calls, ['needs-owner', 'pipeline-fault', 'pipeline-fault-retried']);
  assert.throws(() => clear({ repo: 'o/r', pr: '9; x' }, () => ''), /digits/);
});

test('the report passes every job result and the retry flag by env, and a green run clears first', async () => {
  const { load } = await import('js-yaml');
  const wf = load(readFileSync('.github/workflows/pipeline-verify.yml', 'utf8'));
  const step = wf.jobs.report.steps.find((s) => s.id === 'final');
  assert.equal(step.env.RESULTS, "${{ join(needs.*.result, ' ') }}");
  assert.equal(step.env.HEAL, '${{ inputs.heal }}');
  assert.match(step.run, /heal\.mjs clear/);
  assert.match(step.run, /heal\.mjs stuck/);
  assert.doesNotMatch(step.run, /\$\{\{/);
});

test('a retry speaks only while the newest thing the contributor was told is the maintainer reply', async () => {
  const { newestState, stillWaiting } = await import('../../../scripts/ci/heal.mjs');
  const reply = (state) => ({ body: `<!-- omniya-pipeline-reply -->\n<!-- omniya-pipeline-state ${state} -->\ntext` });
  assert.equal(newestState([reply('ready'), { body: 'a person said hi' }, reply('maintainer')]), 'maintainer');
  assert.equal(newestState([reply('maintainer'), reply('ready')]), 'ready', 'pipeline-rescued already spoke');
  assert.equal(newestState([{ body: '<!-- omniya-pipeline-state maintainer --> but not from the pipeline' }]), '');
  const gh = (comments) => () => comments.map((c) => JSON.stringify(c)).join('\n');
  assert.equal(stillWaiting({ repo: 'o/r', issue: 1 }, gh([reply('maintainer')])), true);
  assert.equal(stillWaiting({ repo: 'o/r', issue: 1 }, gh([reply('maintainer'), reply('revised')])), false);
});
