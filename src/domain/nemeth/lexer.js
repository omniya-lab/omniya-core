/**
 * Cells -> Token[]. No modes, no state beyond the cursor.
 *
 * Every decision here is made from the symbol table plus a bounded, *pure*
 * lookahead through `matchAt`. The one genuinely ambiguous cell in Nemeth's
 * lower half is the numeric indicator, which is also the simple-fraction
 * closing indicator; it is resolved by looking at the next whole TOKEN, never
 * at the next cell. A cell-level peek is not sufficient: in `⠹⠲⠌⠔⠼⠨⠌⠹⠂⠌⠖⠼`
 * (BANA `?4/9#./?1/6#`, test/corpus/sources/Nemeth_2022.txt line 1662, "4/9 ÷
 * 1/6") the cells after the closing indicator are `⠨⠌`, which longest-matches
 * as a division sign -- but `⠨` on its own is the decimal point, so a peek at
 * that single cell would read the closing indicator as a numeric one. No corpus
 * case has this shape; the example is the Code's, not the oracle's.
 *
 * A blank (U+2800) is a token like any other. Nemeth spacing is semantic --
 * comparisons are blank-surrounded and operations are not -- so blanks are
 * never trimmed, collapsed, or dropped.
 *
 * ## The prefix pass (Rules 5, 6 and 7)
 *
 * Capitalization, alphabet and typeform are written as indicator cells BEFORE
 * the sign they govern. They are not enumerated as symbol rows -- typeform x
 * alphabet x capitalization x 26 letters is several hundred rows, and a symbol
 * row cannot populate `marks.typeform` anyway. Instead a run of indicators is
 * read here and COMPOSED onto the one token it governs, as `marks`. The
 * indicator sets themselves are Rule 5's list (test/corpus/sources/
 * Nemeth_2022.txt lines 2891-2893), Rule 6's (lines 2965-2971) and Rule 7's
 * (lines 3559-3564).
 *
 * Appendix C, "Combinations of Typeform, Alphabetic and Capitalization
 * Indicators" (lines 16430-16463), is the authority for the ORDER: typeform,
 * then alphabet, then capitalization, then the letter. Boldface capitalized
 * English is `_;,` (line 16455) = bold + English-letter + capitalization. The
 * rule bodies agree with it rather than contradicting it -- 6.2.1 (lines
 * 3070-3071) "if the letter is capitalized, the alphabetic indicator precedes
 * the capitalization indicator", and 6.3.4 (lines 3209-3210) says the same of
 * the English-letter indicator -- so `SLOT_ORDER` has one source, not two
 * competing ones.
 *
 * ## Extent of effect: ONE sign, never a run
 *
 * This is the question a prefix pass gets silently wrong, so it is answered
 * from the book and enforced in `readPrefixed`:
 *   - 5.3.1 (lines 2932-2934) the single capitalization indicator "extends
 *     only to the letter which follows it".
 *   - 6.2.3 (lines 3109-3111) a non-English alphabetic indicator "extends only
 *     to the letter which follows it".
 *   - 7.2.1 (lines 3606-3607) a typeform indicator with letters has its
 *     "effectiveness extends only to the letter which follows it".
 *   - 7.2.2 (lines 3653-3657) a typeform indicator with numerals runs to the
 *     next space, numeric indicator, terminator or typeform indicator -- but it
 *     is "always followed by the numeric indicator", and one numeric indicator
 *     plus its digits is a single token here, so that too is one sign.
 * The run-scoped forms are therefore OUT OF SCOPE and refuse: the DOUBLE
 * capitalization indicator `⠠⠠` of 5.3.2 (lines 2942-2945, "extends to all of
 * the letters which immediately follow it"), which is a mode by construction
 * and whose domain is Roman numerals and abbreviations this parser has no
 * notion of, and the word/phrase typeform indicators of 7.3 (lines 3707-3708,
 * with their own indicator set at lines 3565-3577).
 *
 * ## What this pass deliberately does not read
 *
 *   - The Russian indicator `@@` (line 2971): the Code gives no Russian
 *     alphabet to go with it and no corpus case uses it, so it is not guessed
 *     at. Script type `@` (line 3563) IS read now -- it is a typeform row like
 *     the other four -- but `latex.js` refuses it on a letter; see the note on
 *     `withTypeform` for the Code-versus-oracle conflict that sits there and
 *     nowhere else.
 *   - Hebrew `,,` (line 2970): the same two cells as the double capitalization
 *     indicator of 5.3.2, and 6.1.2 gives the Code exactly one Hebrew letter.
 *     Both readings refuse together rather than one being preferred blind.
 *   - Alternative Greek forms `.@` (line 2968, Rule 6.2.2 at line 3096): 6.1.5
 *     lists five, of which LaTeX names four, and 6.2.2 says they are used "only
 *     when the author has assigned distinct meanings" -- a judgement the cells
 *     do not carry. No corpus case uses them.
 *   - The English-letter indicator `;` standing ALONE (Rule 6.3): that cell is
 *     also the subscript indicator, and 6.3.1's conditions (d) and (e) are about
 *     surrounding spaces and punctuation, which this pass has no grammar for.
 *     `;` is read as an alphabetic indicator only where 7.2.1 leaves no other
 *     reading -- directly after a typeform indicator.
 *
 * Rule 7.4 (line 3774) governs when a transcriber writes NO typeform indicator
 * at all -- regular type, typeform without mathematical significance, italics
 * used decoratively. It constrains the forward direction only: there is nothing
 * in the cells for this pass to act on, and an indicator that IS present is
 * still read the same way.
 *
 * ## Homographs the Code resolves by spacing
 *
 * `⠨` before a letter is the Greek-letter indicator, but `⠨⠅` is also the
 * equals sign (Rule 21's symbol list, line 10291). Measured on the corpus: 169
 * occurrences, of which 157 are blank-surrounded, and NOT ONE of the 142 cases
 * containing those cells targets a Greek kappa -- 141 of them target an
 * equals-family sign. Likewise `⠸⠇` is identity (line 10298, Rule 21.3 at line
 * 10631) as well as German ell, `⠠⠗` is the relation sign of 21.5 (lines
 * 10655-10664) as well as capital R, `⠰⠆` is the proportion sign (line 10314)
 * as well as a subscript 2, and `⠐⠅` is the less-than sign (line 10302) as well
 * as a baseline indicator followed by the letter k.
 *
 * The Code separates them by 21.13 (lines 10775-10779): "A space must be left
 * on either side of a comparison symbol." So each is a `comparison` row carrying
 * `unlessUnspaced`, and when the cells are not blank-surrounded the row falls
 * back to its first cell, which is the indicator. The ends of the input count
 * as blanks -- the space 21.13 requires sits outside a transcribed expression,
 * and the corpus shows the shape: `sre-aata:AataExpression_330` is the bare
 * cells `⠸⠇` for `≡`.
 *
 * 21.13's second sentence is half implemented, on purpose: see `isSpaced` for
 * the indicator half, and for why the punctuation and grouping half is left out
 * rather than guessed at.
 */

