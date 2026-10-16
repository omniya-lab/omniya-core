# Nemeth v2 — what shipped, what is deliberately absent, what comes next

The SDD ledger that drove this rewrite lived in a git-ignored workspace and is gone. This file is
the part worth keeping: the decisions a future reader would otherwise have to re-derive, and the
work that was deferred on purpose rather than missed.

## What shipped

A clean-room Nemeth-braille → LaTeX parser: `lexer → levels → parser → latex`, replacing a
~13,790-line engine that had 33 mode flags and one 3,617-line function. The replacement has **no
mode flags**, no function over ~60 lines, and no special-casing of any test case by its cell string.

Two gates, deliberately measuring different things:

| Gate | Command | Measures | State |
|---|---|---|---|
| Correctness | `npm run nemeth:coverage` | 613 externally-verified corpus cases | PASS 204 / REFUSE 359 / DISAGREE 50 / **ERROR 0** |
| Utility | `npm run nemeth:utility` | can a student do their homework | **core 26/26**, tail 0/5 |

`npm test` is 382/382. **`npm test` does NOT include e2e** — run `npm run test:e2e` for that
(see "Known rot" below).

### Why two gates

The correctness gate is a *conformance* suite: it exercises each rule of the Code roughly once, so
frequency in it measures how many rules touch a symbol, **not how often anyone uses one**. Ordering
work by it produced a parser that scored PASS 177 with ERROR 0 and **could not write `a - b`**. The
utility gate exists so that cannot recur, and its core set must stay 100%.

**Never plan from the corpus.** The corpus grades; the utility inventory plans.

## Standing rules — violating these is how this project previously failed

1. **ERROR stays 0.** REFUSE is an honest "not supported yet". A DISAGREE is the parser silently
   producing wrong mathematics. The two are not interchangeable.
2. **Data ships with the grammar it exposes, or it does not ship.** Adding symbol rows alone once
   bought +68 PASS and **11 wrong answers**. The minus sign hit the same trap and shipped only once
   its Rule 3.3.1 guard shipped with it.
3. **Never allowlist a genuine parser gap.** `MANY_TO_ONE_FORWARD_MAP` is for structural
   impossibilities only — cases where the braille genuinely underdetermines the answer. Every entry
   carries a categorised sub-cause and a verified reason.
4. **Deleting a symbol row, test, or gate assertion to keep DISAGREE down is gaming the gate.**
5. **A task graded by a gate must never be the task that widens that gate.**
6. **`banaRef` must be real, correctly applied, and line-accurate** against
   `test/corpus/sources/Nemeth_2022.txt`. The corpus was rebuilt once because fixtures carried
   invented citations.
7. **Corpus case ids are NOT BANA rule numbers.** Ids like `punct_38_*`, `test_9_*` follow the 1972
   green book; **BANA 2022 ends at Rule 26**. This trap was fallen into twice during the rewrite.
   Read rule numbers out of the source text, never off an id.
8. **Nemeth is math-only** — no mixing with literal English text or UEB; the app handles UEB
   elsewhere. But this does **not** mean "no multi-letter names": `sin`/`cos`/`log` and multi-letter
   identifiers are mathematics and in scope. The line is prose vs. named mathematical object.

## Deferred deliberately (not missed)

