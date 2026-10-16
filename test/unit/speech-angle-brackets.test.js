// Issue #68: the two Nemeth angle brackets (BANA 19.1) are read "open bracket" and
// "close bracket", the contributor's words. Reads the words the speech engine
// produces, with the same locale, domain and style as mathjax-config.js, from the
// rule files the app is built with. The Nemeth cells go through the real parser.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseNemeth } from '../../src/domain/nemeth/index.js';
import { convertLatexToMathML } from '../../src/main/mathml.js';
import { writePatchedMathmaps } from '../../scripts/build/speech-maps.mjs';

const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'omniya-sre-')), 'mathmaps');
await writePatchedMathmaps(dir);
const sre = createRequire(import.meta.url)('speech-rule-engine');
await sre.setupEngine({ locale: 'en', domain: 'clearspeak', style: 'default', json: dir });
await sre.engineReady();

const say = async (latex) => sre.toSpeech(await convertLatexToMathML(latex));
const sayNemeth = (cells) => say(parseNemeth(cells).latex);

test('the angle brackets as the contributor wrote them: dots 46,46,12356 opens and dots 46,46,23456 closes', async () => {
  assert.equal(await sayNemeth('⠨⠨⠷⠁⠨⠨⠾'), 'open bracket a close bracket');
});

test('an angle bracket pair with more inside, or a power after it, keeps its words', async () => {
  assert.equal(await say('\\langle x+y\\rangle'), 'open bracket x plus y close bracket');
  assert.equal(await say('\\langle a,b\\rangle+1'), 'open bracket a comma b close bracket plus 1');
  assert.equal(await say('\\langle x\\rangle^{2}'), 'open bracket x close bracket squared');
});

test('other brackets and the function powers of issue #71 read as before', async () => {
  assert.equal(await say('\\cos^{2}x'), 'cosine squared of x');
  assert.equal(await say('x^{2}'), 'x squared');
});
