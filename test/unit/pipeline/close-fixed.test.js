import test from 'node:test';
import assert from 'node:assert/strict';

import { issueToClose } from '../../../scripts/ci/close-fixed.mjs';

const ok = { merged: true, base: 'testing', headRef: 'claude/fix-4-x', cross: false, body: 'Gates run.\n\nFixes #4' };

test('a merged fix on the pipeline branch closes the issue it names', () => {
  assert.equal(issueToClose(ok), 4);
  assert.equal(issueToClose({ ...ok, body: 'x\r\nFixes #12\r\n' }), 12);
});

test('anything else closes nothing', () => {
  assert.equal(issueToClose({ ...ok, merged: false }), null);
  assert.equal(issueToClose({ ...ok, base: 'main' }), null);
  assert.equal(issueToClose({ ...ok, cross: true }), null);
  assert.equal(issueToClose({ ...ok, headRef: 'feature/x' }), null);
  assert.equal(issueToClose({ ...ok, body: 'Fixes #4 and more text' }), null);
  assert.equal(issueToClose({ ...ok, body: 'See Fixes #4\nthen words' }), null);
  assert.equal(issueToClose({ ...ok, body: '' }), null);
});
