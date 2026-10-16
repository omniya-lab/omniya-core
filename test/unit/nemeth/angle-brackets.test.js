import assert from 'node:assert/strict';
import test from 'node:test';

import { NemethUnsupportedError, parseNemeth } from '../../../src/domain/nemeth/index.js';

// Issue #68. BANA Rule 19 (Nemeth_2022.txt lines 9338-9342, symbol list lines
// 17974-17977) writes the left angle bracket as `..(` = dots 46, dots 46,
// dots 12356 and the right as `..)` = dots 46, dots 46, dots 23456.
test('BANA 19.1: ⟨a⟩ is read, as in Example 19-11', () => {
  assert.equal(parseNemeth('⠨⠨⠷⠁⠨⠨⠾').latex, '\\langle a\\rangle');
});

test('BANA 19.1: an unclosed angle bracket is refused, never guessed', () => {
  assert.throws(() => parseNemeth('⠨⠨⠷⠁'), NemethUnsupportedError);
});
