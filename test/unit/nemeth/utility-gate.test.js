import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OPERATIONS, TIERS, renderReport, runUtility } from '../../../scripts/nemeth-utility.mjs';

// The utility gate. Its question is not "is the parser right about the 613
// cases MathCAT and SRE wrote" -- `corpus-gate.test.js` answers that -- but
// "can a person write their homework". The two are different measurements
// and this project has already been burned by using one for the other's job:
// at PASS 177 / ERROR 0 over the corpus, `a - b` did not parse, because the
// corpus is a rule-conformance suite and frequency in it counts how many
// rules touch a symbol rather than how often anyone uses one.
//
// So the CORE tier fails the build. That is the whole point: it is a gate,
// not a checklist, and no task may add a long-tail symbol family while a
// core operation is missing. The TAIL tier is measured and reported but
// never blocks, so progress is visible without a half-built feature holding
// up the suite -- with one exception, below: a WRONG ANSWER blocks in either
// tier, because a wrong answer is worse than a missing feature everywhere.
//
// `runUtility` comes from `scripts/nemeth-utility.mjs`, the same function
// that generates docs/nemeth-v2/utility-inventory.md, so this file's
// assertions and the committed document are provably the same computation
// rather than two hand-synchronized copies of it.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const reportPath = path.join(projectRoot, 'docs', 'nemeth-v2', 'utility-inventory.md');

const run = runUtility();

const describe = (rows) =>
  rows.map((r) => `  ${r.id} [${r.status}] ${r.detail ?? ''}`).join('\n');

test('CORE: every core operation parses to its expected LaTeX', () => {
  const core = run.byTier.core;
  const broken = core.rows.filter((r) => r.status !== 'green');
  assert.deepEqual(
    broken.map((r) => r.id),
    [],
    `${broken.length} of ${core.total} core operations are not green. The core set is what makes ` +
      'the parser usable, so this fails the build rather than being noted in a document:\n' +
      `${describe(broken)}\n` +
      'Fix these before adding any long-tail symbol family.'
  );
  assert.equal(core.green, core.total);
});

test('a wrong answer fails in EITHER tier -- only a clean refusal is tolerated in the tail', () => {
  // A refusal is honest: the construct is not implemented and the pipeline
  // says so. A `wrong` or `error` is the parser claiming an answer and getting
  // the mathematics wrong, or crashing, and that is a bug wherever it happens.
  // `invalid-input` means a row in this inventory is not valid Braille-ASCII,
  // i.e. the FIXTURE is broken -- it must never be reported as a parser gap.
  const bad = run.results.filter((r) => r.status === 'wrong' || r.status === 'error' || r.status === 'invalid-input');
  assert.deepEqual(bad.map((r) => r.id), [], `not a missing feature but a bug:\n${describe(bad)}`);
});

test('the long tail is reported as a count, and does not block', () => {
  // Deliberately not an equality pin. The tail is progress-visible, not
  // gated: its count moving is a fact for the diff to show, never a build
  // failure. What IS asserted is that the tier exists and is measured, so it
  // cannot quietly become empty and read as "nothing left to do".
  const tail = run.byTier.tail;
  assert.ok(tail.total > 0, 'the long tail must list something, or the inventory is claiming completeness it does not have');
  assert.ok(tail.green <= tail.total);
  const report = readFileSync(reportPath, 'utf8');
  assert.match(
    report,
    new RegExp(`\\| tail \\| ${tail.green} \\| ${tail.total} \\|`, 'u'),
    'utility-inventory.md tail count is stale -- run `npm run nemeth:utility` and commit the result'
  );
});

test('committed docs/nemeth-v2/utility-inventory.md is byte-identical to this run', () => {
  // Regenerated from the same `run` object the assertions above used, so the
  // document cannot drift from the measurement -- which is exactly how its
  // hand-written predecessor came to claim 18/30 with no list of the 30 and
  // several entries that were encoding mistakes rather than parser gaps.
  assert.equal(
    readFileSync(reportPath, 'utf8'),
    renderReport(run),
    'utility-inventory.md is out of date -- run `npm run nemeth:utility` and commit the result'
  );
});

test('the inventory itself is well formed: unique ids, a known tier, and a real citation each', () => {
  const ids = OPERATIONS.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate operation id');
  for (const op of OPERATIONS) {
    assert.ok(TIERS.includes(op.tier), `${op.id} has tier "${op.tier}"`);
    assert.ok(op.ascii.length > 0, `${op.id} has no input`);
    assert.ok(op.latex.length > 0, `${op.id} has no expected LaTeX`);
    // Unlike `symbols.json`, where `banaRef` may be null because the Code says
    // it does not specify the English alphabet, every OPERATION here is a
    // construct the Code writes, so every row must name the rule AND the line
    // it was read from. An uncited expectation is how a gate ends up enforcing
    // a recollection.
    assert.match(op.banaRef, /^\d+(\.\d+)*$/u, `${op.id} has no BANA rule number`);
    assert.match(op.source, /^\d{3,5}/u, `${op.id} cites no line in the BANA source`);
  }
});

test('the gate discriminates: a deliberately wrong expectation is caught, and a right one is not', () => {
  // Anti-vacuity. Every assertion above is only worth something if `runUtility`
  // can tell a right answer from a wrong one, so that is demonstrated here on
  // synthetic rows rather than assumed. `x+y` is compared against the LaTeX for
  // `x-y`: same shape, one sign different.
  const probe = runUtility([
    { id: 'right', area: 'probe', tier: 'core', label: 'probe', ascii: 'x+y', latex: 'x+y', banaRef: '20', source: '9888' },
    { id: 'wrong', area: 'probe', tier: 'core', label: 'probe', ascii: 'x+y', latex: 'x-y', banaRef: '20', source: '9868' },
    { id: 'refused', area: 'probe', tier: 'tail', label: 'probe', ascii: "x'", latex: "x'", banaRef: '23', source: '11403' },
    { id: 'bad-fixture', area: 'probe', tier: 'tail', label: 'probe', ascii: '~', latex: '?', banaRef: '20', source: '9888' }
  ]);
  assert.deepEqual(
    probe.results.map((r) => `${r.id}:${r.status}`),
    ['right:green', 'wrong:wrong', 'refused:refused', 'bad-fixture:invalid-input']
  );
});

test('the gate runs through the public parseNemeth, not through a stage of it', () => {
  // The inventory measures what the app can do, and the app calls parseNemeth.
  // Grading against `lex` or `parse` directly would let a construct count as
  // working while the LaTeX it emits is unusable -- which is the failure the
  // ERROR bucket exists for on the corpus side.
  const script = readFileSync(path.join(projectRoot, 'scripts', 'nemeth-utility.mjs'), 'utf8');
  assert.match(script, /import \{ NemethUnsupportedError, parseNemeth \} from '\.\.\/src\/domain\/nemeth\/index\.js'/u);
  assert.doesNotMatch(script, /from '\.\.\/src\/domain\/nemeth\/(lexer|levels|parser|latex)\.js'/u);
});
