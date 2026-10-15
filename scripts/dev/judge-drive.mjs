// A small driver for judging the app by operating it, with nothing to read about how it works.
//
//   import { open } from './judge-drive.mjs';
//   const app = await open();
//   await app.insert('x+y');                 // type an equation into the note
//   console.log(await app.boxes(0));         // every stop the reader makes in equation 0, in order
//   await app.edit(0, ['ArrowDown', 'ArrowRight'], 'r', '-y');   // walk, press r/a/o, type, Enter
//   console.log(await app.equation(0));      // what it says now, and the source kept for it
//   await app.close();
//
// `boxes` is what a person sees as the reader moves: the highlighted box at each stop
// (the symbols inside it) and what the reader says for it.
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DOC_END, chooseMethod, enterExplorer, focusDocument, getMathNodes, insertEquation, launchApp, press, settle
} from '../../test/e2e/launch-electron.js';

export async function open() {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'judge-'));
  const { electronApp, page } = await launchApp({ dataDirectory });
  const count = () => page.locator('#editor-host .math-node').count();

  const stop = () => page.evaluate(() => {
    const holder = document.activeElement?.closest?.('.math-render') ?? document.querySelector('.math-node .math-render');
    const item = globalThis.MathJax.startup.document.getMathItemsWithin(holder)[0];
    const current = item.explorers.speech.current;
    const id = current?.getAttribute?.('data-semantic-id');
    const node = holder.querySelector('mjx-assistive-mml')?.querySelector(`[data-semantic-id="${id}"]`);
    return { says: current?.getAttribute?.('data-semantic-speech-none') ?? null, box: node?.textContent ?? null };
  });

  const api = {
    page,
    /** Put a new equation at the end of the note and return its number. */
    async insert(latex) {
      await focusDocument(page);
      await page.keyboard.press(DOC_END);
      await insertEquation(page, { method: 'latex', source: latex });
      return (await count()) - 1;
    },
    /** Every stop the reader makes in equation `index`, walking Down once then Right to the end. */
    async boxes(index) {
      await enterExplorer(page, index);
      await settle(page, 600);
      const stops = [await stop()];
      await press(page, 'ArrowDown');
      await settle(page, 250);
      let last = null;
      for (let step = 0; step < 40; step += 1) {
        const here = await stop();
        const key = JSON.stringify(here);
        if (key === last) break;
        stops.push(here);
        last = key;
        await press(page, 'ArrowRight');
        await settle(page, 200);
      }
      await page.keyboard.press('Escape');
      await settle(page, 300);
      return stops;
    },
    /**
     * Read equation `index` by parts, press each of `walk` (arrow keys), then `op`
     * (r replace, a append after, o insert before), type `text` as LaTeX, and press Enter.
     * Returns whether the edit went in, and what the reader is on afterwards.
     */
    async edit(index, walk, op, text) {
      await enterExplorer(page, index);
      await settle(page, 500);
      for (const key of walk) { await press(page, key); await settle(page, 150); }
      const before = await stop();
      await page.keyboard.press(op);
      const opened = await page.locator('#composer-dock').waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
      if (!opened) return { went: false, reason: 'the field did not open', before };
      await chooseMethod(page, 'latex');
      await page.locator('#composer-source').fill(text);
      await page.keyboard.press('Enter');
      await settle(page, 600);
      if (await page.locator('#composer-dock').isVisible()) {
        const message = (await page.locator('#composer-error').textContent())?.trim();
        await page.keyboard.press('Escape');
        await settle(page, 300);
        return { went: false, reason: message || 'the field stayed open', before };
      }
      await settle(page, 600);
      const after = await stop().catch(() => null);
      await page.keyboard.press('Escape');
      await settle(page, 300);
      return { went: true, before, after };
    },
    /** What equation `index` says as a whole, and the LaTeX kept for it. */
    async equation(index) {
      const node = (await getMathNodes(page))[index];
      const says = await page.evaluate((i) => document.querySelectorAll('#editor-host .math-node')[i]?.getAttribute('aria-label'), index);
      return { says, source: node?.attrs.source ?? '' };
    },
    async screenshot(file, index) {
      const target = page.locator('#editor-host .math-node').nth(index);
      await target.screenshot({ path: file });
    },
    async close() { await electronApp.close().catch(() => {}); }
  };
  return api;
}
