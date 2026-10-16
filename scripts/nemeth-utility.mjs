#!/usr/bin/env node
// The utility gate: measures whether src/domain/nemeth can write the
// mathematics a person actually does, and writes
// docs/nemeth-v2/utility-inventory.md.
//
// This is the SECOND gate, and it exists because the first one could not
// answer this question. `scripts/nemeth-coverage.mjs` grades the parser
// against 613 externally-verified corpus cases; that measures CORRECTNESS
// and it is the right instrument for it. But the corpus is MathCAT's and
// SRE's rule-CONFORMANCE suites -- built to exercise each rule of the Code
// roughly once -- so frequency in it measures how many rules touch a symbol,
// never how often anyone uses one. The two came apart badly: at PASS 177 /
// ERROR 0 over those 613 cases the parser still could not write `a - b`,
// because the minus sign ranked about fifth by corpus refusals and kept
// being deferred.
//
// So: the corpus grades, this inventory plans, and the two must not be
// swapped again. Every operation below is one a student writes, listed
// because they write it and not because the corpus counts it.
//
// Two tiers, and they are gated differently on purpose:
//
//   core   Must be 100% green. `test/unit/nemeth/utility-gate.test.js` FAILS
//          THE BUILD when one is not, and no task may add a long-tail symbol
//          family while a core operation is missing.
//   tail   Measured and reported, never blocking. Progress is visible in the
//          count without a partially-built feature holding up the suite.
//
// Every `ascii` below is verified against the BANA tables in
// test/corpus/sources/Nemeth_2022.txt at the `source` line cited on the row,
// and written in the Code's own Braille-ASCII notation so it can be checked
// against that line by eye. A gate built on a wrong expectation is worse
// than no gate: several entries in the hand-written predecessor of this file
// turned out to be encoding mistakes rather than parser gaps, so the cells
// are data with a citation, not a recollection.
//
// No network. The output is deterministic, so re-running against an
// unchanged parser reproduces the file byte for byte.
//
// Usage: node scripts/nemeth-utility.mjs

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { asciiToCells } from '../src/domain/nemeth/braille-ascii.js';
import { NemethUnsupportedError, parseNemeth } from '../src/domain/nemeth/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(projectRoot, 'docs', 'nemeth-v2', 'utility-inventory.md');
const sourceName = 'test/corpus/sources/Nemeth_2022.txt';

/**
 * The inventory. `ascii` is the input in Braille-ASCII, `latex` the answer the
 * parser must produce for it, `banaRef` the rule and `source` the line(s) in
 * the extracted BANA text where that rule or symbol table row is written.
 */
