#!/usr/bin/env node
// Grades src/domain/nemeth's parser against every case in the Tier-1
// correctness corpus (test/corpus/nemeth-v1.json) and writes
// docs/nemeth-v2/coverage.md.
//
// Every case lands in exactly one of four buckets:
//
//   PASS      parseNemeth succeeded, and the emitted LaTeX round-trips
//             (via MathJax) to MathML structurally equivalent to the case's
//             own MathML.
//   REFUSE    parseNemeth threw NemethUnsupportedError. Legitimate: out of
//             current scope.
//   DISAGREE  parseNemeth succeeded, MathJax accepted the LaTeX, but the
//             resulting MathML is NOT structurally equivalent to the case's
//             own MathML. This is the dangerous bucket: the parser claimed
//             an answer and got the mathematics wrong.
//   ERROR     parseNemeth succeeded but produced LaTeX MathJax could not
//             convert at all, or threw something other than
//             NemethUnsupportedError. Also dangerous -- a parser bug, not a
//             refusal -- and reported separately from REFUSE on purpose.
//
// Most of the 613 cases REFUSE today; the parser supports a deliberately
// narrow slice (see src/domain/nemeth/parser.js). That is the expected,
// correct result -- this script's job is only to measure it and to make a
// DISAGREE or ERROR impossible to miss.
//
// No network. Every list in the output is sorted, so re-running this script
// against an unchanged parser and corpus produces a byte-identical report.
//
// Usage: node scripts/nemeth-coverage.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NemethUnsupportedError, parseNemeth } from '../src/domain/nemeth/index.js';
import { mathmlEquivalent } from '../test/helpers/mathml-compare.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = path.join(projectRoot, 'test', 'corpus', 'nemeth-v1.json');
const reportPath = path.join(projectRoot, 'docs', 'nemeth-v2', 'coverage.md');

const BUCKETS = ['PASS', 'REFUSE', 'DISAGREE', 'ERROR'];

