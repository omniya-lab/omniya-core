// BANA 18.4.1 second sentence and 14.8.4: a function name that carries a
// superscript or subscript is still a function name, and the space that follows
// the script reinstates the level the name was written at. Issue #71.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNemeth } from '../../../src/domain/nemeth/index.js';

const latex = (cells) => parseNemeth(cells).latex;

test('cos squared x: the argument is on the baseline (Example 18-8 / 14-79)', () => {
  assert.equal(latex('⠉⠕⠎⠘⠆⠀⠭'), '\\cos^{2}x');
});

test('sin, tan and variable or larger exponents', () => {
  assert.equal(latex('⠎⠊⠝⠘⠆⠀⠭'), '\\sin^{2}x');
  assert.equal(latex('⠞⠁⠝⠘⠒⠀⠼⠒'), '\\tan^{3}3');
  assert.equal(latex('⠉⠕⠎⠘⠢⠀⠭'), '\\cos^{5}x');
  assert.equal(latex('⠎⠊⠝⠘⠝⠀⠭'), '\\sin^{n}x');
});

test('the space reinstates the superscript level of a scripted name (Example 14-80)', () => {
  assert.equal(latex('⠑⠘⠉⠕⠎⠘⠘⠆⠀⠭'), 'e^{\\cos^{2}x}');
});

test('an unmodified name still needs its space, and bare letters stay letters', () => {
  assert.equal(latex('⠉⠕⠎⠀⠭'), '\\cos x');
  assert.equal(latex('⠉⠕⠎⠭'), 'cosx');
});

test('a script with no space after it is not a function application', () => {
  assert.equal(latex('⠉⠕⠎⠘⠆'), 'cos^{2}');
});