import { NemethUnsupportedError } from './errors.js';
import rows from './symbols.json' with { type: 'json' };
import { matchAt } from './symbols.js';

const LEVEL_KINDS = new Set(['level', 'baseline']);

const CELL_MIN = 0x2800;
const CELL_MAX = 0x28ff;
const SIX_DOT_MASK = 0x3f;
const BLANK = '⠀';

// Token kinds that can open a numeral, and so make a leading `⠼` a numeric
// indicator rather than a fraction close (BANA 3.3 against Rule 13). `decimal`
// is here because 3.2.3 lets the decimal point open one -- Example 3-5 (line
// 828) is `#.35`.
const NUMERAL_START = new Set(['digit', 'decimal']);

// Appendix C's column order, outermost indicator first.
const SLOT_ORDER = ['typeform', 'alphabet', 'capitalization'];

// The one-cell indicators Rule 2 writes BEFORE the sign they apply to, taken
// from the table rather than listed here, so a new level indicator row extends
// the Rule 21.13 spacing test as data.
const PRECEDING_INDICATOR_CELLS = new Set(
  rows.filter((row) => row.cells.length === 1 && LEVEL_KINDS.has(row.kind)).map((row) => row.cells)
);

function describeCodepoint(code) {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Accept U+2800-U+28FF only, reducing 8-dot cells to their 6-dot form. One
 * input code unit maps to exactly one output cell, so offsets stay comparable
 * with the caller's string.
 */
function normalize(input) {
  if (typeof input !== 'string') {
    throw new NemethUnsupportedError({ detail: `lex() expects a string, received ${typeof input}` });
  }
  let cells = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.codePointAt(i);
    if (code < CELL_MIN || code > CELL_MAX) {
      throw new NemethUnsupportedError({
        offset: i,
        cells: input,
        detail: `${describeCodepoint(code)} is not a braille cell (expected U+2800-U+28FF)`
      });
    }
    cells += String.fromCodePoint(CELL_MIN + (code & SIX_DOT_MASK));
  }
  return cells;
}