function pct(n, total) {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`;
}

// canonicalizeMathML assigns a fresh crypto.randomUUID() `data-omniya-id` to
// every element on each call (see src/domain/math-tree.js), so the same
// case produces a different id on every run. That is fine for comparison
// (structuralEquivalent strips the attribute before comparing) but MUST NOT
// leak into this report, or the "committed report diffs cleanly" guarantee
// breaks on every single regeneration even when nothing actually changed.
function stripDisplayIds(mathml) {
  return mathml.replaceAll(/ data-omniya-id="[^"]*"/g, '');
}

// Groups a REFUSE cause's raw `detail` string into a family: the exact cell
// offset is case-specific noise (it is a byte position, not a category), so
// it is generalized away for grouping while the offending codepoint --
// which IS the category -- is kept and rendered with its glyph for a human
// reader (matching the corpus's own convention of naming a cell by its
// glyph, e.g. "unknown cells `⠷`").
function causeFamily(detail) {
  const generalized = detail.replace(/cell \d+/, 'cell N');
  return generalized.replace(/U\+([0-9A-Fa-f]{4})/, (match, hex) => `${match} "${String.fromCodePoint(Number.parseInt(hex, 16))}"`);
}

async function classify(testCase) {
  let parsed;
  try {
    parsed = parseNemeth(testCase.cells);
  } catch (error) {
    if (error instanceof NemethUnsupportedError) {
      return { bucket: 'REFUSE', cause: causeFamily(error.detail || '(no detail)') };
    }
    return { bucket: 'ERROR', reason: `${error.constructor.name}: ${error.message}` };
  }

  let comparison;
  try {
    comparison = await mathmlEquivalent(parsed.latex, testCase.mathml);
  } catch (error) {
    // mathmlEquivalent itself is not expected to throw (convertLatexToMathML
    // failures are caught internally and reported as 'conversion-error');
    // any throw here is this script's own bug, not the parser's, and must
    // not be silently swallowed into an unrelated bucket.
    return { bucket: 'ERROR', reason: `mathmlEquivalent crashed: ${error.constructor.name}: ${error.message}`, latex: parsed.latex };
  }

  if (comparison.outcome === 'conversion-error') {
    return { bucket: 'ERROR', reason: `LaTeX did not survive MathJax: ${comparison.error.message}`, latex: parsed.latex };
  }
  if (comparison.outcome === 'equal') {
    return { bucket: 'PASS', latex: parsed.latex };
  }
  return {
    bucket: 'DISAGREE',
    latex: parsed.latex,
    ourMathml: comparison.ourMathml,
    theirMathml: comparison.theirMathml
  };
}

/**
 * Classify every case in `corpus` into PASS/REFUSE/DISAGREE/ERROR.
 *
 * Exported so `test/unit/nemeth/corpus-gate.test.js` can run the identical
 * classification the report is built from, rather than re-implementing (and
 * risking drifting from) this logic -- the gate and the report are provably
 * looking at the same computation, not two hand-synchronized copies of it.
 */
export async function runCoverage(corpus) {
  const cases = [...corpus.cases].sort((a, b) => a.id.localeCompare(b.id));
  const sourceIds = [...corpus.sources.map((s) => s.id)].sort();

  const results = [];
  for (const testCase of cases) {
    const outcome = await classify(testCase);
    results.push({ case: testCase, ...outcome });
  }

  const totals = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const bySource = Object.fromEntries(sourceIds.map((id) => [id, Object.fromEntries(BUCKETS.map((b) => [b, 0]))]));
  const refuseCauses = new Map(); // cause family -> { count, caseIds: [] }
  const disagrees = [];
  const errors = [];

  for (const r of results) {
    totals[r.bucket] += 1;
    bySource[r.case.source][r.bucket] += 1;
    if (r.bucket === 'REFUSE') {
      const entry = refuseCauses.get(r.cause) ?? { count: 0, caseIds: [] };
      entry.count += 1;
      entry.caseIds.push(r.case.id);
      refuseCauses.set(r.cause, entry);
    } else if (r.bucket === 'DISAGREE') {
      disagrees.push(r);
    } else if (r.bucket === 'ERROR') {
      errors.push(r);
    }
  }

  const refuseCauseRows = [...refuseCauses.entries()]
    .map(([cause, entry]) => ({
      cause,
      count: entry.count,
      representative: [...entry.caseIds].sort()[0]
    }))
    .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));

  disagrees.sort((a, b) => a.case.id.localeCompare(b.case.id));
  errors.sort((a, b) => a.case.id.localeCompare(b.case.id));

  return { cases, sourceIds, results, totals, bySource, refuseCauseRows, disagrees, errors };
}

function renderReport({ cases, sourceIds, totals, bySource, refuseCauseRows, disagrees, errors }) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# Nemeth v2 -- corpus coverage report');
  push();
  push('Generated by `scripts/nemeth-coverage.mjs` (`npm run nemeth:coverage`). Do not hand-edit --');
  push('re-run the script instead. Every list below is sorted, so an unchanged parser and');
  push('corpus reproduce this file byte-for-byte.');
  push();
  push('The parser supports a deliberately narrow slice today; most cases REFUSE, and that is');
  push('the expected, correct result -- see `test/unit/nemeth/corpus-gate.test.js` for the');
  push('assertions this report backs. The only outcomes that gate the build are DISAGREE and');
  push('ERROR: PASS is a baseline that must not regress, not a target this report tries to');
  push('maximize.');
  push();
  push('## Summary');
  push();
  push(`| Outcome | Count | % of ${cases.length} |`);
  push('|---|---:|---:|');
  for (const bucket of BUCKETS) {
    push(`| ${bucket} | ${totals[bucket]} | ${pct(totals[bucket], cases.length)} |`);
  }
  push(`| **Total** | **${cases.length}** | **100.0%** |`);
  push();
  push('## By source');
  push();
  push('| Source | PASS | REFUSE | DISAGREE | ERROR | Total |');
  push('|---|---:|---:|---:|---:|---:|');
  for (const id of sourceIds) {
    const s = bySource[id];
    const total = BUCKETS.reduce((sum, b) => sum + s[b], 0);
    push(`| ${id} | ${s.PASS} | ${s.REFUSE} | ${s.DISAGREE} | ${s.ERROR} | ${total} |`);
  }
  push();
  push('## REFUSE by cause');
  push();
  push('Sorted by frequency, most common first. This is the scope map for the next task: each');
  push('row is a construct the parser does not support yet, generalized from the thrown');
  push('`NemethUnsupportedError.detail` (the exact cell offset is dropped since it is a byte');
  push('position, not a category; the offending codepoint is kept since it is).');
  push();
  push('| Count | Cause | Representative case |');
  push('|---:|---|---|');
  for (const row of refuseCauseRows) {
    push(`| ${row.count} | ${row.cause.replaceAll('|', '\\|')} | \`${row.representative}\` |`);
  }
  push();
  push('## Why DISAGREE = 0 is not always achievable');
  push();
  push('This corpus was built by running MathML *forward* through MathCAT\'s/SRE\'s Nemeth rules');
  push('(MathML -> braille) and recording the resulting cells. That forward map is deliberately');
  push('many-to-one: braille correctly discards non-mathematical detail -- a leading or trailing');
  push('space is formatting, not content, and more than one MathML encoding can render');
  push('identically -- so distinct MathML inputs can collapse to identical cells. Running the');
  push('corpus in reverse (cells -> our parsed MathML) is therefore inherently ambiguous for any');
  push('case whose MathML differs from another only in such non-mathematical detail: the cells');
  push('alone underdetermine which of several equally-valid source MathML trees produced them,');
  push('and there is nothing a braille-to-MathML parser could do differently.');
  push();
  push('Because of this, **the gate\'s actual target is not DISAGREE = 0** -- it is "every');
  push('DISAGREE has a verified structural reason", enforced by the named, categorized allowlist');
  push('in `test/unit/nemeth/corpus-gate.test.js` (`MANY_TO_ONE_FORWARD_MAP`). A DISAGREE with no');
  push('allowlist entry still fails the gate; a DISAGREE explained by this many-to-one collapse');
  push('is expected and does not by itself indicate a parser bug or a corpus error. Every');
  push('DISAGREE below has been checked and falls into one of seven sub-causes:');
  push('`equivalent-encoding` (the corpus accepts more than one MathML shape as correct for the');
  push('same input), `formatting-only` (the differing MathML carries only non-mathematical');
  push('whitespace), `unencoded-boundary` (the forward map ran two adjacent elements');
  push('together and left no cell at the seam), `unencoded-attribute` (the difference is a');
  push('presentational MathML attribute braille cannot carry), `homograph` (the Nemeth Code');
  push('itself writes two different print signs with one set of cells), `glyph-spelling` (the');
  push('Code and the corpus write the same sign with two different Unicode codepoints), or');
  push('`text-vs-math` (the case targets literary text, which this math-only pipeline does not');
  push('model). The authoritative list is `MANY_TO_ONE_CAUSES` in the gate itself.');
  push();
  push(`## DISAGREE (${disagrees.length})`);
  push();
  if (disagrees.length === 0) {
    push('None.');
  } else {
    push('Parsed successfully, but the resulting mathematics differs from the corpus case\'s');
    push('own MathML. Every one of these must be in `MANY_TO_ONE_FORWARD_MAP` in');
    push('`test/unit/nemeth/corpus-gate.test.js` with a stated, categorized reason, or the gate fails.');
    for (const r of disagrees) {
      push();
      push(`### \`${r.case.id}\``);
      push();
      push(`- cells: \`${r.case.cells}\``);
      push(`- our LaTeX: \`${r.latex}\``);
      push('- our MathML:');
      push('  ```xml');
      push(`  ${stripDisplayIds(r.ourMathml)}`);
      push('  ```');
      push('- their MathML:');
      push('  ```xml');
      push(`  ${stripDisplayIds(r.theirMathml)}`);
      push('  ```');
    }
  }
  push();
  push(`## ERROR (${errors.length})`);
  push();
  if (errors.length === 0) {
    push('None.');
  } else {
    push('parseNemeth either threw something other than `NemethUnsupportedError`, or produced');
    push('LaTeX that MathJax itself rejected. Both are parser bugs, not legitimate refusals.');
    for (const r of errors) {
      push();
      push(`### \`${r.case.id}\``);
      push();
      push(`- cells: \`${r.case.cells}\``);
      if (r.latex !== undefined) push(`- our LaTeX: \`${r.latex}\``);
      push(`- reason: ${r.reason}`);
    }
  }
  push();

  return lines.join('\n');
}

async function main() {
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const coverage = await runCoverage(corpus);
  const report = renderReport(coverage);
  writeFileSync(reportPath, report);

  console.log(`Nemeth corpus coverage: ${coverage.cases.length} cases`);
  for (const bucket of BUCKETS) {
    console.log(`  ${bucket}: ${coverage.totals[bucket]} (${pct(coverage.totals[bucket], coverage.cases.length)})`);
  }
  console.log(`Report written to ${path.relative(projectRoot, reportPath)}`);
}

// Only run the CLI (which writes the report file and prints to stdout) when
// this file is executed directly -- `test/unit/nemeth/corpus-gate.test.js`
// imports `runCoverage` from this module without triggering either.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
