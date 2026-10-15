// Try to break r, a and o (replace, append, prepend) while reading an equation by parts.
//
//   node scripts/dev/fuzz-explorer-edits.mjs [seed] [rounds]
//
// The check is one rule, not a list of cases: after ANY edit, the equation must
// be exactly what a fresh parse of the same expression gives. The explorer's
// boxes are worked out from that MathML alone, so if the MathML is the same the
// boxes are the same. The live semantic tree (what the explorer walks) is read
// too and shown in the report, so a wrong box can be seen as well as proved.
//
// For every edit this compares
//   the edited equation  (what is stored and drawn after the edit)
//   a fresh drawing of the equation's own source (what typing it from scratch gives)
// and reports any pair whose trees differ, any edit that kept no source (it fell
// back to splicing), and any crash. Exit code 1 if anything was found.
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { canonicalizeMathML, parseMathML, serializeMathML, structuralEquivalent } from '../../src/domain/math-tree.js';
import { convertLatexToMathML } from '../../src/main/mathml.js';
import {
  DOC_END, chooseMethod, enterExplorer, focusDocument, getMathNodes, insertEquation, launchApp, press, settle
} from '../../test/e2e/launch-electron.js';

const seed = Number(process.argv[2] ?? Date.now() % 100000);
const rounds = Number(process.argv[3] ?? 12);

// A small seeded random number generator, so a failing run can be repeated.
let state = seed >>> 0 || 1;
const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
const pick = (list) => list[Math.floor(random() * list.length)];

const STARTS = [
  'x+y', 'x^2+y^2=z^2', '\\frac{a+b}{c}', '\\sqrt{x+1}', '(a+b)(c+d)', 'a_1+a_2+a_3',
  '\\sum_{i=1}^{n} i', '\\left(x+1\\right)^2', 'x=-b', '2y', '\\frac{1}{2}+\\frac{1}{3}',
  '|x|', 'f(x)=x^2', 'a<b<c', '\\int_0^1 x\\,dx', 'x^{y^z}', '-x', 'a\\cdot b-c'
];
// Ordinary and odd things a person might type into the field.
const FRAGMENTS = [
  '-y', '+1', '=', '-', '--', '+-', '(', ')', '(1)', '^2', '_k', 'x^2', 'x_{i}', '\\frac{1}{2}',
  '\\sqrt{2}', '\\pm', 'y z', '1.5', '\\alpha', '\\cdot', '\\times 3', '<', '\\leq', '!', ',', '|',
  '{', '}', '\\text{if}', '2y', '-(', '\\frac{', '^', '  ', 'a b c d', '\\infty', '-1', '=-', '\\\\'
];
const MOVES = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];

/** The tree the explorer walks, as one string, for an equation drawn in `holder`. */
async function treeOf(page, holderSelector, index) {
  return page.evaluate(async ({ selector, i }) => {
    const holder = document.querySelectorAll(selector)[i];
    const read = () => {
      const math = holder?.querySelector('mjx-assistive-mml math');
      if (!math || !math.querySelector('[data-semantic-id]')) return null;
      const sig = (el) => {
        const kids = [...el.children];
        return kids.length
          ? `${el.getAttribute('data-semantic-type') ?? el.localName}(${kids.map(sig).join(' ')})`
          : `${el.getAttribute('data-semantic-type') ?? el.localName}:${el.textContent}`;
      };
      return sig(math);
    };
    let last = null;
    let steady = 0;
    for (let n = 0; n < 80 && steady < 3; n += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const now = read();
      steady = now && now === last ? steady + 1 : 0;
      last = now;
    }
    return last;
  }, { selector: holderSelector, i: index });
}

const findings = [];
const log = (line) => console.log(line);

const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'fuzz-'));
const { electronApp, page } = await launchApp({ dataDirectory });
page.on('pageerror', (error) => findings.push({ kind: 'page error', detail: error.message }));
log(`seed ${seed}, ${rounds} rounds`);

let editsTried = 0;
try {
  for (let round = 0; round < rounds; round += 1) {
    const start = pick(STARTS);
    // A selected equation would be replaced by the next one. Go to the end first.
    await focusDocument(page);
    await page.keyboard.press(DOC_END);
    await insertEquation(page, { method: 'latex', source: start });
    const index = (await page.locator('#editor-host .math-node').count()) - 1;
    await enterExplorer(page, index);
    await settle(page, 400);
    await press(page, 'ArrowDown');

    for (let step = 0; step < 3; step += 1) {
      // Wander to some part of the equation.
      for (let m = Math.floor(random() * 6); m > 0; m -= 1) await press(page, pick(MOVES));
      await settle(page, 150);
      const op = pick(['r', 'a', 'o']);
      const fragment = pick(FRAGMENTS);
      await page.keyboard.press(op);
      const opened = await page.locator('#composer-dock').waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
      if (!opened) {
        findings.push({ kind: `${op} did nothing where the reader stood`, detail: `${start}  [${op}]  step ${step + 1}  seed ${seed}` });
        continue;
      }
      await chooseMethod(page, 'latex');
      await page.locator('#composer-source').fill(fragment);
      await page.keyboard.press('Enter');
      await settle(page, 500);
      const stillOpen = await page.locator('#composer-dock').isVisible();
      if (stillOpen) { await page.keyboard.press('Escape'); await settle(page, 300); continue; }
      editsTried += 1;

      const node = (await getMathNodes(page))[index];
      const label = `${start}  [${op} ${JSON.stringify(fragment)}]  step ${step + 1}  seed ${seed}`;
      if (!node.attrs.source) {
        findings.push({ kind: 'no source kept (fell back to splicing)', detail: label });
        continue;
      }
      const stored = parseMathML(node.attrs.mathml);
      const fresh = parseMathML(canonicalizeMathML(await convertLatexToMathML(node.attrs.source)));
      if (!structuralEquivalent(stored, fresh)) {
        const edited = await treeOf(page, '#editor-host .math-node .math-render', index);
        findings.push({
          kind: 'is not what a fresh parse gives',
          detail: `${label}\n    source: ${node.attrs.source}\n    stored: ${serializeMathML(stored)}\n    fresh:  ${serializeMathML(fresh)}\n    explorer tree: ${edited}`
        });
      }
      // Back in the equation for the next edit.
      const inEquation = await page.evaluate((i) => {
        const nodes = document.querySelectorAll('#editor-host .math-node');
        return Boolean(document.activeElement && nodes[i]?.contains(document.activeElement));
      }, index);
      if (!inEquation) break;
    }
    await page.keyboard.press('Escape');
    await settle(page, 200);
  }
} catch (error) {
  findings.push({ kind: 'crash', detail: error.stack ?? String(error) });
}
await electronApp.close().catch(() => {});

log(`${editsTried} edits checked`);
if (findings.length === 0) {
  log('no differences found');
} else {
  for (const finding of findings) log(`\n${finding.kind}\n  ${finding.detail}`);
  process.exitCode = 1;
}