- ~~Rule 18.4.1 second sentence~~ — done (issue #71): a function name carrying a superscript or subscript written with a level indicator (`cos²x`). A subscript with NO indicator (`log₂x`, `⠇⠕⠛⠆⠀⠭`) is still deferred.
- **Long-tail symbols**: `∫`, `∞`, prime `′`, `|x|`, and θ (whose cell `⠹` *is* the opening fraction
  indicator, so it needs disambiguation, not just a row).
- **Nested radicals** (Rule 16.3) and hypercomplex fractions (13.6).
- **Function names beyond the core five** (`sin cos tan log ln`).
- **Widening `mathml-compare.js`** with a fifth normalization rule — worth ~2 PASS. Deliberately not
  done by a task the gate was grading; **this needs its own task and an independent review.**
- **`⠈⠰` vs `⠠⠸` for double-struck**: BANA (line 718) writes barred/double-struck as `⠠⠸`; the
  corpus uses `⠈⠰` in 20 of 20 cases and `⠠⠸` in zero. We refuse `⠈⠰` rather than encode a
  deviation from the Code or silently pick a side. Revisit if an erratum explains it.
- **`punct_38_4_12`** reads a trailing period as `_{4}`. It is the **only** allowlist entry that is a
  visibly different *answer* rather than a different spelling. Argued against BANA 8.2.7/8.2.8 with a
  control comparison, so it satisfies rule 3 above — but it is the one a future reader should
  revisit first.

## Known rot (pre-existing, not caused by this branch)

Since amended (2026-09-04): the failures and the hang described in this section are gone.
`npm run test:e2e` is **65/65**, measured twice locally and once on a GitHub macOS runner. This
section previously said 33/44 with 11 `enterCommand` timeouts, then amended to 15 failures across
`test/e2e/app.test.js` and others, and said the full suite hung outside a logged-in terminal. If
`test:e2e` goes red or hangs again, treat it as new rot to diagnose, not a reproduction of the
failures once listed here — they no longer apply to this codebase.

## Input path

Nemeth entry is **braille cells only** (`U+2800–U+28FF`); QWERTY letters are rejected by design.
Cells arrive two ways: a hardware braille display, or paste. A third way, **six-key chording on a
plain keyboard** (`f d s` / `j k l` as dots), shipped and was later removed on purpose: those six
letters are ordinary characters in computer braille, and while chording existed a keystroke of `f`
was either dot 1 or the letter `f` with nothing in the event to tell them apart, which silently
corrupted `f(x)` and the Nemeth equals sign `.k`. Typing the computer-braille spelling (see below,
`?a/b#`) reaches the parser without that ambiguity and without holding multiple keys, so chording
had no remaining job once it shipped. There is no cells-only fallback left in its place — the
status-line readback named below (see the computer-braille paragraph) is now what contains a wrong
reading, not a refusal mode. See `CLAUDE.md` for the full account. `src/domain/ueb-cell-buffer.js`
must **not** be used
to feed the Nemeth parser — it flushes on `U+2800`, which Nemeth uses as a *token* (Rule 20/21
comparison spacing, present in 263 of 613 corpus cases); feeding Nemeth through it truncates every
expression at its first space. `src/domain/nemeth-input.js` is the correct accumulator.

"A hardware braille display" above means one sending raw Unicode braille cells. A braille
*keyboard* whose driver is configured for a "computer braille" input table instead translates dot
chords into plain text (its own device-side dots→character step, following a table like liblouis's
`en-us-comp8`) before the OS delivers a keystroke — indistinguishable from QWERTY typing on its
own. `toNemethCells`/`classifyNemethInput` decode this through a specific, verified table —
`src/domain/nemeth/computer-braille-en-us.js` for `en-us-comp8` — instead of rejecting it.

This used to be an opt-in `brailleInputTable` parameter, persisted via
`src/main/settings-storage.js` and toggled from the composer with Ctrl+D, off by default. It is
not anymore: `settings-storage.js` persists nothing today (see its own doc-comment), there is no
Ctrl+D toggle, and **there is no input-table setting at all**. `nemethBrailleInputTable` defaults
to `'auto'`, and `resolveBrailleInputTable` (`src/domain/nemeth-input.js`) picks between cells and
the known table by measurement instead of asking — safe only because cells (`U+2800`–`U+28FF`) and
ASCII are disjoint ranges. It still never guesses between two *text* tables: unexplained input
resolves to `'none'` and is refused rather than half-decoded. The reading is always named on the
status line, because that readback is now the only containment for a wrong detection — do not
remove it. This was changed because a contributor whose display was correctly configured was
refused on every keystroke and had no way to discover a picker existed; see `CLAUDE.md` for the
full account. Do not reuse `braille-ascii.js` for the decode itself — it is 6-dot only and
case-folds (`a`/`A` both decode to the same cell), which loses information a real 8-dot computer
braille keyboard preserves via dot 7.
