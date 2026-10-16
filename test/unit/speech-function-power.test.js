// Issue #71: how a function with a power is spoken. Reads the words the speech
// engine produces, with the same locale, domain and style as mathjax-config.js,
// from the rule files the app is built with.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { convertLatexToMathML } from '../../src/main/mathml.js';
import { writePatchedMathmaps } from '../../scripts/build/speech-maps.mjs';

const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'omniya-sre-')), 'mathmaps');
await writePatchedMathmaps(dir);
const sre = createRequire(import.meta.url)('speech-rule-engine');
await sre.setupEngine({ locale: 'en', domain: 'clearspeak', style: 'default', json: dir });
await sre.engineReady();

const say = async (latex) => sre.toSpeech(await convertLatexToMathML(latex));

test('squared and cubed functions say "of" before the argument', async () => {
  assert.equal(await say('\\cos^{2}x'), 'cosine squared of x');
  assert.equal(await say('\\tan^{3}3'), 'tangent cubed of 3');
});

test('other powers say "to the" and keep the function first', async () => {
  assert.equal(await say('\\cos^{5}x'), 'cosine to the fifth of x');
});

test('the letter n is spoken as "enth"', async () => {
  assert.equal(await say('\\sin^{n}x'), 'sine to the enth of x');
});

test('things the request does not cover read as before', async () => {
  assert.equal(await say('\\cos x'), 'cosine x');
  assert.equal(await say('x^{2}'), 'x squared');
  assert.equal(await say('x^{n}'), 'x to the n-th power');
});
