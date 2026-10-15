import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { rendererSandboxEnabled } from '../../src/main/renderer-sandbox.js';

test('the renderer sandbox is on by default', () => {
  assert.equal(rendererSandboxEnabled({}), true);
});

test('the renderer sandbox stays on when only the test data folder is set', () => {
  assert.equal(rendererSandboxEnabled({ OMNIYA_TEST_USER_DATA_DIR: '/tmp/x' }), true);
});

test('a stray switch cannot turn the sandbox off without a test data folder', () => {
  assert.equal(rendererSandboxEnabled({ OMNIYA_NO_RENDERER_SANDBOX: '1' }), true);
});

test('the sandbox turns off only with the switch AND a test data folder', () => {
  assert.equal(
    rendererSandboxEnabled({ OMNIYA_TEST_USER_DATA_DIR: '/tmp/x', OMNIYA_NO_RENDERER_SANDBOX: '1' }),
    false
  );
});

test('any other switch value keeps the sandbox on', () => {
  for (const value of ['0', 'true', 'yes', '']) {
    assert.equal(
      rendererSandboxEnabled({ OMNIYA_TEST_USER_DATA_DIR: '/tmp/x', OMNIYA_NO_RENDERER_SANDBOX: value }),
      true,
      `value ${JSON.stringify(value)}`
    );
  }
});

test('main.js takes both sandbox settings from the helper and keeps the other safety settings', () => {
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /rendererSandboxEnabled\(process\.env\)/);
  assert.match(main, /sandbox: useRendererSandbox/);
  assert.match(main, /if \(useRendererSandbox\) app\.enableSandbox\(\)/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.doesNotMatch(main, /sandbox: false/);
});