/**
 * Is this sign blank-surrounded in the sense BANA Rule 21.13 means?
 *
 * Sentence one (line 10776) is the `after` test and the outer half of `before`.
 * Sentence two (lines 10777-10779) -- "a space is not left between the
 * comparison symbol and any punctuation symbol, grouping symbol, or INDICATOR
 * which applies to it" -- is the backward walk: a level or baseline indicator is
 * written before the sign it applies to (Rule 2), so it sits INSIDE the space
 * 21.13 requires and must be stepped over to find that space. Example 14-94
 * (Nemeth_2022.txt lines 6939-6945) is exactly this shape: `!;u ;.k a`, where
 * "the subscript indicator before the equals sign keeps this symbol at the
 * subscript level". Without the walk those cells read as a Greek kappa.
 *
 * Only indicators are stepped over, not the punctuation and grouping symbols
 * sentence two also names. Rule 19's grouping rows arrived in Task 5e and the
 * temptation with them is to treat an adjacent `⠷`/`⠾` as satisfying the space.
 * Measured against the corpus, that trades one wrong reading for another, so it
 * stays unimplemented:
 *   - `mathcat-rules:no_space_comparison_151_16` is `⠷⠐⠅⠠⠀⠨⠅⠠⠀⠨⠂⠾` = "(<, =, >)",
 *     three comparison signs named as list members and unspaced against the
 *     parentheses. Sentence two says they are comparison signs; we read the
 *     first as a baseline indicator with the letter k.
 *   - `mathcat-rules:letter_26_b_19` ends `⠀⠰⠠⠗⠾` and its target is
 *     `<mi mathvariant='normal'>R</mi>`, the LETTER R, in a right parenthesis
 *     after a space. Counting that parenthesis as the space turns it into Rule
 *     21.5's relation sign -- an `<mo>` where the corpus says `<mi>`.
 * Sentence two's own qualifier is what separates them: the grouping symbol must
 * be one "which applies to" the comparison sign, and nothing in the cells says
 * whether it does. Both cases refuse today for other reasons, so neither
 * reading ships; the half stays out until something in the Code decides it.
 */
function isSpaced(cells, index, len) {
  let start = index;
  while (start > 0 && PRECEDING_INDICATOR_CELLS.has(cells[start - 1])) start -= 1;
  const before = start === 0 ? BLANK : cells[start - 1];
  const after = index + len >= cells.length ? BLANK : cells[index + len];
  return before === BLANK && after === BLANK;
}

/**
 * BANA 3.2.3 (test/corpus/sources/Nemeth_2022.txt lines 818-819): "The decimal
 * point is regarded as a numeric symbol only when it is followed by a number."
 * The numeric indicator's own reading turns on the same test read the other way
 * -- `⠼` opens a numeral when a numeral follows and closes a simple fraction
 * (Rule 13) when one does not -- so one predicate serves both rows and a third
 * ambiguous cell is a table entry rather than a branch here.
 *
 * The test is on the next whole SYMBOL, not the next cell. `?4/9#./?1/6#`
 * (Nemeth_2022.txt line 1662, "4/9 ÷ 1/6") is the shape that forces it: after
 * the closing fraction indicator come the cells `⠨⠌`, which longest-match as
 * the division sign of Rule 20 (line 9857) -- but `⠨` alone is the decimal
 * point, so a one-cell peek would read that closing indicator as an opening
 * numeric one.
 */
function withNumeralAlternative(match, cells, index) {
  if (!match || !match.unlessFollowedByNumeral) return match;
  const next = symbolAt(cells, index + match.len);
  if (next && NUMERAL_START.has(next.kind)) return match;
  return { ...match, ...match.unlessFollowedByNumeral };
}

