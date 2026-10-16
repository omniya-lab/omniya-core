import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  chooseMethod, enterExplorer, focusDocument, getMathNodes, insertEquation, launchApp,
  mathNodeLocator, openEquationDock
} from './launch-electron.js';

const FRACTION_AND_ROOT = '\\frac{a}{b}+\\sqrt{x}';

async function start(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'omniya-e2e-'));
  const app = await launchApp({ dataDirectory });
  t.after(() => app.electronApp.close().catch(() => {}));
  return app;
}

const box = (page) => page.locator('#equation-preview-box');
const drawing = (page) => page.locator('#equation-preview mjx-container');
const spoken = (page) => page.locator('#equation-preview-text');
const field = (page) => page.locator('#composer-source');

/** Wait for the preview to be drawn and read out. Never a fixed sleep. */
async function waitForPreview(page, reads) {
  await drawing(page).waitFor({ timeout: 15_000 });
  await page.waitForFunction((expected) => {
    const text = document.querySelector('#equation-preview-text')?.textContent ?? '';
    return expected ? text === expected : text.startsWith('Reads as: ');
  }, reads, { timeout: 15_000 });
}

/** Wait until the preview is gone, and stay gone past the 350 ms delay. */
async function expectNoPreview(page) {
  await page.waitForFunction(() => {
    const boxEl = document.querySelector('#equation-preview-box');
    return boxEl.hidden
      && !document.querySelector('#equation-preview mjx-container')
      && document.querySelector('#equation-preview-text').textContent === '';
  }, null, { timeout: 15_000 });
}

/** Give a pending preview time to appear, if one is wrongly going to. */
const pastTheDelay = (page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 900)));

test('a LaTeX draft is drawn after a short wait and read as words', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  assert.equal(await box(page).isHidden(), true);
  await field(page).fill(FRACTION_AND_ROOT);
  await waitForPreview(page, 'Reads as: a over b plus the square root of x');
  assert.equal(await box(page).isVisible(), true);
  assert.equal(await drawing(page).count(), 1);
});

test('the preview is hidden from readers, inert, and not a live region', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill('x^2');
  await waitForPreview(page);
  assert.equal(await box(page).getAttribute('aria-hidden'), 'true');
  assert.equal(await box(page).evaluate((el) => el.inert), true);
  assert.equal(await spoken(page).getAttribute('aria-live'), null);
  assert.equal(await spoken(page).getAttribute('role'), null);
  assert.equal(await spoken(page).evaluate((el) => el.closest('[aria-live]')), null);
  assert.equal(await spoken(page).evaluate((el) => el.classList.contains('sr-only')), true);
});

test('the field is described by the spoken form', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  const ids = (await field(page).getAttribute('aria-describedby')).split(/\s+/);
  assert.ok(ids.includes('equation-preview-text'));
  await field(page).fill('x^2');
  await waitForPreview(page, 'Reads as: x squared');
  const description = await page.evaluate(() => {
    const el = document.querySelector('#composer-source');
    return el.getAttribute('aria-describedby').split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  });
  assert.match(description, /Reads as: x squared/);
});

test('nothing shows before the delay has passed', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill('x^2');
  // The page is checked in the same turn as the input: the draw is still ahead.
  const early = await page.evaluate(() => ({
    drawn: document.querySelector('#equation-preview mjx-container') !== null,
    hidden: document.querySelector('#equation-preview-box').hidden
  }));
  assert.deepEqual(early, { drawn: false, hidden: true });
  await waitForPreview(page);
});

test('an unfinished draft shows nothing, and no error', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill('\\frac{a');
  await pastTheDelay(page);
  await expectNoPreview(page);
  assert.equal(await box(page).isHidden(), true);
  assert.equal(await page.locator('#composer-error').isHidden(), true);

  // Finishing the draft brings the preview.
  await field(page).fill('\\frac{a}{b}');
  await waitForPreview(page, 'Reads as: a over b');
});

test('a draft that becomes unfinished takes the old preview away', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill('\\frac{a}{b}');
  await waitForPreview(page);
  await field(page).fill('\\frac{a');
  await page.waitForFunction(() => document.querySelector('#equation-preview-box').hidden
    && document.querySelector('#equation-preview-text').textContent === '', null, { timeout: 15_000 });
});

test('clearing the field clears the preview', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill('x^2');
  await waitForPreview(page);
  await field(page).fill('');
  await expectNoPreview(page);
  await pastTheDelay(page);
  assert.equal(await box(page).isHidden(), true);
  assert.equal(await spoken(page).textContent(), '');
});