export const OPERATIONS = Object.freeze([
  // -- Arithmetic ------------------------------------------------------------
  { id: 'addition', area: 'Arithmetic', tier: 'core', label: 'addition', ascii: 'a+b', latex: 'a+b', banaRef: '20', source: '9888-9889 (Plus, Regular)' },
  { id: 'subtraction', area: 'Arithmetic', tier: 'core', label: 'subtraction', ascii: 'a-b', latex: 'a-b', banaRef: '20', source: '9868-9869 (Minus, Regular)' },
  { id: 'multiplication-cross', area: 'Arithmetic', tier: 'core', label: 'multiplication, cross', ascii: 'a@*b', latex: 'a×b', banaRef: '20', source: '9884 (Cross, Cartesian product)' },
  { id: 'multiplication-dot', area: 'Arithmetic', tier: 'core', label: 'multiplication, dot', ascii: 'a*b', latex: 'a⋅b', banaRef: '20', source: '9885 (Dot)' },
  { id: 'division', area: 'Arithmetic', tier: 'core', label: 'division', ascii: 'a./b', latex: 'a÷b', banaRef: '20', source: '9857 (Divided By)' },
  { id: 'implicit-product', area: 'Arithmetic', tier: 'core', label: 'implicit product', ascii: '#3x', latex: '3x', banaRef: '3.3.1', source: '862-865 (numeric indicator)' },
  { id: 'decimal', area: 'Arithmetic', tier: 'core', label: 'decimal number', ascii: '#3.14', latex: '3.14', banaRef: '3.2.3', source: '818-819 (decimal point)' },

  // -- Relations -------------------------------------------------------------
  { id: 'equals', area: 'Relations', tier: 'core', label: 'equals', ascii: 'x .k y', latex: 'x=y', banaRef: '21', source: '10291 (Normal, is equal to)' },
  { id: 'less-than', area: 'Relations', tier: 'core', label: 'less than', ascii: 'x "k #5', latex: 'x<5', banaRef: '21', source: '10302 (Normal, is less than)' },
  { id: 'greater-than', area: 'Relations', tier: 'core', label: 'greater than', ascii: 'x .1 #5', latex: 'x>5', banaRef: '21', source: '10295 (Normal, is greater than)' },
  { id: 'less-or-equal', area: 'Relations', tier: 'core', label: 'less than or equal to', ascii: 'x "k: #5', latex: 'x≤5', banaRef: '21', source: '10428-10429 (Bar under less than)' },
  { id: 'greater-or-equal', area: 'Relations', tier: 'core', label: 'greater than or equal to', ascii: 'x .1: #5', latex: 'x≥5', banaRef: '21', source: '10406-10407 (Bar under greater than)' },

  // -- Structure -------------------------------------------------------------
  { id: 'parentheses', area: 'Structure', tier: 'core', label: 'parentheses', ascii: '(x+1)', latex: '(x+1)', banaRef: '19', source: '9324-9326 (Parentheses)' },
  { id: 'brackets', area: 'Structure', tier: 'core', label: 'square brackets', ascii: '@(x+1@)', latex: '[x+1]', banaRef: '19', source: '9327-9329 (Brackets)' },
  { id: 'fraction', area: 'Structure', tier: 'core', label: 'fraction', ascii: '?a/b#', latex: '\\frac{a}{b}', banaRef: '13.2.1', source: '5543-5546' },
  { id: 'nested-fraction', area: 'Structure', tier: 'core', label: 'fraction inside a fraction', ascii: ',??3/8#,/5,#', latex: '\\frac{\\frac{3}{8}}{5}', banaRef: '13.6', source: '5753-5762 (Example 13-23)' },
  { id: 'square-root', area: 'Structure', tier: 'core', label: 'square root', ascii: '>x+y]', latex: '\\sqrt{x+y}', banaRef: '16.1.1', source: '8196-8199 (Example 16-2)' },
  { id: 'nth-root', area: 'Structure', tier: 'core', label: 'nth root', ascii: '<3>2]', latex: '\\sqrt[3]{2}', banaRef: '16.2', source: '8256-8259 (Example 16-10)' },

  // -- Powers ----------------------------------------------------------------
  { id: 'exponent', area: 'Powers', tier: 'core', label: 'exponent', ascii: 'x^2', latex: 'x^{2}', banaRef: '14', source: '652-667 (Rule 2 level indicators)' },
  { id: 'subscript', area: 'Powers', tier: 'core', label: 'subscript', ascii: 'x;a', latex: 'x_{a}', banaRef: '14', source: '652-667 (Rule 2 level indicators)' },
  { id: 'sub-and-superscript', area: 'Powers', tier: 'core', label: 'subscript and superscript together', ascii: 'x;a^n', latex: 'x_{a}^{n}', banaRef: '14.11.1', source: '7242-7245 (Example 14-121)' },

  // -- Function names --------------------------------------------------------
  { id: 'sin', area: 'Function names', tier: 'core', label: 'sine', ascii: 'sin x', latex: '\\sin x', banaRef: '18', source: '9113 (table), 9138-9141 (Example 18-2)' },
  { id: 'cos', area: 'Function names', tier: 'core', label: 'cosine', ascii: 'cos x', latex: '\\cos x', banaRef: '18', source: '9081 (table)' },
  { id: 'tan', area: 'Function names', tier: 'core', label: 'tangent', ascii: 'tan x', latex: '\\tan x', banaRef: '18', source: '9116 (table)' },
  { id: 'log', area: 'Function names', tier: 'core', label: 'logarithm', ascii: 'log x', latex: '\\log x', banaRef: '18', source: '9106 (table)' },
  { id: 'ln', area: 'Function names', tier: 'core', label: 'natural logarithm', ascii: 'ln x', latex: '\\ln x', banaRef: '18', source: '9105 (table)' },

  // -- Long tail -------------------------------------------------------------
  // Not blocking. Each `latex` here is the answer the operation SHOULD have,
  // recorded so that an accidental partial implementation producing something
  // else is visible rather than counted as progress.
  { id: 'integral', area: 'Long tail', tier: 'tail', label: 'integral', ascii: '!x', latex: '∫x', banaRef: '23.12', source: '11377-11378 (Integral, Single)' },
  { id: 'infinity', area: 'Long tail', tier: 'tail', label: 'infinity', ascii: ',=', latex: '∞', banaRef: '23', source: '11376 (Infinity)' },
  { id: 'prime', area: 'Long tail', tier: 'tail', label: 'prime', ascii: "x'", latex: "x'", banaRef: '23', source: '11403 (Prime)' },
  { id: 'absolute-value', area: 'Long tail', tier: 'tail', label: 'absolute value', ascii: '\\x\\', latex: '|x|', banaRef: '19.5.2', source: '9335-9336 (Vertical Bar, Single)' },
  { id: 'greek-theta', area: 'Long tail', tier: 'tail', label: 'Greek theta', ascii: '.?', latex: 'θ', banaRef: '6.1.4', source: '3032 (theta)' }
]);

