import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Speech Rule Engine says the exponent in 2^n as "n-th", which JAWS reads as the
// letters n, t, h (issue #73). The contributor asked for "enth": "2 to the enth
// power", and "2 raised to the x plus enth power" when the exponent ends in n.
//
// SRE keeps its rules as data (mathmaps/*.json), and MathJax computes speech in a
// worker that offers no hook for custom rules (it deletes `sre.custom`). So the
// supported lever is the `mathmaps` path in mathjax-config.js: this copies SRE's
// maps to a generated folder and adds two ClearSpeak rules. The originals in
// node_modules are never edited. Everything else keeps SRE's own wording.
//
// A rule is two entries: an Action (en.json, what to say) and a Precondition
// (base.json, when). The more specific precondition wins over SRE's default one.
const ACTIONS = [['Action', 'exponent-n', '[t] "enth"'], ['Action', 'exponent-n-last', '[t] "enth"'],
  ['Action', 'exponent-n-negative', '[t] "enth"']];
const PRECONDITIONS = [
  // The whole exponent is the letter n. Same shape as SRE's own `exponent` rule.
  ['Precondition', 'exponent-n', 'default', 'self::identifier',
    'contains(@grammar, "ordinal")', 'text()="n"'],
  // The exponent is a sum or difference whose last term is the letter n. Not a
  // product: "2n" stays "2 n", since there the n is a factor, not an ending.
  // An identifier's parent is a `children` element, hence the doubled `../..`.
  ['Precondition', 'exponent-n-last', 'default', 'self::identifier',
    'text()="n"', 'name(../..)="infixop"', 'name(../../../..)="superscript"',
    'count(../../preceding-sibling::*)=1', 'not(following-sibling::*)',
    '(../../@role="addition" or ../../@role="subtraction")'],
  // The exponent is a negative n, as in 2^-n: "2 raised to the negative enth
  // power". The sign is a prefix operator whose only child is the n.
  ['Precondition', 'exponent-n-negative', 'default', 'self::identifier',
    'text()="n"', 'name(../..)="prefixop"', 'name(../../../..)="superscript"',
    'count(../../preceding-sibling::*)=1', '../../@role="negative"']
];

function eachSection(json, visit) {
  for (const value of Object.values(json)) {
    if (Array.isArray(value)) value.forEach((x) => x && typeof x === 'object' && !Array.isArray(x) && visit(x));
    else if (value && typeof value === 'object') visit(value);
  }
}

function patchFile(file, visit) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  let changed = 0;
  eachSection(json, (section) => { changed += visit(section) ? 1 : 0; });
  if (changed === 0) throw new Error(`speech rules not found in ${file}; SRE changed its layout`);
  writeFileSync(file, JSON.stringify(json));
}

export function buildSreMathmaps(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  patchFile(path.join(dest, 'en.json'), (d) => {
    if (d.locale !== 'en' || d.domain !== 'clearspeak' || d.kind !== 'actions') return false;
    if (!d.rules.some((r) => r[1] === 'exponent')) return false;
    d.rules.push(...ACTIONS);
    return true;
  });
  patchFile(path.join(dest, 'base.json'), (d) => {
    if (!d.rules?.some((r) => r[0] === 'Precondition' && r[1] === 'exponent' && r[3] === 'self::identifier')) return false;
    d.rules.push(...PRECONDITIONS);
    return true;
  });
}

export const SRE_MATHMAPS_SOURCE = fileURLToPath(new URL('../../node_modules/@mathjax/src/bundle/sre/mathmaps', import.meta.url));
export const SRE_MATHMAPS_DEST = fileURLToPath(new URL('../../src/renderer/sre-mathmaps', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) buildSreMathmaps(SRE_MATHMAPS_SOURCE, SRE_MATHMAPS_DEST);
