#!/usr/bin/env node
// Imports the Tier-1 Nemeth correctness corpus into test/corpus/nemeth-v1.json.
//
// The corpus is (braille, MathML) pairs drawn from two externally-maintained,
// independently-verified sources -- not from this project -- so the parser
// built against it can be graded by an oracle it had no hand in writing:
//
//   - MathCAT's Nemeth braille regression tests (rules.rs)
//   - speech-rule-engine's AATA Nemeth test suite (aata.json input + expected)
//
// Usage:
//   node scripts/nemeth-corpus-import.mjs --mathcat <path> --sre <path> [--out <path>]
//
// <mathcat-path> is a checkout of https://github.com/daisy/MathCAT at commit
// 2e2c19cf9532af816d488fa00b8e5cb7a71ce679 (must contain
// tests/braille/Nemeth/rules.rs).
//
// <sre-path> is a checkout of
// https://github.com/Speech-Rule-Engine/speech-rule-engine at commit
// b298fa8866599b2809e6816c7a46ba76161404dd (must contain
// testsuite/input/nemeth/aata.json and testsuite/expected/nemeth/rules/aata.json).
//
// Only these two files are imported. Deliberately NOT imported (see the task
// brief): AataNemeth.rs / SRE_Nemeth72.rs / SRE_NemethBase.rs (ports of the
// same SRE data -- importing them too would double-count and fake
// independence), chemistry.rs (out of v1 scope), and anything from MathCAT
// PR #419 (written by the parser author it tests -- circular).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MATHCAT_REPO = 'https://github.com/daisy/MathCAT';
const MATHCAT_COMMIT = '2e2c19cf9532af816d488fa00b8e5cb7a71ce679';
const MATHCAT_FILE = 'tests/braille/Nemeth/rules.rs';
const MATHCAT_EXPECTED_COUNT = 273;

const SRE_REPO = 'https://github.com/Speech-Rule-Engine/speech-rule-engine';
const SRE_COMMIT = 'b298fa8866599b2809e6816c7a46ba76161404dd';
const SRE_INPUT_FILE = 'testsuite/input/nemeth/aata.json';
const SRE_EXPECTED_FILE = 'testsuite/expected/nemeth/rules/aata.json';
const SRE_EXPECTED_COUNT = 340;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { out: path.join(projectRoot, 'test/corpus/nemeth-v1.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mathcat') args.mathcat = argv[++i];
    else if (a === '--sre') args.sre = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else fail(`Unknown argument: ${a}`);
  }
  if (!args.mathcat || !args.sre) {
    fail(
      'Usage: node scripts/nemeth-corpus-import.mjs --mathcat <path-to-MathCAT-checkout>' +
        ' --sre <path-to-speech-rule-engine-checkout> [--out <path>]'
    );
  }
  return args;
}

function stripXmlComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

// ---- MathCAT extraction ----

// Tokens that mark a function name as citing something other than a 1972
// Nemeth green-book section -- an NFB certification-lesson number, or the
// UEB rule book -- even though the name still contains digits. Deriving a
// ref from these would misattribute a non-green-book citation as a
// green-book section, which is worse than reporting null.
const EXCLUDED_REF_TOKENS = new Set(['lesson', 'nfb', 'ueb']);

// Standard (non-empty) lowercase roman numeral, e.g. "iii" in root_104_iii_1.
const ROMAN_NUMERAL_RE = /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

function isSectionRunToken(token) {
  if (/^\d+$/.test(token)) return true;
  if (/^[a-z]$/.test(token)) return true;
  if (token.length >= 2 && ROMAN_NUMERAL_RE.test(token)) return true;
  return false;
}

