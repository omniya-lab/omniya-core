import assert from 'node:assert/strict';
import test from 'node:test';

import { computeTestingVersion } from '../../scripts/build/bump-testing-version.mjs';

test('computes a monotonic alpha version from CI env', () => {
  const version = computeTestingVersion({ GITHUB_RUN_NUMBER: '42', GITHUB_SHA: 'ab12cd3ef456' });
  assert.equal(version, '0.1.0-alpha.42+ab12cd3');
});

test('throws without GITHUB_RUN_NUMBER', () => {
  assert.throws(() => computeTestingVersion({ GITHUB_SHA: 'ab12cd3ef456' }));
});

test('throws without GITHUB_SHA', () => {
  assert.throws(() => computeTestingVersion({ GITHUB_RUN_NUMBER: '42' }));
});