/**
 * BANA 18.4.1 (test/corpus/sources/Nemeth_2022.txt lines 9186-9190): "A space is
 * left after an unmodified function name or its abbreviated form."
 *
 * That space is what makes a run of letter cells a function name rather than the
 * letters it is spelled with -- Rule 18's whole table is ordinary letter cells
 * (`sin` is `SIN`, line 9113), so nothing else in the braille separates the two.
 * The oracle carries the discrimination both ways on the same two cells:
 * `sre-aata:AataExpression_281` is `⠎⠤⠞⠀⠨⠅⠀⠇⠝` and targets `<mi>l</mi><mi>n</mi>`
 * (no space after, and the input ends there), while `AataExpression_284` is
 * `⠋⠷⠭⠾⠀⠨⠅⠀⠇⠝⠀⠭` and targets `<mi>ln</mi>` applied to x.
 *
 * The end of the input is deliberately NOT counted as the space, unlike
 * `isSpaced` above: 21.13's space sits OUTSIDE a transcribed expression, so its
 * absence at the ends says nothing, whereas 18.4.1's space sits BETWEEN the name
 * and the argument it applies to, and a function name with no argument after it
 * is not a function application at all. `AataExpression_281` is that case
 * exactly, and reading it as `\ln` would be a wrong answer, not a refusal.
 *
 * 18.4.1's second sentence -- if the name carries a superscript or subscript
 * the space follows THAT instead (Example 18-8, `cos~2 x`; issue #71) -- is read
 * for scripts introduced by an explicit level indicator, `⠘` or `⠰`. The lexer
 * has no script grammar, so it does not walk one: the script is taken to run to
 * the next space, which is where 14.8.4 puts the end of a script on a function
 * name ("the space which follows such a superscript or subscript reinstates the
 * level in effect", Nemeth_2022.txt lines 6793-6795). A script with a space
 * inside it is not something the Code writes on a function name, so a name
 * whose script is never closed by a space stays letters, as it always did.
 *
 * Still out of scope: a subscript with NO indicator, `⠇⠕⠛⠆⠀⠭` (log base 2 of x,
 * `log_77_4_8`), which reads as letters and refuses further down.
 */
const FUNCTION_SCRIPT_INDICATORS = new Set(['⠘', '⠰']);

function spaceFollows(cells, index, len) {
  const after = index + len;
  if (cells[after] === BLANK) return true;
  if (!FUNCTION_SCRIPT_INDICATORS.has(cells[after])) return false;
  let end = after;
  while (end < cells.length && cells[end] !== BLANK) end += 1;
  return end < cells.length && end > after + 1;
}

/**
 * The reading a row declares for when the spacing its primary reading requires
 * is absent -- `unlessUnspaced` for BANA 21.13's two spaces, `unlessSpaceFollows`
 * for 18.4.1's one.
 *
 * There are exactly two ways such a row can lose to its twin, and which one
 * applies is a property of the row, so the row says which:
 *
 *   `{ maxLen }`  -- the cells are not one symbol at all. `⠨⠅` unspaced is the
 *                    Greek indicator plus the letter k, and `⠇⠝` with no space
 *                    after it is the letters l and n, so the trie is re-run
 *                    against a string truncated to the declared length and the
 *                    remaining cells are lexed on their own.
 *   fields        -- the cells ARE one symbol, a different one. `⠈⠱` is the
 *                    simple tilde twice over: an operation sign, U+301C, in
 *                    Rule 20's list (line 9910) and a comparison sign, U+223C,
 *                    in Rule 21's (line 10325), on the same two cells. No
 *                    truncation can reach the second reading, so the row
 *                    declares the fields to override, exactly as
 *                    `unlessFollowedByNumeral` does.
 */
function alternativeReading(match, alternative, cells, index) {
  if (!alternative.maxLen) return { ...match, ...alternative };
  return matchAt(cells.slice(0, index + alternative.maxLen), index);
}

/**
 * Apply a row's declared alternative reading when the context shows the row's
 * primary reading is wrong. Every alternative is data-declared, and a row
 * carries at most one spacing test: 21.13's `unlessUnspaced` belongs to
 * comparison signs, 18.4.1's `unlessSpaceFollows` to function names.
 *
 * A fallback is disambiguated in its turn: truncating `⠨⠅` down to `⠨` lands on
 * the decimal-point row, whose own reading still depends on what follows it.
 */
