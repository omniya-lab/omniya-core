import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as sre from 'speech-rule-engine/lib/sre.js';
import { buildSreMathmaps, SRE_MATHMAPS_SOURCE } from '../../scripts/build/build-sre-mathmaps.mjs';

// Issue #73: JAWS spelled out "n-th". The reader wants "enth". Same locale,
// domain and style as src/renderer/mathjax-config.js.
const dir = mkdtempSync(path.join(tmpdir(), 'omniya-mathmaps-'));
buildSreMathmaps(SRE_MATHMAPS_SOURCE, dir);
// A static import: loaded dynamically, SRE reads its rules before `json` applies.
const SRE = sre.default ?? sre;
await SRE.setupEngine({ locale: 'en', domain: 'clearspeak', style: 'default', json: dir });
test.after(() => rmSync(dir, { recursive: true, force: true }));

const say = (body) => SRE.toSpeech(`<math xmlns="http://www.w3.org/1998/Math/MathML">${body}</math>`);
const sup = (base, exp) => `<msup>${base}${exp}</msup>`;
const n = '<mi>n</mi>';
const two = '<mn>2</mn>';

test('an exponent that is n is said "enth"', () => {
  assert.equal(say(sup(two, n)), '2 to the enth power');
});

test('an exponent that ends in + n or - n says "enth" for the n', () => {
  assert.equal(say(sup(two, `<mrow><mi>x</mi><mo>+</mo>${n}</mrow>`)), '2 raised to the x plus enth power');
  assert.equal(say(sup(two, `<mrow><mi>x</mi><mo>-</mo>${n}</mrow>`)), '2 raised to the x minus enth power');
});

test('a negative n in an exponent says "enth" too', () => {
  assert.equal(say(sup(two, `<mrow><mo>-</mo>${n}</mrow>`)), '2 raised to the negative enth power');
  assert.equal(say(sup(two, '<mrow><mo>-</mo><mi>m</mi></mrow>')), '2 raised to the negative m power');
});

test('everything else keeps its usual wording', () => {
  assert.equal(say(sup(two, '<mi>m</mi>')), '2 to the m-th power');
  assert.equal(say(sup(two, `<mrow>${n}<mo>+</mo><mn>1</mn></mrow>`)), '2 raised to the n plus 1 power');
  assert.equal(say(sup(two, `<mrow><mn>2</mn>${n}</mrow>`)), '2 raised to the 2 n power');
  assert.equal(say(`<mrow><mi>x</mi><mo>+</mo>${n}</mrow>`), 'x plus n');
  assert.equal(say(n), 'n');
});