test('switching method clears the preview', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill('x^2');
  await waitForPreview(page);
  // The app refuses a method change while the draft has content, so empty it first.
  await field(page).fill('');
  await field(page).press('Control+e');
  await page.waitForFunction(
    () => document.querySelector('#replacement-method input[value="nemeth"]').checked);
  await expectNoPreview(page);
  await pastTheDelay(page);
  assert.equal(await box(page).isHidden(), true);
});

test('cancelling clears the preview, and a reopened panel starts without one', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill('x^2');
  await waitForPreview(page);
  await page.keyboard.press('Escape');
  await page.locator('#composer-dock').waitFor({ state: 'hidden' });
  await expectNoPreview(page);
  await openEquationDock(page, 'latex');
  assert.equal(await box(page).isHidden(), true);
  assert.equal(await spoken(page).textContent(), '');
  await pastTheDelay(page);
  assert.equal(await drawing(page).count(), 0);
});

test('inserting clears the preview, and a late draw does not bring it back', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill('x^2');
  await waitForPreview(page);
  await page.keyboard.press('Enter');
  await page.locator('#composer-dock').waitFor({ state: 'hidden' });
  await mathNodeLocator(page).first().locator('mjx-container').waitFor({ timeout: 30_000 });
  await expectNoPreview(page);
  await pastTheDelay(page);
  assert.equal(await box(page).isHidden(), true);
  assert.equal(await page.locator('#equation-preview mjx-container').count(), 0);
});

test('submitting before the delay leaves no preview behind', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill('y^3');
  await page.keyboard.press('Enter');
  await page.locator('#composer-dock').waitFor({ state: 'hidden' });
  await pastTheDelay(page);
  await expectNoPreview(page);
});

test('a Nemeth fraction typed as computer braille previews as a fraction', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'nemeth');
  await page.keyboard.type('?a/b#');
  await waitForPreview(page, 'Reads as: a over b');
  assert.equal(await box(page).isVisible(), true);
  assert.equal(await drawing(page).count(), 1);
});

test('editing by parts previews just the new part', { timeout: 90_000 }, async (t) => {
  const { page } = await start(t);
  await insertEquation(page, { method: 'latex', source: 'a+b' });
  await enterExplorer(page, 0);
  await page.keyboard.press('r');
  await page.locator('#composer-dock').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.activeElement?.id === 'composer-source');
  await chooseMethod(page, 'latex');
  await field(page).fill('c');
  await waitForPreview(page, 'Reads as: c');

  // The equation itself is not changed by a preview.
  const [{ attrs }] = await getMathNodes(page);
  assert.match(attrs.mathml, /a<\/mi>/);
  assert.match(attrs.mathml, /b<\/mi>/);
});

test('the preview adds no tab stop: Tab from the field reaches Insert', { timeout: 60_000 }, async (t) => {
  const { page } = await start(t);
  await focusDocument(page);
  await openEquationDock(page, 'latex');
  await field(page).fill(FRACTION_AND_ROOT);
  await waitForPreview(page);

  const inside = await page.evaluate(() => [...document.querySelectorAll(
    '#equation-preview-box a[href], #equation-preview-box button, #equation-preview-box input, '
    + '#equation-preview-box select, #equation-preview-box textarea, #equation-preview-box [tabindex]'
  )].filter((el) => el.tabIndex >= 0 && !el.closest('[inert]')).length);
  assert.equal(inside, 0);

  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.id === 'composer-submit');
  assert.equal(await page.evaluate(
    () => document.activeElement.closest('#equation-preview-box') === null), true);

  // And backwards: the field is the stop before Insert, with nothing in between.
  await page.keyboard.press('Shift+Tab');
  await page.waitForFunction(() => document.activeElement?.id === 'composer-source');
});

// Issue #71. The words come from patched speech rules the app loads at start
// (src/renderer/speech-rules.js), so this is the check that the app really uses
// them and not only the engine in a unit test.
for (const [source, reads] of [
  ['\\cos^{2}x', 'cosine squared of x'],
  ['\\tan^{3}3', 'tangent cubed of 3'],
  ['\\cos^{5}x', 'cosine to the fifth of x'],
  ['\\sin^{n}x', 'sine to the enth of x']
]) {
  test(`a function with a power is read "${reads}"`, { timeout: 60_000 }, async (t) => {
    const { page } = await start(t);
    await focusDocument(page);
    await openEquationDock(page, 'latex');
    await field(page).fill(source);
    await waitForPreview(page, `Reads as: ${reads}`);
  });
}
