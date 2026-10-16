import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNemeth } from '../../../src/domain/nemeth/index.js';

// Issue #73: a power ending an expression needs no baseline indicator. A script
// level stays in force until one ends it, so signs inside it are part of it.
test('a signed exponent is read as one script, with no baseline indicator', () => {
  assert.equal(parseNemeth('⠼⠆⠘⠤⠝').latex, '2^{-n}');
  assert.equal(parseNemeth('⠭⠘⠤⠼⠂').latex, 'x^{-1}');
});

test('a baseline indicator still ends the script', () => {
  assert.equal(parseNemeth('⠭⠘⠁⠐⠬⠃').latex, 'x^{a}+b');
  assert.equal(parseNemeth('⠼⠆⠘⠤⠝⠐⠬⠼⠂').latex, '2^{-n}+1');
});

// Issue #73, round 3: an operation sign after the first term of a script is
// still the script's, by the same rule. `x^2+1` takes the baseline indicator.
test('an operation sign after a script term stays in the script', () => {
  assert.equal(parseNemeth('⠼⠆⠘⠭⠬⠝').latex, '2^{x+n}');
  assert.equal(parseNemeth('⠼⠆⠘⠭⠤⠝').latex, '2^{x-n}');
  assert.equal(parseNemeth('⠭⠘⠆⠬⠼⠂').latex, 'x^{2+1}');
  assert.equal(parseNemeth('⠭⠰⠁⠬⠃').latex, 'x_{a+b}');
});
