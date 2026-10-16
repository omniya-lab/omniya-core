import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

import {
  goToDocStart,
  enterExplorer,
  explorerSpeech,
  getDoc,
  insertEquation,
  launchApp,
  paragraphTexts,
  press,
  projectRoot
} from './launch-electron.js';

// What the editor exposes to a reader, and how the caret treats an equation.
// "Solve [x squared] for x." is typed once, then each test walks it.
// Positions: 1 is before "S". "Solve " is 6 characters, so 7 is just before the
// equation and 8 is just after it.

async function startWithSentence(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'omniya-e2e-'));
  const session = await launchApp({ dataDirectory });
  t.after(() => session.electronApp.close().catch(() => {}));
  const { page } = session;
  await page.keyboard.type('Solve ');
  await insertEquation(page, { source: 'x^2' });
  await page.keyboard.type(' for x.');
  // The name comes from MathJax speech, which arrives just after drawing.
  await page.waitForFunction(() => document.querySelector('.math-node')?.getAttribute('aria-label') === 'x squared');
  assert.deepEqual(await paragraphTexts(page), ['Solve [math] for x.']);
  return session;
}

const selection = (page) => page.evaluate(() => {
  const { from, to, node } = globalThis.__omniyaTesting.editor.view.state.selection;
  return { from, to, node: node?.type.name ?? null };
});

test('arrow keys select an equation first, then step past it', { timeout: 90_000 }, async (t) => {
  const { page } = await startWithSentence(t);
  await goToDocStart(page);
  await press(page, 'ArrowRight', 6);
  assert.deepEqual(await selection(page), { from: 9, to: 9, node: null }, 'caret before the equation');
  await press(page, 'ArrowRight');
  assert.deepEqual(await selection(page), { from: 9, to: 10, node: 'math' }, 'the first press selects it');
  await press(page, 'ArrowRight');
  assert.deepEqual(await selection(page), { from: 10, to: 10, node: null }, 'the second press passes it');
  await press(page, 'ArrowLeft');
  assert.deepEqual(await selection(page), { from: 9, to: 10, node: 'math' }, 'going back selects it again');
});

test('the equation is one named image, so a reader says it once', { timeout: 90_000 }, async (t) => {
  const { electronApp, page } = await startWithSentence(t);
  const math = page.locator('#editor-host .math-node');
  assert.equal(await math.getAttribute('role'), 'img');
  assert.equal(await math.getAttribute('aria-label'), 'x squared');

  // A virtual screen reader walks the accessibility tree. It is not a real
  // reader: it shows that the tree has a role and a name, not what NVDA,
  // JAWS or VoiceOver say. test/screen-reader/ covers those in CI.
  const bundle = await build({
    stdin: {
      contents: "import { virtual } from '@guidepup/virtual-screen-reader'; globalThis.__vsr = virtual;",
      resolveDir: projectRoot
    },
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'silent'
  });
  // executeJavaScript is not subject to the page's script-src policy.
  await electronApp.evaluate(
    ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source),
    bundle.outputFiles[0].text
  );
  const spoken = await page.evaluate(async () => {
    const vsr = globalThis.__vsr;
    await vsr.start({ container: document.querySelector('#editor-host') });
    for (let i = 0; i < 12; i += 1) await vsr.next();
    const log = await vsr.spokenPhraseLog();
    await vsr.stop();
    return log;
  });
  assert.ok(spoken.some((phrase) => /Solve/.test(phrase)), 'the paragraph text is spoken');
  assert.ok(spoken.some((phrase) => /image, x squared/.test(phrase)), 'the equation is spoken by its name');
  assert.equal(spoken.filter((phrase) => phrase === 'x' || phrase === '2').length, 0, 'the parts are not read a second time');
});

test('the explorer inside an equation keeps focus and its keys', { timeout: 90_000 }, async (t) => {
  const { page } = await startWithSentence(t);
  await goToDocStart(page);
  await press(page, 'ArrowRight', 7);
  assert.deepEqual(await selection(page), { from: 9, to: 10, node: 'math' });
  const docBefore = await getDoc(page);

  await enterExplorer(page, 0);
  const start = await explorerSpeech(page);
  // Down enters the structure, Right moves along it. These belong to MathJax.
  await press(page, 'ArrowDown');
  const afterDown = await explorerSpeech(page);
  await press(page, 'ArrowRight');
  const afterRight = await explorerSpeech(page);
  assert.equal(
    await page.evaluate(() => Boolean(document.activeElement?.closest('.math-node'))),
    true,
    'focus never left the equation'
  );
  assert.notEqual(afterRight, start, `the explorer moved (${start} -> ${afterDown} -> ${afterRight})`);
  assert.deepEqual(await getDoc(page), docBefore, 'no key reached the text');

  // Escape returns to the document with the equation still selected.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.closest('#editor-host [contenteditable="true"]')
    && !document.activeElement.closest('.math-node'));
  assert.deepEqual(await selection(page), { from: 9, to: 10, node: 'math' });
  assert.equal(await page.locator('#editor-host .math-node').getAttribute('role'), 'img', 'the name returns');
});

// Issue #73: JAWS spelled "n-th" letter by letter. An exponent that is, or ends
// in, the letter n is said "enth". The app is the truth here, not the unit test.
test('an exponent of n is named "enth", as the contributor asked', { timeout: 90_000 }, async (t) => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'omniya-e2e-'));
  const session = await launchApp({ dataDirectory });
  t.after(() => session.electronApp.close().catch(() => {}));
  const { page } = session;
  await insertEquation(page, { source: '2^n' });
  await page.keyboard.type(' ');
  await insertEquation(page, { source: '2^{x+n}' });
  await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll('.math-node')].map((n) => n.getAttribute('aria-label'));
    return labels.length === 2 && labels.every(Boolean);
  }, null, { timeout: 30_000 });
  const labels = await page.evaluate(() => [...document.querySelectorAll('.math-node')].map((n) => n.getAttribute('aria-label')));
  assert.deepEqual(labels, ['2 to the enth power', '2 raised to the x plus enth power']);
});
