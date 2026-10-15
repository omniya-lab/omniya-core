import assert from 'node:assert/strict';
import test from 'node:test';

import { sandboxSwitch } from '../../src/main/renderer-sandbox.js';

test('the switch is on only for on', () => {
  assert.equal(sandboxSwitch('on'), true);
  assert.equal(sandboxSwitch('off'), false);
});
