# nemeth-v2 — Task-1 interface spec (superseded — see status note)

**Status: HISTORICAL, superseded where noted.** This is the contract Task 1 froze
before any lane wrote code. It did its job — it is why five lanes could work in
parallel without stepping on each other — but two things in it were empirically
wrong and were corrected during implementation (Task 3's ledger entry, `progress.md`
"Ruling: leave `role: 'binary'` deleted" and the level-model finding). This file was
never edited back into agreement, so treat it as the **design record**, not as a
live reference:

- **§4's `kind` enum does not match what shipped.** The authoritative list is
  `src/domain/nemeth/symbols.json` itself (88 rows, 20 `kind` values as of this
  writing) — read the data, not this table. See the note inline at §4.
- **§5's level model (signed integers, `level: number`, baseline = 0) is not what
  shipped.** `src/domain/nemeth/levels.js` uses absolute-path strings instead,
  because the signed model silently mis-parses `x_a^n` (see the doc-comment at the
  top of that file, and `progress.md`'s Task 3 entry). See the note inline at §5.
- Everything else below — the public API (§1), error contract (§2), AST node kinds
  (§6, which do match `kinds.js` exactly), v1 scope (§7), teardown (§8), the LaTeX
  backend shape (§10) and the corpus schema (§11) — was not found to have drifted
  and can still be read as accurate to the shipped code as of `92dc3ef`. Verify
  against the named source file if in doubt; this document is no longer the
  arbiter.

Below this point the original Task-1 text is preserved unedited except for the two
inline superseded-notes, so the record of what was originally specified stays
intact.

---

**Original status line (no longer in force): FROZEN.** Every worker codes against
this document. If you believe the spec is wrong, do **not** unilaterally change it
— message `god` and keep working around it. Coherence across parallel tracks
depends on this file not moving.

Branch `nemeth-v2` (off `testing`). Pure ESM, plain JavaScript (no TypeScript —
the repo has none). 2-space indent, single quotes, semicolons. **No new
dependencies.** No DOM, no Electron, and no `crypto.randomUUID()` in
`src/domain/nemeth/**`.

`src/domain/` **must never import from `src/main/`.** This is an existing,
enforced rule in the repo. It is why the parser emits LaTeX rather than MathML.

---

## 0. File ownership — do not edit outside your lane

| Worker | Owns (create/edit ONLY these) |
|---|---|
| W0 teardown | deletions in §8; `src/renderer/app.js`; `src/domain/replacement-session.js`; `package.json` |
| W1 corpus | `test/corpus/**`, `scripts/nemeth-corpus-extract.mjs`, `src/domain/nemeth/braille-ascii.js` |
| W2 symbols | `src/domain/nemeth/symbols.json`, `src/domain/nemeth/symbols.js` |
| W3 lexer | `src/domain/nemeth/lexer.js`, `levels.js`, `test/unit/nemeth/lexer.test.js`, `levels.test.js` |
| W4 parser | `src/domain/nemeth/ast.js`, `parser.js`, `test/unit/nemeth/ast.test.js`, `parser.test.js` |
| W5 latex | `src/domain/nemeth/latex.js`, `test/unit/nemeth/latex.test.js`, `test/helpers/latex-compare.js` |
| god | `kinds.js`, `errors.js`, `backend.js`, `index.js`, this file, integration |

**Already written and on the branch — treat as read-only:**
`src/domain/nemeth/kinds.js`, `errors.js`, `backend.js`, `index.js`.
Read them; they are the contract in executable form.

---

## 1. Public API

```js
import { parseNemeth } from '../../src/domain/nemeth/index.js';

parseNemeth(input, options?) -> { ast, latex, diagnostics }
```

- `input: string` — Unicode braille cells (U+2800–U+28FF), blanks included.
  Braille-ASCII is **not** accepted here; convert first via `braille-ascii.js`.
- Pure and **synchronous**. No I/O, no MathJax, no async.
- Throws `NemethUnsupportedError` for anything out of scope. It never returns
  partial garbage, never prompts, and has no interactive path.

```js
Diagnostic = { code: string, message: string, offset: number, cells: string }
```

**MathML is not produced by this module.** Callers pipe `latex` through the
existing `convertLatexToMathML` → `canonicalizeMathML` → `parseMathML` path in
`src/main/`. This guarantees Nemeth-authored and LaTeX-authored expressions
produce identical MathML instead of drifting behind two generators, and
`parseMathML` already stamps `data-omniya-id` on every element for free.

### Stage signatures (fixed by `index.js` — match them exactly)

```js
lex(input, context)            -> Token[]
resolveLevels(tokens, context) -> Token[]
parse(tokens, context)         -> Node        // AST root
toLatex(ast)                   -> string
```

`context` is `{ ...options, diagnostics }`. Push to `context.diagnostics`; never
replace the array.

---

## 2. Error contract — `errors.js` (written)

```js
export const UNSUPPORTED_MESSAGE =
  "This Nemeth construct isn't supported yet. Write the expression in LaTeX instead.";

export class NemethUnsupportedError extends Error {
  constructor({ offset, cells, detail })   // message is ALWAYS UNSUPPORTED_MESSAGE
}
```

`message` is identical for every failure — a deliberate product decision.
`detail` is developer-only and must never surface to an end user. Throw this for
unknown cell sequences, unclosed structures, Rule 25 spatial arrangements,
matrices, chemistry, and every out-of-scope construct.

---

## 3. Normalization (in `lexer.js`)

1. Accept U+2800–U+28FF. Reduce 8-dot to 6-dot via `code & 0x3F`.
2. Reject anything else with `NemethUnsupportedError`.
3. **U+2800 (blank) is a significant token, not whitespace.** Nemeth spacing is
   semantic: comparison signs are blank-surrounded, operation signs are not.
   Never trim, collapse, or drop blanks.

---

## 4. Symbol table (W2) — `symbols.json`

> **SUPERSEDED.** The `kind` enum below is the pre-implementation design. The
> shipped `symbols.json` uses a different, coarser set of `kind` values
> (`blank digit letter function op numeric fracOpen fracLine fracClose radIndex
> radOpen radClose level baseline comma prefix decimal groupOpen groupClose
> comparison` — 19 values, e.g. `rel` became `comparison` and the four separate
> indicator kinds collapsed into one `prefix`). There is no `greek`, `bigop` or
> `punctuation` kind. (`role` did ship, on `op`/`comparison` rows only, with
> values `binary`/`comparison` — see `progress.md`'s Task 3 ruling on
> `role: 'binary'` for why.) **Read `symbols.json` directly** for what actually
> exists; do not code against the list below.

Flat array; longest-match wins at lex time; W3 builds the trie.

```json
{ "cells": "⠬", "kind": "op", "value": "+", "role": "binary", "banaRef": "20.1" }
```

`kind` ∈ `digit · letter · greek · op · rel · numeric-indicator ·
letter-indicator · capital-indicator · typeform · level-up · level-down ·
level-baseline · frac-open · frac-line · frac-close · root-open · root-close ·
root-index · group-open · group-close · function-name · bigop · punctuation · blank`
*(original design-time enum — see the SUPERSEDED note above; not what shipped)*

Rules for W2:
- **Every entry carries a `banaRef`.** No uncited symbols.
- Scope to v1 only (§7). Do not port the full 755-row registry.
- The old registry (`guided-nemeth/index.js:2313-3321` on branch `testing`) may be
  mined for **data** — cells, sourceNotation, banaRefs — but never for logic.
  Verify every value against the BANA source: that table is known to contain
  errors, and its own docs disclaim being a conformance claim.
- `docs/guided-nemeth-bana-audit-notes.md` records ~35 hard-won normative
  corrections. Read it; it will save you rediscovering them.
- **Collisions are expected and legal.** The same `cells` may appear under
  different `kind`; the lexer resolves by context. You MUST include:
  - `⠼` numeric indicator **and** fraction close
  - `⠰` subscript indicator **and** English-letter indicator
  - `⠐` baseline indicator **and** multipurpose indicator
  - `⠦` digit 8 **and** left double quote

---

## 5. Tokens (W3 produces, W4 consumes)

```js
Token = {
  kind: string,   // from the §4 enum
  cells: string,  // raw cells matched
  value: string,  // resolved value ('+', '7', 'x', …)
  start: number,  // inclusive cell offset into normalized input
  end: number,    // exclusive
  level: number   // script level; filled by levels.js — 0 = baseline
}
```

`resolveLevels` assigns `.level` and **consumes/removes the level-indicator
tokens themselves**.

> **SUPERSEDED.** The signed-integer model described below (`level: number`,
> `level-baseline` → 0) is the pre-implementation design. It was found to be
> silently wrong during Task 3: `x_{a}^{n}` computes as `-1 + 1 = 0` under a
> signed model and parses as the wrong thing (`x_a n`) with no error. The shipped
> `levels.js` instead labels each token with an **absolute path string** over the
> alphabet `^`/`_` (`''`, `'^'`, `'_'`, `'^^'`, `'^_'`, …) — see the doc-comment at
> the top of `src/domain/nemeth/levels.js` for the full reasoning and BANA
> citations. The bullet list below records what was originally specified, not
> what runs.

**Level semantics — the #1 historical bug source. Get this exactly right:**
*(original design-time model — see the SUPERSEDED note above; superseded by the
absolute-path model in `levels.js`)*
- `level-up` raises by 1; `level-down` lowers by 1, relative to current.
- Repeated indicators nest (a second-level superscript is `⠘⠘`).
- `level-baseline` returns to level **0** — not to level−1.
- A level is also implicitly closed by a token that cannot continue it.
- The old engine emitted **spurious baseline cells**; two of the eight tests
  currently failing on `testing` are exactly this. Test it directly.

---

## 6. AST (W4 produces, W5 consumes)

Nodes are built by **named constructors** and read like the mathematics they
describe. `x + 2/y` is:

```js
Sequence([
  Identifier('x'),
  Operator('+'),
  Fraction(
    Number('2'),
    Identifier('y')
  )
])
```

The 14 kinds and their field order are fixed in `kinds.js` (read it — it is the
authority). Constructors live in `ast.js`:

```js
Number(value)                       Fenced(open, body, close)
Identifier(name, opts)              FunctionCall(name, argument?)
Operator(glyph, opts)               BigOperator(glyph, { lower, upper, body })
Sequence(items)                     Text(value)
Fraction(numerator, denominator)    Hole(role)
Root(radicand, index?)              Superscript(base, exponent)
Subscript(base, index)              SubSuperscript(base, index, exponent)
```

Every constructor returns a **frozen, JSON-safe plain object**:
`{ kind, …fields, src: [start, end], marks: {} }`.

- **Not class instances.** `structuredClone` drops prototypes and the repo leans
  on `structuredClone` throughout; instances would silently degrade to bare
  objects at the first clone.
- **`marks`** holds what Nemeth explicitly signalled but LaTeX/MathML cannot
  store — fraction order/complexity, typeform, numeric-indicator provenance,
  explicit baseline returns. This is the honest home for the information the old
  code smuggled through 98 `data-omniya-nemeth-intent` attributes.
- **Constructors validate arity and child kinds and throw on violation**, so a
  malformed tree cannot be built. Errors then surface at the parse site with cell
  offsets in hand, instead of three layers downstream.
- `Sequence` is juxtaposition and asserts **no** semantics — it is not
  multiplication. Do not "simplify" it away.

Grammar (recursive descent; **no backtracking** — Nemeth's explicit delimiters
make it nearly LL(1)):

```
expression     := relation
relation       := additive ( REL additive )*
additive       := multiplicative ( (+|−|±) multiplicative )*
multiplicative := unary ( (×|÷|implicit) unary )*
unary          := (+|−|±)? postfix
postfix        := primary script*
script         := SUP expr | SUB expr | SUB expr SUP expr
primary        := Number | Identifier | Fraction | Root | Fenced
                | FunctionCall | BigOperator
```

W4 also exports a `format(node)` pretty-printer producing the constructor form
shown above. This is not a nicety: `⠹⠆⠌⠽⠼` is opaque to a sighted developer, and
the printed tree is the primary debugging surface for every other lane.

---

## 7. v1 scope

**In.** Integers, decimals, negatives, numeric indicator; variables, capitals,
Greek, typeform; `+ − × ÷ ±`; `= ≠ < > ≤ ≥ ≈`; parentheses, brackets, braces;
simple and nested fractions; square and indexed radicals; superscripts,
subscripts and sub+sup chains; `sin cos tan log ln exp`; `∑ ∏ ∫` with limits.

**Out — throw `NemethUnsupportedError`.** Spatial arrangements (Rule 25), page
format (Rule 26), matrices, chemistry, cancellation, arrows beyond the basic set,
shape modifiers, and the long symbol tail.

Unsupported is a **legitimate, correct outcome**. A silently wrong parse is not.

---

## 8. Teardown (W0)

Delete on this branch:
- `src/domain/guided-nemeth/` (whole directory)
- `src/renderer/nemeth-braille-projection.js`, `src/domain/nemeth-cell-input.js`
- Tests importing them: `test/unit/guided-nemeth-*.test.js`,
  `nemeth-braille-projection.test.js`, `keystroke-braille-projection.test.js`,
  `nemeth-braille-accuracy.test.js`, `nemeth-cell-input.test.js`,
  `nemeth-electron-evidence.test.js`, all `test/unit/rule*-coverage-integrity.test.js`,
  all `test/unit/bana-*.test.js`, `test/e2e/bana-*.test.js`
- `scripts/bana-*.mjs`, `scripts/guided-nemeth-report.mjs`,
  `scripts/verify-nemeth-electron-coverage.mjs`,
  `scripts/merge-bana-electron-results.mjs`, `scripts/run-bana-*.mjs`
- The matching `bana:*`, `test:bana:*`, `nemeth:report`,
  `test:nemeth-electron-links`, `test:accuracy` entries in `package.json`

**Keep:** `src/renderer/braille-input.js` and `braille-display-simulator.js`
(code-agnostic, shared with UEB), all of `src/domain/math-tree.js`, everything
UEB, `test/fixtures/nemeth-braille-fixtures.js` and `mathcat-braille-fixtures.js`
(the round-trip oracle), and `docs/guided-nemeth-bana-audit-notes.md` (W2's
reference).

`src/domain/replacement-session.js`: strip the three `guided-nemeth` imports and
the Nemeth branches; **keep the LaTeX path fully working.**
`src/renderer/app.js`: stub the four Nemeth call sites (≈ lines 12, 40, 880/2080,
1687/1729/1828 on `testing`) so the app still boots and LaTeX/UEB still work. A
stub is a clear "Nemeth input is not available on this branch" no-op — not a
crash, and not a silent fallback to something else.

**Definition of done for W0:** `npm test` runs **green** (it is red at 8 failures
today, all inside files you are deleting) and `npm start` boots the app.

---

## 9. The five hard parts — every lane tests the ones it touches

1. **Numeric indicator scoping.** `⠼` opens a number; digits are lower-cell; a new
   `⠼` is required after a blank. The old engine dropped it (`⠼⠒` → `⠒`).
2. **Level indicators are a stack, not flags.** See §5.
3. **Spacing is semantic.** Comparisons blank-surrounded, operations not. The old
   engine doubled the blanks.
4. **`⠰` is subscript *and* English-letter indicator.** Resolve by lookahead. The
   old engine asked the user — we never do.
5. **`⠦` is digit 8 *and* left double quote.** Resolve by numeric mode + lookahead.

---

## 10. LaTeX backend (W5) — `latex.js`

```js
import { defineBackend } from './backend.js';

export const toLatex = defineBackend({
  Number:      (n)    => n.value,
  Identifier:  (n)    => n.name,
  Fraction:    (n, e) => `\\frac{${e(n.numerator)}}{${e(n.denominator)}}`,
  Superscript: (n, e) => `${e(n.base)}^{${e(n.exponent)}}`,
  Root:        (n, e) => n.index ? `\\sqrt[${e(n.index)}]{${e(n.radicand)}}`
                                 : `\\sqrt{${e(n.radicand)}}`,
  …            // one entry per kind in kinds.js — all 14
}, { name: 'latex' });
```

`defineBackend` throws **at module load** if a kind is missing. There is no
opt-out: a kind you cannot render must throw `NemethUnsupportedError` from its own
entry. "Silently absent" is not a reachable state.

The emitted LaTeX must survive `convertLatexToMathML` (`src/main/mathml.js`,
MathJax with packages `base, ams, newcommand, noundefined`). **MathJax collapses
every syntax failure into one generic message**, so bad LaTeX debugs badly — which
is exactly why `test/helpers/latex-compare.js` golden-tests the LaTeX string
itself, upstream of MathJax. It exports
`normalizeLatex(s)` (collapse insignificant whitespace, normalize brace groups)
and `latexEquivalent(a, b) -> { equal, diff }`.

---

## 11. Corpus (W1) — `test/corpus/nemeth-v1.json`

```json
{
  "schemaVersion": 1,
  "source": { "url": "…", "sha256": "…", "retrievedAt": "…" },
  "cases": [
    { "id": "bana-2022:example-13-3", "rule": "13.2", "printedPage": "13-2",
      "latex": "\\frac{a+b}{c-d}", "cells": "⠹⠁⠬⠃⠌⠉⠤⠙⠼",
      "inV1Scope": true, "notes": "" }
  ]
}
```

Sources: BANA Nemeth 2022 + the October 2025 errata (URLs in
`test/fixtures/nemeth-braille-fixtures.js` header and `guided-nemeth/index.js:17-18`).

**Commit the extracted text alongside the JSON.** The previous extraction left its
sources in `/private/tmp` and they are now gone, which is why that corpus can no
longer be verified. Do not repeat that. `latex` may be null where the book gives no
print form. If the PDFs are not fetchable, **stop and message god** — do not fall
back to the old unverifiable extraction.

`src/domain/nemeth/braille-ascii.js` exports `asciiToCells(s)` and `cellsToAscii(s)`
over the standard 64-character Braille-ASCII table, with round-trip tests.

---

## 12. Definition of done (all lanes)

- `npm test` green.
- Your module is pure, imports nothing outside your lane except `kinds.js`,
  `errors.js`, `backend.js`, and has unit tests covering the §9 hard parts it
  touches.
- No `console.log` left behind. No new dependencies. No TODO without an
  accompanying `todo`-marked test.
- Report back: what you built, what you deliberately did not, and anything in this
  spec that fought you.