// Derives a 1972 Nemeth "green book" section reference (e.g. "9.a.1") from a
// MathCAT test function name -- num_indicator_9_a_1 -> "9.a.1" -- by taking
// the longest trailing run of section-shaped tokens (digits, single
// lowercase letters, or lowercase roman numerals). This is NOT BANA Nemeth
// 2022 rule numbering -- see rules.rs's own header comment ("The numbering
// refers to the Nemeth green book in most cases") and the mathcat-rules
// source note in the output JSON. Returns null, rather than guessing, when:
//   - the name cites something other than the green book (see
//     EXCLUDED_REF_TOKENS above), or
//   - no such trailing run exists, or the run has no digit in it at all.
function deriveRef(fnName) {
  const tokens = fnName.split('_');
  if (tokens.some((t) => EXCLUDED_REF_TOKENS.has(t.toLowerCase()))) return null;
  let i = tokens.length;
  while (i > 0 && isSectionRunToken(tokens[i - 1])) i--;
  const run = tokens.slice(i);
  if (run.length === 0) return null;
  if (!run.some((t) => /^\d+$/.test(t))) return null;
  return run.join('.');
}

function extractMathcatCases(rulesRsPath) {
  const text = readFileSync(rulesRsPath, 'utf8');
  // Split on #[test] markers; each chunk holds (at most) one test function.
  const chunks = text.split('#[test]').slice(1);
  const cases = [];
  let commentedMathmlCount = 0;

  for (const chunk of chunks) {
    const fnMatch = chunk.match(/^\s*fn\s+(\w+)\s*\(/);
    if (!fnMatch) fail(`MathCAT: could not find a test fn name in chunk:\n${chunk.slice(0, 200)}`);
    const fnName = fnMatch[1];

    // Drop `//`-prefixed line comments so a commented-out `let expr = "..."`
    // (verified present, e.g. order2_overbar_87_a_1) is not picked up.
    const activeLines = chunk
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');

    const exprMatches = [
      ...activeLines.matchAll(/let expr\s*=\s*r#"([\s\S]*?)"#;|let expr\s*=\s*"([\s\S]*?)";/g)
    ];
    if (exprMatches.length !== 1) {
      fail(`MathCAT: expected exactly one active 'let expr' in fn ${fnName}, found ${exprMatches.length}`);
    }
    // Verified present (omission_57_3): one literal has a leading space
    // before "<math>". Insignificant XML whitespace outside the root
    // element -- trim it so every mathml value actually starts with "<math"
    // as the schema promises, without touching any element's content.
    let mathml = (exprMatches[0][1] ?? exprMatches[0][2]).trim();
    if (mathml.includes('<!--')) {
      // Verified present (e.g. num_indicator_9_d_2, mathml_spec_example_86_a):
      // some <math> literals embed XML comments the same way the SRE
      // fragments do. This repo's parseMathML is a regex tokenizer, not an
      // XML parser, so strip them here too for the same reason SRE's are
      // stripped -- see the mathcat-rules source note in the output JSON.
      mathml = stripXmlComments(mathml);
      commentedMathmlCount++;
    }

    const tbMatches = [...activeLines.matchAll(/test_braille\("Nemeth",\s*expr,\s*"([^"]*)"\)/g)];
    if (tbMatches.length !== 1) {
      fail(
        `MathCAT: expected exactly one test_braille("Nemeth", expr, ...) call in fn ${fnName}, found ${tbMatches.length}`
      );
    }
    const cells = tbMatches[0][1];

    cases.push({
      id: `mathcat-rules:${fnName}`,
      source: 'mathcat-rules',
      cells,
      mathml,
      ref: deriveRef(fnName)
    });
  }

  return { cases, commentedMathmlCount };
}

// ---- SRE extraction ----

function extractSreCases(inputPath, expectedPath) {
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  const inputTests = input.tests;
  const expectedTests = expected.tests;

  // _comment0_ (and any other _..._-wrapped key) is a comment entry, not a
  // test -- verified: the expected file has 341 keys, the input has 340.
  const inputKeys = Object.keys(inputTests).filter((k) => !(k.startsWith('_') && k.endsWith('_')));

  const cases = [];
  for (const key of inputKeys) {
    const inputEntry = inputTests[key];
    const expectedEntry = expectedTests[key];
    if (!expectedEntry) fail(`SRE: input key "${key}" has no matching expected entry`);
    if (typeof expectedEntry.expected !== 'string' || expectedEntry.expected.length === 0) {
      fail(`SRE: expected entry for "${key}" has no non-empty "expected" string`);
    }
    if (typeof inputEntry.input !== 'string' || inputEntry.input.length === 0) {
      fail(`SRE: input entry for "${key}" has no non-empty "input" string`);
    }

    // The input is a MathML fragment, not a document -- wrap it. The
    // fragments also embed XML comments (e.g. <mo>≡<!-- ≡ --></mo>);
    // strip them, since this repo's parseMathML is a regex tokenizer, not an
    // XML parser, and comments break it.
    const fragment = stripXmlComments(inputEntry.input);
    const mathml = `<math xmlns="http://www.w3.org/1998/Math/MathML">${fragment}</math>`;

    cases.push({
      id: `sre-aata:${key}`,
      source: 'sre-aata',
      cells: expectedEntry.expected,
      mathml,
      ref: null
    });
  }

  return cases;
}

// ---- main ----

const args = parseArgs(process.argv.slice(2));

const { cases: mathcatCases, commentedMathmlCount } = extractMathcatCases(path.join(args.mathcat, MATHCAT_FILE));
if (mathcatCases.length !== MATHCAT_EXPECTED_COUNT) {
  fail(
    `MathCAT: expected ${MATHCAT_EXPECTED_COUNT} cases (verified count), got ${mathcatCases.length}.` +
      ' Stopping rather than silently accepting a different count -- report this.'
  );
}

const sreCases = extractSreCases(path.join(args.sre, SRE_INPUT_FILE), path.join(args.sre, SRE_EXPECTED_FILE));
if (sreCases.length !== SRE_EXPECTED_COUNT) {
  fail(
    `SRE: expected ${SRE_EXPECTED_COUNT} cases (verified count), got ${sreCases.length}.` +
      ' Stopping rather than silently accepting a different count -- report this.'
  );
}

const allCases = [...mathcatCases, ...sreCases];
allCases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const output = {
  schemaVersion: 1,
  generatedBy: 'scripts/nemeth-corpus-import.mjs',
  sources: [
    {
      id: 'mathcat-rules',
      repo: MATHCAT_REPO,
      commit: MATHCAT_COMMIT,
      license: 'MIT',
      path: MATHCAT_FILE,
      caseCount: mathcatCases.length,
      refScheme: 'nemeth-1972-green-book',
      notes:
        (commentedMathmlCount > 0
          ? `${commentedMathmlCount} <math> literal(s) embedded XML comments (e.g. <mi mathvariant='normal'>#<!-- # --></mi>); comments were stripped for the same reason as the sre-aata source below. `
          : '') +
        'One literal (omission_57_3) had a leading space before "<math>"; insignificant outer whitespace was trimmed. ' +
        "Non-null `ref` values are section numbers from the 1972 Nemeth \"green book\" (per rules.rs's own header: " +
        '"The numbering refers to the Nemeth green book in most cases"), with some NFB certification-lesson numbers ' +
        'mixed in for names deriveRef() could not distinguish from a green-book section by pattern alone. ' +
        'They are NOT BANA Nemeth 2022 rule numbers -- BANA Nemeth 2022 has only 26 rules, while these refs run up ' +
        'to 177 (e.g. "177.2.1"), and the two numbering schemes are ambiguous (ref could mean either) for any ' +
        'value below 27.'
    },
    {
      id: 'sre-aata',
      repo: SRE_REPO,
      commit: SRE_COMMIT,
      license: 'Apache-2.0',
      path: `${SRE_INPUT_FILE} + ${SRE_EXPECTED_FILE}`,
      caseCount: sreCases.length,
      refScheme: null,
      notes:
        'Input MathML fragments were wrapped in <math xmlns="http://www.w3.org/1998/Math/MathML">...</math>' +
        ' (the source has no document element); embedded XML comments (e.g. <mo>≡<!-- ≡ --></mo>)' +
        ' were stripped since parseMathML is a regex tokenizer, not an XML parser. The expected file\'s' +
        ' "_comment0_" entry was skipped as it is not a test. This source carries no `ref` values at all' +
        ' (every case has ref: null) -- refScheme is null because there is no scheme to name.'
    }
  ],
  cases: allCases
};

writeFileSync(args.out, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(
  `Wrote ${allCases.length} cases (${mathcatCases.length} mathcat-rules + ${sreCases.length} sre-aata) to ${args.out}`
);
