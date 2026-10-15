// Capture what a stranger would see of the app, for blind judging.
//
//   node scripts/dev/judge-capture.mjs <output directory>
//
// It launches the real app on a throwaway data folder holding a few realistic
// notes, and saves, for each state, a screenshot and the page's accessibility
// tree as text. It also records a keyboard tab walk. A judge who reads only these
// files knows nothing about how the app works, which is the point. See
// docs/judging.md.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

import { mathNode } from '../../src/domain/document.js';
import { convertLatexToMathML } from '../../src/main/mathml.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.resolve(process.argv[2] ?? 'judge-output');
const MAC = process.platform === 'darwin';
const INSERT = MAC ? 'Control+Equal' : 'Alt+Equal';

const text = (value) => ({ type: 'text', text: value });
const para = (...content) => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
async function eq(latex) {
  return mathNode({ mathml: await convertLatexToMathML(latex), source: latex, sourceKind: 'latex' });
}

async function fixture() {
  const quadratic = {
    type: 'doc',
    content: [
      para(text('Let '), await eq('a'), text(', '), await eq('b'), text(' and '), await eq('c'), text(' be real numbers with '), await eq('a \\neq 0'), text('. The roots of '), await eq('ax^2+bx+c=0'), text(' are')),
      para(await eq('x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}')),
      para(text('The part under the root, '), await eq('b^2-4ac'), text(', decides how many real roots there are. If it is positive there are two, if it is zero there is one, and if it is negative there are none.')),
      para(),
      para(text('To do: check the case '), await eq('a<0'), text(' with an example.'))
    ]
  };
  const shopping = { type: 'doc', content: [para(text('Ask about the lab meeting.')), para(text('Book the room for Thursday.'))] };
  const empty = { type: 'doc', content: [para()] };
  const day = 86_400_000;
  const note = (id, name, doc, ago = 0) => ({ id, name, doc, updatedAt: new Date(Date.now() - ago * day).toISOString() });
  return {
    schemaVersion: 3,
    activeNapkinId: 'n1',
    napkins: [
      note('n1', 'Quadratic formula', quadratic),
      note('n2', 'Meeting follow-ups', shopping, 2),
      note('n3', 'Reading list', { type: 'doc', content: [para(text('Papers to read this week.'))] }, 9),
      note('n4', 'Untitled note', empty, 30)
    ]
  };
}

async function accessibilityTree(page) {
  return page.locator('body').ariaSnapshot();
}

async function tabWalk(page, steps = 22) {
  const rows = [];
  for (let i = 1; i <= steps; i += 1) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    rows.push(await page.evaluate((n) => {
      const el = document.activeElement;
      if (!el || el === document.body) return `${n}. (nothing focused)`;
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"], svg').forEach((n) => n.remove());
      const name = el.getAttribute('aria-label') || el.labels?.[0]?.textContent || clone.textContent || '';
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const hint = el.getAttribute('aria-keyshortcuts');
      return `${n}. ${role}: "${name.trim().replace(/\s+/g, ' ').slice(0, 60)}"${hint ? ` (shortcut: ${hint})` : ''}`;
    }, i));
  }
  return rows.join('\n');
}

await mkdir(outDir, { recursive: true });
const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'omniya-judge-'));
await writeFile(path.join(dataDirectory, 'napkins.json'), JSON.stringify(await fixture()), 'utf8');

const env = { ...process.env, OMNIYA_HEADLESS: '1', OMNIYA_TEST_USER_DATA_DIR: dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], cwd: root, env });
const page = await app.firstWindow();
await page.locator('#editor-host [contenteditable="true"]').waitFor();
await page.locator('.math-node mjx-container').first().waitFor();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
await page.waitForTimeout(1500);

async function capture(name, note) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  await writeFile(path.join(outDir, `${name}.a11y.txt`), `${note}\n\n${await accessibilityTree(page)}\n`, 'utf8');
}

await capture('01-note-open', 'A note that is open. The caret is in the note.');

// The same note, read by someone who only uses the keyboard: where Tab goes.
await writeFile(path.join(outDir, '02-tab-order.txt'), `Pressing Tab from the note, in order:\n\n${await tabWalk(page)}\n`, 'utf8');
await page.locator('#editor-host [contenteditable="true"]').focus();

// A new note, empty.
await page.getByRole('button', { name: 'Untitled note' }).click();
await page.waitForTimeout(400);
await capture('03-empty-note', 'A new, empty note.');

// Writing, then starting an equation.
await page.locator('#editor-host [contenteditable="true"]').focus();
await page.keyboard.type('The area of a circle with radius r is ');
await page.keyboard.press(INSERT);
await page.locator('#composer-dock').waitFor({ state: 'visible' });
await page.getByLabel('LaTeX').check();
await page.locator('#composer-source').fill('\\pi r^2');
await page.waitForTimeout(300);
await capture('04-equation-panel', 'The person pressed the equation shortcut in the middle of a sentence. A panel opened and they typed an equation.');
await page.keyboard.press('Enter');
await page.locator('#composer-dock').waitFor({ state: 'hidden' });
await page.keyboard.type('.');
await page.waitForTimeout(1500);
await capture('05-after-insert', 'The equation was inserted into the sentence and the person typed a full stop.');

// Reading an equation by its parts.
await page.getByRole('button', { name: 'Quadratic formula' }).click();
await page.waitForTimeout(500);
await page.evaluate(() => {
  const editor = globalThis.__omniyaTesting.editor;
  let target = null;
  editor.view.state.doc.descendants((node, pos) => {
    if (!target && node.type.name === 'math' && node.attrs.source.startsWith('x=')) target = pos;
  });
  editor.selectMath(target);
  editor.focus();
});
await page.waitForTimeout(300);
await capture('06-equation-selected', 'One equation is selected as a unit.');

// The shortcuts dialog.
await page.getByRole('button', { name: 'Shortcuts' }).click();
await page.waitForTimeout(300);
await capture('07-shortcuts', 'The shortcuts dialog is open.');
await page.keyboard.press('Escape');
await page.locator('#editor-host [contenteditable="true"]').focus();

// Dark mode and a narrow window.
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await capture('08-dark', 'The same note with the computer set to dark mode.');
await page.emulateMedia({ colorScheme: 'light' });
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 820));
await page.waitForTimeout(500);
await capture('09-narrow', 'The window made narrow.');

await app.close();
console.log(`Saved to ${outDir}`);
