import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCodeowners, renderContributors } from '../../../scripts/ci/render-identity.mjs';
import { parseAllowlist } from '../../../scripts/ci/allowlist.mjs';

test('the owner defaults leave both files alone', () => {
  const c = '# x\n* @ParkingSoman\n';
  assert.equal(renderCodeowners(c, 'ParkingSoman'), c);
});

test('another owner replaces the owner everywhere that cannot read a variable', () => {
  assert.equal(renderCodeowners('# x\n* @ParkingSoman\n', 'lab-owner'), '# x\n* @lab-owner\n');
  const out = renderContributors('contributors:\n  - HayleeRM\n  - ParkingSoman\n', 'lab-owner');
  assert.deepEqual(parseAllowlist(out), ['HayleeRM', 'lab-owner']);
});