function disambiguate(match, cells, index) {
  if (match.unlessUnspaced && !isSpaced(cells, index, match.len)) {
    return withNumeralAlternative(alternativeReading(match, match.unlessUnspaced, cells, index), cells, index);
  }
  if (match.unlessSpaceFollows && !spaceFollows(cells, index, match.len)) {
    return withNumeralAlternative(alternativeReading(match, match.unlessSpaceFollows, cells, index), cells, index);
  }
  return withNumeralAlternative(match, cells, index);
}

/**
 * The fully-disambiguated symbol at `index`, or null if none starts there.
 *
 * `withNumeralAlternative` reaches back through this rather than calling
 * `matchAt` directly, because the question 3.2.3 and Rule 13 both ask is about
 * the next SYMBOL, and a raw trie hit is not yet one: `⠼⠨⠂⠒` (`#.13`) hits
 * `⠨⠂`, Rule 21's greater-than sign, at the second cell, and only 21.13's
 * spacing test turns that back into the decimal point that makes the leading
 * `⠼` a numeric indicator instead of a fraction close. The mutual recursion is
 * bounded: every step moves strictly forward through the cells.
 */
function symbolAt(cells, index) {
  const match = matchAt(cells, index);
  return match ? disambiguate(match, cells, index) : null;
}

function resolve(cells, index) {
  const match = matchAt(cells, index);
  if (!match) {
    // No `userDetail` here, deliberately. An unassigned cell is ambiguous in
    // exactly the way the generic sentence exists for: `⠫` is the shape
    // indicator -- valid Nemeth this pipeline does not read, and the commonest
    // unknown cell in the corpus at 31 cases -- so "check the key you pressed"
    // would accuse an author of a typo they did not make. Nothing here can tell
    // a wrong key from a construct we cannot read, so it says neither.
    throw new NemethUnsupportedError({
      offset: index,
      cells,
      detail: `no Nemeth symbol starts at cell ${index} (${describeCodepoint(cells.codePointAt(index))})`
    });
  }
  return disambiguate(match, cells, index);
}

function makeToken(match, cells, start, end, marks) {
  const token = {
    kind: match.kind,
    value: match.value,
    cells: cells.slice(start, end),
    offset: start,
    len: end - start
  };
  // The spacing class BANA Rules 20 and 21 put the sign in, where its row
  // declares one. `parser.js` reads it to decide what a blank next to this
  // token can mean; see the Rule 21.13 seam there.
  if (match.role) token.role = match.role;
  // Whether BANA Rule 20 also writes this sign before a term it applies to,
  // rather than only between two. The cell is the same either way -- Rule 20's
  // negative sign and sign of subtraction are both `⠤` -- so the row is what
  // says the reading is available and `parser.js` decides from position which
  // one is in force. Rows without it (`×`, `÷`, `⋅`) stay binary-only.
  if (match.prefix) token.prefix = true;
  // Which of BANA Rule 13's four indicator pairs this sign belongs to. 13.2.1
  // and 13.6 each say their own indicators "must be used to enclose" a fraction
  // of that order, so the order is what pairs an opening indicator with its own
  // line and closing indicator; `parser.js` reads it at that seam.
  if (match.order) token.order = match.order;
  if (marks) token.marks = Object.freeze(marks);
  return Object.freeze(token);
}

function fills(match, slot) {
  return Boolean(match && match.slots && Object.hasOwn(match.slots, slot));
}

/**
 * Which Appendix C column this indicator occupies here.
 *
 * `⠸` and `⠨` each name a typeform AND an alphabet (boldface/German,
 * italic/Greek), so the column is not a property of the cell. 7.2.1 (line 3605)
 * settles it: "The typeform indicator for a letter must always be followed by
 * an alphabetic indicator", and 7.2.2 (line 3656) "The typeform indicator for a
 * numeral is always followed by the numeric indicator". So a two-column
 * indicator is a typeform exactly when the NEXT symbol can fill the alphabet
 * column or opens a numeral, and an alphabet indicator otherwise. That is what
 * keeps `⠨⠠⠛` (Example 5-2, cells at line 2912) reading as capital Greek gamma rather
 * than as an italic with no alphabet: `⠠` fills only the capitalization column.
 */
