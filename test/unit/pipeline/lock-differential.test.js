import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LINES, PHRASES, RANK, decideCases } from '../../../scripts/ci/lock-corpus.mjs';
import { check, compare, protectedPaths, runChild } from '../../../scripts/ci/lock-differential.mjs';

// A scratch copy of the rules as they are now, with the dependencies beside it.
function copyOfRules() {
  const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  cpSync('scripts/ci', join(dir, 'scripts/ci'), { recursive: true });
  cpSync('package.json', join(dir, 'package.json'));
  if (existsSync('node_modules')) symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
const edit = (dir, file, from, to) => {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(from), `the copy has no ${JSON.stringify(from)} to change in ${file}`);
  writeFileSync(path, text.replace(from, to));
};

test('the questions cover every protected path, in every way a file can change, and are the same every time', () => {
  const paths = protectedPaths('.');
  assert.ok(paths.length >= 15);
  const cases = decideCases({ paths });
  assert.ok(cases.length > 5000, `only ${cases.length} questions`);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'every question has its own name');
  assert.deepEqual(decideCases({ paths }).map((c) => c.id), cases.map((c) => c.id));
  for (const path of paths) assert.ok(cases.some((c) => c.id.startsWith(`${path}|removed|`)), `${path} is asked as a removed file`);
  assert.ok(PHRASES.length > 30 && LINES.length > 40);
  assert.deepEqual(Object.keys(RANK), ['automatic', 'ship-it', 'lock', 'refuse']);
});

test('the rules as they are now are no looser than themselves', () => {
  const dir = copyOfRules();
  const result = check('.', dir);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('a looser answer to a decision is found, with its name', () => {
  const base = { lists: { lock: ['a'], shipIt: [], shipItPrefixes: [], allowedPrefixes: ['docs/'] }, decisions: [['x', 'lock'], ['y', 'refuse']], phrases: [false], lines: [true], yaml: [true] };
  const head = structuredClone(base);
  head.decisions = [['x', 'automatic'], ['y', 'refuse']];
  const out = compare(base, head);
  assert.equal(out.ok, false);
  assert.match(out.problems[0], /looser: x was lock, is automatic/);
});

test('a stricter answer, or the same, is fine', () => {
  const base = { lists: { lock: ['a'], shipIt: [], shipItPrefixes: [], allowedPrefixes: ['docs/'] }, decisions: [['x', 'ship-it'], ['y', 'automatic']], phrases: [true], lines: [false], yaml: [false] };
  const head = structuredClone(base);
  head.decisions = [['x', 'lock'], ['y', 'refuse']];
  head.lists.lock = ['a', 'b'];
  head.lines = [true];
  head.phrases = [false];
  assert.equal(compare(base, head).ok, true);
  assert.equal(compare(base, structuredClone(base)).ok, true);
});

test('a path dropped from a list, a wider allowed place, new words that count, and a line no longer flagged all fail', () => {
  const base = { lists: { lock: ['a', 'b'], shipIt: ['c'], shipItPrefixes: ['.claude/'], allowedPrefixes: ['docs/'] }, decisions: [], phrases: [false, true], lines: [true], yaml: [true] };
  const head = structuredClone(base);
  head.lists.lock = ['a'];
  head.lists.shipIt = [];
  head.lists.shipItPrefixes = [];
  head.lists.allowedPrefixes = ['docs/', 'src/'];
  head.phrases = [true, true];
  head.lines = [false];
  head.yaml = [false];
  const text = compare(base, head).problems.join('\n');
  for (const part of ['no longer list b', 'no longer list c', 'no longer list .claude/', 'allowed places grew: src/', 'now count as ship', 'no longer sensitive', 'no longer flagged']) {
    assert.match(text, new RegExp(part), part);
  }
});

test('two versions asked different questions cannot be compared', () => {
  const base = { lists: { lock: [], shipIt: [], shipItPrefixes: [], allowedPrefixes: [] }, decisions: [['x', 'lock']], phrases: [], lines: [], yaml: [] };
  const head = { ...structuredClone(base), decisions: [] };
  assert.equal(compare(base, head).ok, false);
});

// ---- the real thing: load a copy of the rules, change it the way a mistake would, and ask ----

test('REAL: words that always count as ship are found', () => {
  const dir = copyOfRules();
  edit(dir, 'scripts/ci/ship-pipeline-pr.mjs', 'export function saysShip(said) {', 'export function saysShip(said) {\n  return true;\n}\nfunction unused(said) {');
  const result = check('.', dir);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /now count as ship/);
});

test('REAL: a protected file dropped from the manifest is found', () => {
  const dir = copyOfRules();
  const path = join(dir, 'scripts/ci/protection.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.lock = m.lock.filter((f) => f !== 'scripts/ci/ship-pipeline-pr.mjs');
  writeFileSync(path, JSON.stringify(m));
  const result = check('.', dir);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /no longer list scripts\/ci\/ship-pipeline-pr\.mjs/);
});

test('REAL: a pattern that no longer matches anything is found', () => {
  const dir = copyOfRules();
  edit(dir, 'scripts/ci/ship-pipeline-pr.mjs', "[/secrets\\s*(\\.|\\[|:\\s*inherit)|toJSON", "[/NEVERMATCHES(\\.|\\[|:\\s*inherit)|toJSON");
  const result = check('.', dir);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /no longer sensitive|looser/);
});

test('REAL: a lock change that stops asking for the owner\'s words is found', () => {
  const dir = copyOfRules();
  edit(dir, 'scripts/ci/ship-pipeline-pr.mjs', 'if (!saysShip(ownerSaid)) {', 'if (false) {');
  const result = check('.', dir);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /looser/);
});

test('REAL: a rule that stops asking for the strictness verdict is found', () => {
  const dir = copyOfRules();
  edit(dir, 'scripts/ci/ship-pipeline-pr.mjs', "if (differential !== 'pass') {", "if (false) {");
  const result = check('.', dir);
  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /verdict\|/);
});

test('the new code runs with a bare environment: it sees no token and no GITHUB variable', () => {
  const dir = copyOfRules();
  // A rule file that tries to read the environment and report it through the answers.
  edit(dir, 'scripts/ci/ship-pipeline-pr.mjs', 'export const LOCK_FILES = MANIFEST.lock;', 'export const LOCK_FILES = [...MANIFEST.lock, ...Object.keys(process.env).filter((k) => /TOKEN|GITHUB|SECRET|KEY/.test(k)).map((k) => `LEAK:${k}`)];');
  process.env.SOME_SECRET_TOKEN = 'x';
  process.env.GITHUB_TOKEN = 'y';
  try {
    const answers = runChild(dir, protectedPaths('.'));
    assert.deepEqual(answers.lists.lock.filter((f) => f.startsWith('LEAK:')), [], 'the child saw an environment variable it must not see');
  } finally {
    delete process.env.SOME_SECRET_TOKEN;
    delete process.env.GITHUB_TOKEN;
  }
});

test('the new code cannot write the verdict: the child only prints, and the trusted process compares', () => {
  const source = readFileSync('scripts/ci/lock-differential.mjs', 'utf8');
  // The only writer of GITHUB_OUTPUT is the trusted `check` path, and the child is spawned with only PATH.
  assert.match(source, /env: \{ PATH: process\.env\.PATH \?\? '' \}/);
  assert.match(source, /timeout: TIME_LIMIT_MS/);
  assert.equal([...source.matchAll(/GITHUB_OUTPUT/g)].length, 2, 'one place writes the verdict');
});
