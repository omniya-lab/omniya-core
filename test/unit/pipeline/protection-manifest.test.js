import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { automationFiles, loadManifest, measure, tierOf } from '../../../scripts/ci/protection-report.mjs';
import { LOCK_FILES, SHIP_IT_FILES, SHIP_IT_PREFIXES } from '../../../scripts/ci/ship-pipeline-pr.mjs';

// The rule: the protected set holds only sensitive code, and sensitive code lives only in the
// protected set. A file name is a poor stand-in for that, so this test checks the second half
// by counting, and keeps the first half small by capping the size of what is protected.

const manifest = loadManifest();
// The manifest records its own protection, so it is not counted against itself.
const SELF = 'scripts/ci/protection.json';

test('the shipper reads its protected lists from the manifest, and keeps no list of its own', () => {
  // One list. If someone writes a second one into the shipper, this fails, because the two
  // could then drift and a file the manifest calls protected would be shipped as free.
  assert.deepEqual(LOCK_FILES, manifest.lock);
  assert.deepEqual(SHIP_IT_FILES, manifest.shipIt);
  assert.deepEqual(SHIP_IT_PREFIXES, manifest.shipItPrefixes);
  const source = readFileSync('scripts/ci/ship-pipeline-pr.mjs', 'utf8');
  assert.match(source, /readFileSync\(new URL\('\.\/protection\.json', import\.meta\.url\)/);
  assert.doesNotMatch(source, /LOCK_FILES\s*=\s*\[|SHIP_IT_FILES\s*=\s*\[/, 'a literal list in the shipper');
});

test('the manifest, this test, the report and the strictness check are part of the lock', () => {
  for (const file of [SELF, 'test/unit/pipeline/protection-manifest.test.js', 'scripts/ci/protection-report.mjs', 'scripts/ci/lock-corpus.mjs', 'scripts/ci/lock-differential.mjs']) {
    assert.equal(tierOf(file, manifest), 'lock', `${file} defines what is protected, so a change to it must pass the strictness check`);
  }
});

test('every protected file exists, and no file is protected twice', () => {
  for (const file of [...manifest.lock, ...manifest.shipIt]) assert.ok(existsSync(file), `${file} is protected but does not exist`);
  const all = [...manifest.lock, ...manifest.shipIt];
  assert.equal(new Set(all).size, all.length, 'a file is listed in two tiers');
});

test('a protected file stays small, so ordinary code cannot be parked in it', () => {
  for (const file of [...manifest.lock, ...manifest.shipIt]) {
    const { code } = measure(readFileSync(file, 'utf8'));
    // A test of a protected file is all about it, so it may be longer than the file it tests.
    const cap = file.startsWith('test/') ? manifest.maxCodeLinesProtectedTest : manifest.maxCodeLinesProtected;
    assert.ok(code <= cap, `${file} has ${code} code lines, over the cap of ${cap}. Split what is not sensitive out of it.`);
  }
});

test('sensitive lines only ever go down: a new one in any automation file is a change to the manifest', () => {
  const seen = new Set();
  for (const file of automationFiles()) {
    if (file === SELF) continue;
    seen.add(file);
    const { sensitive } = measure(readFileSync(file, 'utf8'));
    const allowed = manifest.baseline[file] ?? 0;
    assert.ok(
      sensitive <= allowed,
      `${file} now holds ${sensitive} sensitive lines and may hold ${allowed}. Move the new line into a protected file, or raise the baseline in ${SELF}, which only the owner may change.`
    );
    assert.ok(
      sensitive >= allowed,
      `${file} holds ${sensitive} sensitive lines and the baseline says ${allowed}. Lower the baseline in ${SELF}, so room that was freed cannot be used for something new.`
    );
  }
  for (const file of Object.keys(manifest.baseline)) assert.ok(seen.has(file), `${file} is in the baseline but is not an automation file`);
});

test('the baseline never lists a file that holds nothing sensitive', () => {
  for (const [file, count] of Object.entries(manifest.baseline)) assert.ok(count > 0, `${file} has a baseline of ${count}`);
});