function chooseSlot(match, next, filledThrough) {
  const candidates = SLOT_ORDER.filter((slot, i) => i > filledThrough && fills(match, slot));
  if (candidates.length < 2) return candidates[0] ?? null;
  return fills(next, 'alphabet') || (next && next.kind === 'numeric') ? 'typeform' : 'alphabet';
}

/**
 * What the run's OPENING cells are before `unlessFollowedByNumeral` demotes them.
 *
 * `⠠` and `⠨` are each a Rule 3 numeric mark first -- the mathematical comma
 * (3.2.2, test/corpus/sources/Nemeth_2022.txt lines 808-810; the same sign is
 * in Rule 8's punctuation table at line 3887) and the decimal point (3.2.3,
 * lines 818-819) -- and become a Rule 5/6 indicator only because no numeral
 * follows. So when the run turns out to govern something Rules 5-7 cannot
 * govern, blaming Rule 5 alone points the reader at the wrong chapter: `⠠⠀` in
 * `(0, 1, 2)` (BANA Example 8-34, lines 4229-4230) is a comma before a space,
 * not a capitalization indicator before a space. The table already knows this;
 * this reads it back rather than restating it.
 */
function leadingReading(cells, index, governedKind) {
  const row = matchAt(cells, index);
  if (!row || !row.unlessFollowedByNumeral) return '';
  return (
    ` -- and the table leads with a different reading of these cells, the ${row.kind} of ` +
    `BANA ${row.banaRef}, for which this pipeline has no grammar beside a ${governedKind} either`
  );
}

/**
 * `resolve`, for the cell right behind a Greek-letter indicator.
 *
 * Theta is the one Greek letter whose cell is also a sign of its own: BANA
 * 6.1.4 gives it Braille-ASCII `?` (dots 1-4-5-6), the same cell as the
 * simple-fraction opener (13.2.1), and capital theta is `.,?`, whose capital
 * indicator plus that cell is the complex-fraction opener `⠠⠹` (13.6) to the
 * trie. Behind the Greek indicator neither fraction reading can stand -- an
 * indicator governs a letter -- so the cell is read as the letter, and the
 * capital indicator is split off the complex opener. Everywhere else the
 * cells keep their fraction meaning; this fires only after `⠨` has been read
 * as the Greek indicator.
 */
function resolveBehindIndicator(cells, index, greek) {
  if (greek) {
    if (cells[index] === '⠹') {
      return Object.freeze({ cells: '⠹', kind: 'letter', value: '?', len: 1, banaRef: '6.1.4' });
    }
    if (cells[index] === '⠠' && cells[index + 1] === '⠹') {
      // The one-cell row is the comma with its capital-indicator alternative
      // (5.1.1); a numeral cannot follow here, so the alternative is the reading.
      const row = matchAt(cells.slice(0, index + 1), index);
      return { ...row, ...row.unlessFollowedByNumeral };
    }
  }
  return resolve(cells, index);
}

/**
 * Read a run of indicator cells and the single sign they govern.
 *
 * Returns the governed match, the composed marks, and the end offset. Refusal
 * -- not a guess -- is the answer whenever the run is not a shape Rules 5-7
 * define.
 */
function readPrefixed(cells, index) {
  const marks = {};
  let filledThrough = -1;
  let at = index;
  let match = resolve(cells, at);
  while (fills(match, 'typeform') || fills(match, 'alphabet') || fills(match, 'capitalization')) {
    const greek = marks.alphabet === 'greek' || (match.slots && match.slots.alphabet === 'greek');
    const next = at + match.len < cells.length ? resolveBehindIndicator(cells, at + match.len, greek) : null;
    const slot = chooseSlot(match, next, filledThrough);
    if (!slot) {
      throw new NemethUnsupportedError({
        offset: at,
        cells,
        detail: `indicator "${match.value}" cannot follow the indicators before it in Appendix C's order (typeform, alphabet, capitalization)`
      });
    }
    marks[slot] = match.slots[slot];
    filledThrough = SLOT_ORDER.indexOf(slot);
    at += match.len;
    if (!next) {
      throw new NemethUnsupportedError({ offset: at, cells, detail: 'indicator run governs nothing' });
    }
    match = next;
  }
  const governsLetter = Boolean(marks.alphabet || marks.capitalization);
  const expected = governsLetter ? 'letter' : 'numeric';
  if (match.kind !== expected) {
    throw new NemethUnsupportedError({
      offset: at,
      cells,
      detail:
        (governsLetter
          ? `an alphabetic or capitalization indicator governs a ${match.kind}, not the letter BANA Rules 5.1.1 and 6.2.3 require`
          : `a typeform indicator governs a ${match.kind}; BANA Rule 7.2.1 requires an alphabetic indicator for a letter and 7.2.2 a numeric indicator for a numeral`) +
        leadingReading(cells, index, match.kind)
    });
  }
  requireGreek(match, marks, cells, at);
  return { match, marks, end: at + match.len };
}

