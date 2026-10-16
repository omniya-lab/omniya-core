import assert from 'node:assert/strict';
import test from 'node:test';

import { NemethUnsupportedError, UNSUPPORTED_MESSAGE, parseNemeth } from '../../../src/domain/nemeth/index.js';

/**
 * `userMessage` is what the composer shows when a commit is refused.
 *
 * The rule this encodes is narrower than the one it replaces. `errors.js` used
 * to say `detail` "must never reach an end user", for a reason that still
 * holds: an author who hits a construct this pipeline cannot read should be
 * told to write LaTeX, not handed a rule number to look up. But that rule was
 * written as though every refusal were such a construct, and the alpha log of
 * 2026-08-24 showed it is not -- a missing baseline indicator was reported as
 * a bug against the app, because the app said "not supported yet" about an
 * expression it parses correctly once the cell is there.
 *
 * So: a call site that can name what is missing in plain words sets
 * `userDetail`, and every site that cannot keeps the single sentence. There is
 * no error taxonomy and no mapping table -- a new `unsupported()` call site
 * without a `userDetail` behaves exactly as it does today, which is what keeps
 * this from rotting as the parser grows.
 */

const refusalFor = (cells) => {
  try {
    parseNemeth(cells);
  } catch (error) {
    return error;
  }
  return assert.fail(`expected ${cells} to be refused`);
};

test('a refusal with no plain-language reason keeps the single product sentence', () => {
  // `mathcat-rules:comma_78_6` -- an indicator governing a blank. Nothing here
  // can be said to an author without naming the rules it turns on.
  assert.equal(refusalFor('⠷⠭⠠⠀⠽⠾').userMessage, UNSUPPORTED_MESSAGE);
});

test('every refusal carries a userMessage, defaulting to the product sentence', () => {
  assert.equal(new NemethUnsupportedError({ detail: 'internal' }).userMessage, UNSUPPORTED_MESSAGE);
});

test('the Error message itself stays the product sentence, whatever the composer shows', () => {
  // Nothing downstream that reads `.message` changes behaviour.
  assert.equal(refusalFor('⠭⠘⠆⠷').message, UNSUPPORTED_MESSAGE);
});

// -- the reasons an author can act on -----------------------------------------

test('a superscript that never returns to the baseline names the missing cell', () => {
  const { userMessage } = refusalFor('⠭⠘⠆⠷');
  assert.match(userMessage, /superscript/i);
  assert.match(userMessage, /baseline indicator \(dot 5\)/i);
});

test('a subscript that never returns to the baseline names the missing cell', () => {
  const { userMessage } = refusalFor('⠭⠰⠁⠷');
  assert.match(userMessage, /subscript/i);
  assert.match(userMessage, /baseline indicator \(dot 5\)/i);
});

test('a radical with no termination indicator says so plainly', () => {
  assert.match(refusalFor('⠜⠭').userMessage, /radical.*termination indicator/i);
});

test('an unclosed grouping symbol names the symbol left open', () => {
  const { userMessage } = refusalFor('⠷⠭⠬⠼⠂');
  assert.match(userMessage, /grouping symbol/i);
  assert.match(userMessage, /\(/);
});

test('a numeral written without its numeric indicator says so plainly', () => {
  const { userMessage } = refusalFor('⠭⠀⠨⠅⠀⠒');
  assert.match(userMessage, /numeric indicator \(dots 3456\)/i);
});

// This one is a `userDetail` that was written and then taken back out, so the
// reason is pinned here rather than left to be rediscovered. `⠫` is the shape
// indicator: valid Nemeth this pipeline does not read, and the commonest
// unknown cell in the corpus at 31 cases. A message naming the cell and its
// dots ("check the key you pressed") therefore accuses an author of a typo
// they may not have made. Nothing at that call site can separate a wrong key
// from a construct we cannot read, so it must say neither.
test('a cell that starts no Nemeth symbol keeps the generic sentence, being ambiguous', () => {
  assert.equal(refusalFor('⠭⠬⠫').userMessage, UNSUPPORTED_MESSAGE);
});

// -- the constraint the old rule was protecting --------------------------------

test('no userMessage cites a rule number, which is what an author cannot look up', () => {
  const cells = ['⠭⠘⠆⠷', '⠭⠰⠁⠷', '⠜⠭', '⠷⠭⠬⠼⠂', '⠭⠀⠨⠅⠀⠒', '⠭⠬⠫', '⠷⠭⠠⠀⠽⠾'];
  for (const input of cells) {
    const { userMessage } = refusalFor(input);
    assert.doesNotMatch(userMessage, /BANA|Rule \d|\d+\.\d+/, `rule number leaked for ${input}: ${userMessage}`);
  }
});