export const TIERS = Object.freeze(['core', 'tail']);

/**
 * Run one operation through the PUBLIC api, exactly as the app calls it.
 *
 * Deliberately not through `lex`/`parse`/`toLatex` separately: the question
 * this gate asks is whether a person can write the expression, and that is a
 * property of `parseNemeth`, not of any stage inside it.
 */
function grade(operation) {
  let cells;
  try {
    cells = asciiToCells(operation.ascii);
  } catch (error) {
    // A Braille-ASCII string the converter rejects is a mistake in THIS file,
    // not a parser result, and must never be reported as a parser gap.
    return { ...operation, cells: null, status: 'invalid-input', detail: error.message, latexGot: null };
  }
  let parsed;
  try {
    parsed = parseNemeth(cells);
  } catch (error) {
    if (error instanceof NemethUnsupportedError) {
      return { ...operation, cells, status: 'refused', detail: error.detail, latexGot: null };
    }
    return { ...operation, cells, status: 'error', detail: `${error.constructor.name}: ${error.message}`, latexGot: null };
  }
  if (parsed.latex === operation.latex) {
    return { ...operation, cells, status: 'green', detail: null, latexGot: parsed.latex };
  }
  return { ...operation, cells, status: 'wrong', detail: `expected ${operation.latex}`, latexGot: parsed.latex };
}

/**
 * Grade every operation.
 *
 * Exported so `test/unit/nemeth/utility-gate.test.js` runs the identical
 * computation the committed report is built from, rather than a second copy of
 * it that could drift -- the same arrangement `nemeth-coverage.mjs` has with
 * the corpus gate.
 */
export function runUtility(operations = OPERATIONS) {
  const results = operations.map(grade);
  const byTier = Object.fromEntries(
    TIERS.map((tier) => {
      const rows = results.filter((r) => r.tier === tier);
      return [tier, { rows, green: rows.filter((r) => r.status === 'green').length, total: rows.length }];
    })
  );
  return { results, byTier, green: results.filter((r) => r.status === 'green').length, total: results.length };
}

const STATUS_MARK = Object.freeze({
  green: 'yes',
  wrong: '**WRONG ANSWER**',
  refused: 'refuses',
  error: '**ERROR**',
  'invalid-input': '**BAD FIXTURE**'
});

function renderRow(r) {
  const detail = r.status === 'green' ? `\`${r.latex}\`` : r.status === 'wrong' ? `got \`${r.latexGot}\`, wanted \`${r.latex}\`` : '';
  return `| ${r.label} | \`${r.ascii}\` | \`${r.cells ?? '-'}\` | ${STATUS_MARK[r.status]} | ${detail.replaceAll('|', '\\|')} | ${r.banaRef} | ${r.source} |`;
}

