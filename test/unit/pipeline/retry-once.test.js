import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { flakedTest, retryOnce } from '../../../scripts/ci/retry-once.mjs';

// A fake runner that answers in order, so no process starts.
function fake(...results) {
  const calls = [];
  const said = [];
  const summary = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(' '));
    return results.shift();
  };
  return { run, calls, said, summary, io: { run, say: (l) => said.push(l), summary: (l) => summary.push(l) } };
}

test('a pass the first time runs once and says nothing', async () => {
  const f = fake({ code: 0, output: '' });
  assert.equal(await retryOnce(['npm', 'test'], f.io), 0);
  assert.deepEqual(f.calls, ['npm test']);
  assert.deepEqual(f.summary, []);
});

test('a failure that passes the second time is a pass, named in one line in the summary', async () => {
  const f = fake({ code: 1, output: 'x\n  at test/e2e/word-flow.test.js:83:5\n' }, { code: 0, output: '' });
  assert.equal(await retryOnce(['npm', 'run', 'test:e2e'], { ...f.io, label: 'e2e' }), 0);
  assert.deepEqual(f.calls, ['npm run test:e2e', 'npm run test:e2e']);
  assert.equal(f.summary.length, 1);
  assert.match(f.summary[0], /test\/e2e\/word-flow\.test\.js:83/);
  assert.match(f.summary[0], /\(e2e\)/);
});

test('a failure that fails again stays red with the second exit code, and runs exactly twice', async () => {
  const f = fake({ code: 1, output: '' }, { code: 3, output: '' });
  assert.equal(await retryOnce(['npm', 'test'], f.io), 3);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.summary, []);
});

test('a command that was killed or could not start is not tried again', async () => {
  const f = fake({ code: null, output: 'spawn nope ENOENT' });
  assert.equal(await retryOnce(['nope'], f.io), 1);
  assert.equal(f.calls.length, 1);
});

test('a test is named by file and line, else by its title, else not at all', () => {
  assert.equal(flakedTest('Error\n    at file:///w/test/e2e/menu-undo.test.js:31:12\n'), 'test/e2e/menu-undo.test.js:31');
  assert.equal(flakedTest('not ok 4 - types Then more.\n'), 'types Then more.');
  assert.equal(flakedTest('boom'), '');
});

test('for real: a command that fails the first time only passes, and one that always fails stays red', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retry-'));
  const marker = join(dir, 'seen');
  const flaky = join(dir, 'flaky.mjs');
  writeFileSync(flaky, `import { existsSync, writeFileSync } from 'node:fs';\nif (existsSync(${JSON.stringify(marker)})) process.exit(0);\nwriteFileSync(${JSON.stringify(marker)}, '1');\nconsole.error('not ok 1 - flaky thing');\nprocess.exit(1);\n`);
  const summaryFile = join(dir, 'summary.md');
  const script = new URL('../../../scripts/ci/retry-once.mjs', import.meta.url).pathname;
  const env = { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summaryFile };
  const pass = spawnSync(process.execPath, [script, process.execPath, flaky], { env, encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(readFileSync(summaryFile, 'utf8'), /flaky thing/);
  const fail = spawnSync(process.execPath, [script, process.execPath, '-e', 'process.exit(7)'], { env, encoding: 'utf8' });
  assert.equal(fail.status, 7);
});