/**
 * Eta `:` (U+2831) and chi `&` (U+282F) are letters only in the Greek alphabet
 * (BANA 6.1.4, Nemeth_2022.txt lines 3023-3048). Their rows are `greekOnly`
 * because neither cell is an English letter, so reading them anywhere else as a
 * letter would invent a letter the Code does not have. Everywhere else they
 * stay refused, exactly as they were before the rows existed.
 */
function requireGreek(match, marks, cells, at) {
  if (!match.greekOnly || marks.alphabet === 'greek') return;
  throw new NemethUnsupportedError({
    offset: at,
    cells,
    detail: `the cell "${match.value}" is a letter only after the Greek-letter indicator (BANA ${match.banaRef})`
  });
}

/**
 * The English-letter indicator standing ALONE (Rule 6.3.1), read where its
 * position leaves no other reading.
 *
 * The header note above explains why this cell was refused: `⠰` is also the
 * subscript indicator, and 6.3.1's criteria (d) and (e) are about spacing. The
 * subscript reading, though, needs a base for the subscript to hang from, and
 * 6.3.1(d) puts the English-letter indicator after a space or at the start --
 * exactly where no base can be. So the two readings are separated by what
 * precedes the cell, which is evidence the cells carry, not a guess. A blind
 * contributor typing `x = 3` as `;x .k #3` (issue #22) was refused on the first
 * two cells before this existed.
 *
 * It is read only when a plain letter follows AND that letter is followed by the
 * end of the input or a blank (criterion (e)). The second condition is not
 * pedantry: "preceded by a blank" does not rule out the subscript reading, since
 * a LEFT subscript (Rule 11) also opens with `⠰` and no base before it.
 * `mathcat-rules:left_sup_75_4`, `⠰⠭⠐⠝⠰⠽`, is exactly that -- subscript x, a
 * baseline indicator, then n -- and without (e) it silently parsed as the letter
 * x, turning an honest refusal into a wrong answer. A left script is always
 * followed by the baseline indicator, never by a space, so (e) separates them.
 * Punctuation after the letter, which (e) also allows, is not accepted: Rule 8's
 * punctuation signs share cells with other signs, and refusing is the safe side
 * of that. `⠀⠰⠆⠀` (the proportion sign, Rule 21) and `⠀⠰⠨⠅⠀` are not letters
 * after the cell, so they fall through to the table unchanged.
 *
 * Returns the letter match, or null when the cell is not this indicator.
 */
function englishLetterAlone(cells, index) {
  if (cells[index] !== '⠰') return null;
  if (index > 0 && cells[index - 1] !== BLANK) return null;
  if (index + 1 >= cells.length) return null;
  const letter = symbolAt(cells, index + 1);
  if (!letter || letter.kind !== 'letter' || letter.greekOnly) return null;
  const after = cells[index + 1 + letter.len];
  return after === undefined || after === BLANK ? letter : null;
}

export function lex(input, context = {}) {
  const cells = normalize(input);
  const tokens = [];
  let index = 0;
  while (index < cells.length) {
    const alone = englishLetterAlone(cells, index);
    if (alone) {
      const end = index + 1 + alone.len;
      tokens.push(makeToken(alone, cells, index, end, { alphabet: 'english' }));
      index = end;
      continue;
    }
    const match = resolve(cells, index);
    if (match.kind === 'prefix') {
      const run = readPrefixed(cells, index);
      tokens.push(makeToken(run.match, cells, index, run.end, run.marks));
      index = run.end;
      continue;
    }
    requireGreek(match, {}, cells, index);
    tokens.push(makeToken(match, cells, index, index + match.len));
    index += match.len;
  }
  return tokens;
}
