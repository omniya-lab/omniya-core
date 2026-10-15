import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowChanges, whyOfLine } from '../../../scripts/ci/ship-pipeline-pr.mjs';
import { leaves, structuralChanges } from '../../../scripts/ci/workflow-diff.mjs';

const BASE = `
name: x
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  say:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`;

const change = (head, base = BASE) => structuralChanges(base, head, whyOfLine);
const has = (reasons, what) => reasons.some((r) => r.includes(what));

test('a change that touches nothing sensitive reads as no change', () => {
  assert.deepEqual(change(BASE.replace('echo hello', 'echo goodbye')), []);
  assert.deepEqual(change(BASE.replace('name: x', 'name: y')), []);
});

test('an alias is read for what it grants, not for how it is written', () => {
  const head = `
name: x
on:
  workflow_dispatch:
x-wide: &wide
  contents: write
permissions: *wide
jobs:
  say:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`;
  assert.ok(has(change(head), 'a permission'), 'permissions: *wide is contents: write');
});

test('a merge key and quoted keys are read for what they grant', () => {
  const head = `
name: x
on:
  workflow_dispatch:
defaults_perms: &p
  issues: write
permissions:
  <<: *p
  contents: read
jobs:
  say:
    "environment": 'pipeline'
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`;
  const reasons = change(head);
  assert.ok(has(reasons, 'a permission'), 'issues: write through a merge key');
  assert.ok(has(reasons, 'an environment'), 'a quoted environment key');
});

test('a secret is found wherever it is written', () => {
  for (const where of ['      - run: echo ${{ secrets.X }}', "      - run: echo ${{ secrets['X'] }}", '      - env:\n          T: ${{ toJSON(secrets) }}\n        run: echo']) {
    const head = BASE.replace('      - run: echo hello', where);
    assert.ok(has(change(head), 'a secret or a token'), where);
  }
  // Passing every secret to a called workflow.
  assert.ok(has(change(BASE.replace('    runs-on: ubuntu-latest', '    uses: ./.github/workflows/other.yml\n    secrets: inherit')), 'a secret or a token'));
});

test('who may start the agent is read from the parsed step, wherever the key sits', () => {
  const head = BASE.replace('      - run: echo hello', "      - uses: anthropics/claude-code-action@v1\n        with:\n          'allowed_bots': 'github-actions'");
  assert.ok(has(change(head), 'who may start the agent'));
});

test('a trigger that runs with secrets is sensitive', () => {
  assert.ok(has(change(BASE.replace('  workflow_dispatch:', '  pull_request_target:')), 'a privileged trigger'));
  assert.ok(has(change(BASE.replace('  workflow_dispatch:', '  workflow_run:\n    workflows: [x]')), 'a privileged trigger'));
});

test('moving a step is not a change, but taking a guard away is', () => {
  const guarded = BASE.replace('    runs-on: ubuntu-latest', '    environment: pipeline\n    runs-on: ubuntu-latest');
  assert.deepEqual(change(guarded, guarded), []);
  const reordered = guarded.replace('    environment: pipeline\n    runs-on: ubuntu-latest', '    runs-on: ubuntu-latest\n    environment: pipeline');
  assert.deepEqual(change(reordered, guarded), []);
  const removed = change(BASE, guarded);
  assert.ok(has(removed, 'an environment, taken away'), 'removing the environment is as sensitive as adding one');
});

test('taking a permissions block away widens the job, and adding a read-only one does not', () => {
  const noPerms = BASE.replace('permissions:\n  contents: read\n', '');
  assert.ok(has(change(noPerms), 'a permissions block taken away'));
  // A read-only block on a workflow that had none is not a grant.
  assert.deepEqual(change(BASE, noPerms), []);
});

test('a new workflow is judged as all of its settings, and a removed one is not a widening', () => {
  const wide = BASE.replace('contents: read', 'contents: write');
  assert.ok(has(structuralChanges(null, wide, whyOfLine), 'a permission'));
  assert.deepEqual(structuralChanges(null, BASE, whyOfLine), []);
  assert.ok(has(structuralChanges(wide, null, whyOfLine), 'taken away'), 'a removed guard is still noted');
  assert.ok(!has(structuralChanges(BASE, null, whyOfLine), 'permissions block taken away'));
});

test('a workflow that cannot be read counts as changed, never as unchanged', () => {
  assert.deepEqual(change('name: [unclosed'), ['a workflow that cannot be read as YAML']);
  assert.deepEqual(structuralChanges('name: [unclosed', BASE, whyOfLine), ['a workflow that cannot be read as YAML']);
});

test('leaves drop the place in a list, so only what a step says matters', () => {
  const out = leaves('steps:\n  - run: a\n  - run: b\n');
  assert.deepEqual(out.map((l) => l.path), ['steps.[].run', 'steps.[].run']);
});

test('the shipper reads only workflow files this way, and fetches each at the right commit', () => {
  const calls = [];
  const read = (path, ref) => {
    calls.push([path, ref]);
    return ref === 'head' ? BASE.replace('contents: read', 'contents: write') : BASE;
  };
  const files = [
    { filename: '.github/workflows/pipeline-a.yml', status: 'modified' },
    { filename: 'scripts/ci/x.mjs', status: 'modified' },
    { filename: 'docs/a.md', status: 'modified' }
  ];
  const reasons = workflowChanges(files, read, 'base', 'head');
  assert.ok(reasons.some((r) => r.startsWith('.github/workflows/pipeline-a.yml:') && r.includes('a permission')));
  assert.deepEqual(calls, [['.github/workflows/pipeline-a.yml', 'head'], ['.github/workflows/pipeline-a.yml', 'base']]);
});

test('a moved workflow is read from where it was, a new one has no before, and a failed fetch is unreadable', () => {
  const calls = [];
  const read = (path, ref) => { calls.push([path, ref]); return BASE; };
  workflowChanges([{ filename: '.github/workflows/pipeline-b.yml', previous_filename: '.github/workflows/pipeline-a.yml', status: 'renamed' }], read, 'base', 'head');
  assert.deepEqual(calls, [['.github/workflows/pipeline-b.yml', 'head'], ['.github/workflows/pipeline-a.yml', 'base']]);

  const added = [];
  workflowChanges([{ filename: '.github/workflows/pipeline-c.yml', status: 'added' }], (p, r) => { added.push(r); return BASE; }, 'base', 'head');
  assert.deepEqual(added, ['head'], 'no before for a new file');

  const failed = workflowChanges([{ filename: '.github/workflows/pipeline-d.yml', status: 'modified' }], () => { throw new Error('boom'); }, 'base', 'head');
  assert.ok(failed[0].includes('could not be fetched'));
});