export function renderReport(run) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  const core = run.byTier.core;
  const tail = run.byTier.tail;

  push('# Utility inventory -- what a student can actually write');
  push();
  push('Generated by `scripts/nemeth-utility.mjs` (`npm run nemeth:utility`) and enforced by');
  push('`test/unit/nemeth/utility-gate.test.js`. Do not hand-edit -- re-run the script instead.');
  push('Every row runs through the public `parseNemeth`, so this measures the API the app calls.');
  push();
  push('This is the **second** gate. `coverage.md` grades the parser against 613 externally-');
  push('verified corpus cases and measures **correctness**; this file measures **usefulness**, and');
  push('the two came apart badly once already: at PASS 177 / ERROR 0 the parser still could not');
  push('write `a - b`. The corpus is a rule-conformance suite, so frequency in it counts how many');
  push('rules touch a symbol, not how often anyone uses one. **The corpus grades; this inventory');
  push('plans.**');
  push();
  push('## Summary');
  push();
  push(`| Tier | Green | Total | Gate |`);
  push('|---|---:|---:|---|');
  push(`| **core** | ${core.green} | ${core.total} | **fails the build below 100%** |`);
  push(`| tail | ${tail.green} | ${tail.total} | reported, never blocking |`);
  push(`| **All** | **${run.green}** | **${run.total}** | |`);
  push();
  if (core.green === core.total) {
    push('**Core is 100%.** No task may add a long-tail symbol family while a core operation is');
    push('missing; that is the standing rule this gate exists to enforce.');
  } else {
    push(`**Core is NOT complete: ${core.total - core.green} of ${core.total} operations are not green.**`);
    push('The build is failing until they are. Fix the core before adding anything else.');
  }
  push();
  push(`Every \`ascii\` column below is BANA's own Braille-ASCII notation, verified against`);
  push(`\`${sourceName}\` at the cited line. A gate built on a wrong expectation is worse than`);
  push('no gate, so the citation is part of the row, not a footnote.');
  push();

  const areas = [...new Set(OPERATIONS.map((o) => o.area))];
  for (const area of areas) {
    const rows = run.results.filter((r) => r.area === area);
    push(`## ${area}`);
    push();
    push('| Operation | Braille-ASCII | Cells | Works | LaTeX | BANA | Source line |');
    push('|---|---|---|---|---|---|---|');
    for (const r of rows) push(renderRow(r));
    push();
  }

  const notGreen = run.results.filter((r) => r.status !== 'green');
  push(`## Not green (${notGreen.length})`);
  push();
  if (notGreen.length === 0) {
    push('None.');
  } else {
    push('The reason each one gives, verbatim from the pipeline. A `refuses` is honest and');
    push('expected for an unimplemented construct; a `WRONG ANSWER` or `ERROR` is a bug.');
    push();
    for (const r of notGreen) {
      push(`- \`${r.id}\` (${r.tier}): ${STATUS_MARK[r.status]} -- ${r.detail}`);
    }
  }
  push();
  push('## The standing lesson');
  push();
  push("Task 5's whole ordering came from corpus refusal counts. That measured what MathCAT's and");
  push("SRE's rule-test corpora exercise, not what a student types: the minus sign ranked about");
  push('fifth and was deferred as "if budget remains" through four tasks. **Corpus coverage is not');
  push('utility.** This file is executable so that the gap cannot reopen silently -- it is');
  push('regenerated from the same run that gates the build, so the document cannot drift from the');
  push('measurement the way its hand-written predecessor did.');
  push();
  push('Adding rows is cheap, and that is the trap. Task 5a added digits and letters as pure data:');
  push('PASS +68, and **11 wrong answers**, because the data reached grammar that did not exist');
  push('yet. **Data ships with the grammar it exposes, or it does not ship** -- and the corpus gate');
  push('is what catches the difference, so run both.');
  push();

  return lines.join('\n');
}

async function main() {
  const run = runUtility();
  writeFileSync(reportPath, renderReport(run));
  console.log(`Nemeth utility inventory: ${run.green}/${run.total} operations`);
  for (const tier of TIERS) {
    console.log(`  ${tier}: ${run.byTier[tier].green}/${run.byTier[tier].total}`);
  }
  for (const r of run.results.filter((x) => x.status !== 'green')) {
    console.log(`  ${r.status.toUpperCase()} ${r.id}`);
  }
  console.log(`Report written to ${path.relative(projectRoot, reportPath)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
