import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load as loadYaml } from 'js-yaml';

const PATH = '.github/workflows/pr-checks.yml';
const source = readFileSync(PATH, 'utf8');
const workflow = loadYaml(source);
const triggers = workflow.on ?? workflow[true];

// The commands that must actually decide whether a pull request may merge.
// Named here rather than inferred, so that deleting a job is a test failure
// instead of a silently smaller gate.
const REQUIRED = [
  { job: 'unit', run: 'npm test' },
  { job: 'nemeth', run: 'node scripts/ci/nemeth-gate.mjs' },
  { job: 'e2e', run: 'npm run test:e2e' }
];

test('no gate can be skipped', () => {
  // Three separate ways a gate stops being a gate while still showing a green
  // tick. Every one of them has to be closed, because the checks that watch a
  // run's conclusion cannot tell a passing gate from a gate that could not fail.
  for (const { job, run } of REQUIRED) {
    const definition = workflow.jobs?.[job];
    assert.ok(definition, `expected a \`${job}\` job`);

    // 1. The whole job made conditional.
    assert.equal(definition.if, undefined, `the ${job} job must not be behind an \`if\``);
    assert.equal(definition['continue-on-error'], undefined, `the ${job} job must not continue-on-error`);

    const step = (definition.steps ?? []).find((s) => s.run === run);
    assert.ok(step, `the ${job} job must run \`${run}\` as its own step`);

    // 2. The step made advisory.
    assert.equal(step.if, undefined, `\`${run}\` must not be behind an \`if\``);
    assert.equal(step['continue-on-error'], undefined, `\`${run}\` must not continue-on-error`);

    // 3. The command's exit code swallowed in the shell.
    assert.doesNotMatch(step.run, /\|\|\s*true|;\s*exit\s+0|\|\|\s*:/, `\`${run}\` must not swallow its exit code`);
  }
});

test('the Nemeth job does not trust an exit code that is always zero', () => {
  // Measured: neither `nemeth:coverage` nor `nemeth:utility` sets an exit code.
  // They print and return 0 whatever the numbers say. A job that ran them
  // directly would be a tick that means nothing. This is the assertion that
  // stops somebody "simplifying" the wrapper away.
  const steps = workflow.jobs.nemeth.steps.map((s) => s.run).filter(Boolean);
  assert.ok(
    steps.some((run) => run.includes('scripts/ci/nemeth-gate.mjs')),
    'the nemeth job must go through the gate wrapper'
  );
  for (const run of steps) {
    assert.doesNotMatch(
      run,
      /npm run nemeth:(coverage|utility)/,
      'calling the report scripts directly is not a gate: they always exit 0'
    );
  }
});

test('the gate runs on pull requests into testing', () => {
  assert.deepEqual(triggers?.pull_request?.branches, ['testing']);
});

test('the gate cannot write to the repository', () => {
  // It checks out pull request code and runs it. Read-only is the containment.
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});

test('every gate job runs on macOS', () => {
  // `scripts/stage-liblouis.mjs` supports darwin and win32 only, and the e2e
  // suite drives a real Electron window. A job quietly moved to ubuntu to save
  // minutes would fail for reasons that look like the change under test.
  for (const { job } of REQUIRED) {
    // The label may come from the variable MAC_RUNNER (a mac label), and its default is macos-latest.
    assert.match(workflow.jobs[job]['runs-on'], /^(macos|\$\{\{ vars\.MAC_RUNNER \|\| 'macos-latest' \}\}$)/, `${job} must run on macOS`);
  }
});

test('every gate job has a timeout, so a hang fails instead of hanging', () => {
  // HANDOFF.md warns the e2e suite can hang rather than complete when there is
  // no logged-in display session, which is exactly what a runner is. A hang with
  // no timeout is a job that never reports, and a gate that never reports blocks
  // the pull request without saying why.
  for (const { job } of REQUIRED) {
    assert.equal(typeof workflow.jobs[job]['timeout-minutes'], 'number', `${job} needs timeout-minutes`);
  }
});

test('the gate is started by the pull request itself, and by nothing else', () => {
  // The pipeline opens its pull requests with its App's token, so GitHub starts
  // this run itself. There is no `workflow_dispatch` any more, and no job may
  // carry an `if` that could skip one.
  assert.equal(triggers?.workflow_dispatch, undefined);
  for (const { job } of REQUIRED) {
    assert.equal(workflow.jobs[job].if, undefined, `${job} must always run`);
  }
});

