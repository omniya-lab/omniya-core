/**
 * Assign a script level to every token and drop the level indicators themselves.
 *
 * A level is an ABSOLUTE PATH from the baseline, held as a string over the
 * alphabet `^` (superscript) and `_` (subscript): `''`, `'^'`, `'_'`, `'^^'`,
 * `'^_'`, ... This is not a stylistic choice. BANA Rule 2's indicator table
 * (test/corpus/sources/Nemeth_2022.txt lines 652-670) enumerates the level
 * indicators as a closed set of absolute paths -- "Superscript with Subscript"
 * is one indicator meaning the subscript slot of a superscript, not "up then
 * down". Under a signed-integer model `x_a^n` computes -1 + 1 = 0 and parses
 * silently as `x_a n`; under paths it is `'_'` then `'^'`, two depth-1 siblings
 * of `x`, and the wrong reading is not expressible.
 *
 * This pass only LABELS. Which base owns which script is the parser's job, and
 * with paths that question reduces to a prefix comparison.
 *
 * Level is therefore NOT a pure function of the level-indicator tokens. Rule
 * 14.6 (lines 6420-6439) states that a first-order numeric subscript is written
 * with no subscript indicator at all, so `⠭⠂` is x sub 1 (Example 14-36) with
 * nothing in the cells to say so. That promotion is level labelling, not
 * grammar, so it happens here; see `startsImplicitSubscript`.
 *
 * `afterBaseline` records that an explicit baseline indicator immediately
 * preceded the token -- through an intervening level indicator, because that is
 * exactly the shape Rule 14.11.2 (lines 7263-7267) defines: Example 14-124
 * (line 7269) writes non-simultaneous scripts as `a~n";m` -- baseline
 * indicator, then subscript indicator. It is the sole carrier of the `x_1^2`
 * vs `(x_1)^2` distinction and is unrecoverable once the indicators are gone;
 * `parser.js` consumes it.
 *
 * A BLANK is a level event too, and only sometimes. Rule 14.8 enumerates which
 * spaces reset the level and which preserve it: 14.8.7 (lines 6907-6911) a space
 * followed by a comparison symbol "initiates the baseline level"; 14.8.4 (line
 * 6787) a space after a shape or a function name preserves it; 14.8.5 (line
 * 6852) a space partitioning a numeral preserves it; 14.8.6 (line 6860) a space
 * around an ellipsis or long dash preserves it; and 14.8.8 (line 6947) "Any
 * other symbol or situation preserves the level that is already in effect."
 * Only 14.8.7 is implemented, because it is the only one whose neighbouring
 * construct this pass can identify from a symbol row; the rest fall to 14.8.8's
 * preserve, which is also what they ask for. 14.8.3 (lines 6744-6749), the reset
 * before literary or unrelated text, needs a notion of text this pipeline does
 * not have.
 *
 * `⠐` is both the baseline indicator (Rule 2) and the multipurpose indicator
 * (Rule 24). This pass does not have to choose: on the level it does the same
 * thing either way (returning to the baseline is a no-op when already there),
 * and Rule 24.1's one job at the baseline -- 24.1.b, "used between a letter and
 * a succeeding numeric symbol to indicate that the corresponding numeral is not
 * a subscript" (lines 11919-11926; Example 24-1 at line 11927 is `⠭⠐⠢`) -- is
 * to suppress the Rule 14.6 promotion above, and `afterBaseline` expresses
 * that directly.
 */

import { NemethUnsupportedError } from './errors.js';

// Rule 2 enumerates level indicators to three components and no further.
const MAX_LEVEL_DEPTH = 3;

const SUBSCRIPT = '_';

// Rule 14.6(c): the sign a bare numeric subscript belongs to must be "an
// abbreviated function name or a letter which has a separate identity"
// (test/corpus/sources/Nemeth_2022.txt lines 6430-6437). `letter` is the only
// such kind the symbol table has rows for; naming the set here is what lets the
// Greek, function-name and prime rows extend the rule as data.
const IMPLICIT_SUBSCRIPT_BASES = new Set(['letter']);

function isComparison(token) {
  return Boolean(token) && token.role === 'comparison';
}

/**
 * BANA 14.8.7 (test/corpus/sources/Nemeth_2022.txt lines 6907-6911): "The
 * space, or transition to a new braille line, which is followed by a comparison
 * symbol terminates the effect of a level indicator already in effect and
 * initiates the baseline level. The space after a comparison symbol preserves
 * the level that is already in effect." Both halves are here: this predicate,
 * and -- for the trailing space -- the absence of one, since every other space
 * falls to 14.8.8 (line 6947), "Any other symbol or situation preserves the
 * level that is already in effect."
 *
 * Example 14-92 (lines 6923-6929) is this rule and is a corpus case verbatim:
 * `#2~x "k #3~x` = `⠼⠆⠘⠭⠀⠐⠅⠀⠼⠒⠘⠭` (`mathcat-rules:comparison_79_g_2`), 2^x <
 * 3^x, where nothing but the space returns the less-than sign to the baseline.
 * Without the reset it is labelled `^`, the Rule 21.13 seam in `parser.js` does
 * not match, and the case refuses.
 *
 * A level indicator BETWEEN the space and the sign makes the reset a no-op --
 * it sets the level itself -- which is how Example 14-94 (lines 6939-6945) keeps
 * its equals sign at the subscript level. So this looks only at the token
 * immediately after the space.
 */
function endsScriptLevel(token, next) {
  return token.kind === 'blank' && isComparison(next);
}

/**
 * Consecutive level cells spell one indicator: `⠘⠘` is the single symbol
 * "superscript with superscript", i.e. the path '^^'.
 */
function readLevelPath(tokens, start) {
  let path = '';
  let index = start;
  while (index < tokens.length && tokens[index].kind === 'level') {
    path += tokens[index].value;
    index += 1;
  }
  return { path, index };
}

/**
 * Label a run of digits as a numeric subscript of the level it was written at.
 * Condition (d) makes the run numeric-only, so it is the WHOLE subscript and
 * the caller's own `level` is left alone: what follows the run reads at the
 * level it was already at (BANA's Rule 24.1.c calls the `⠐` that can follow one
 * a multipurpose indicator, not a baseline indicator, for that same reason).
 */
function readImplicitSubscript(tokens, start, level) {
  const scriptLevel = level + SUBSCRIPT;
  const digits = [];
  let index = start;
  while (index < tokens.length && tokens[index].kind === 'digit') {
    // `implicit` records that Rule 14.6 put this digit at `scriptLevel` with
    // nothing in the cells saying so. `parser.js` reads it to tell a promoted
    // run from digits the writer indicated explicitly.
    digits.push(Object.freeze({ ...tokens[index], level: scriptLevel, afterBaseline: false, implicit: true }));
    index += 1;
  }
  return { digits, index };
}

/**
 * Rule 14.6: a digit run directly after a letter, carrying neither a numeric
 * indicator nor a multipurpose indicator, is a numeric subscript written with
 * no subscript indicator at all (Example 14-36, `⠭⠂` = x sub 1).
 *
 * Of the four conditions, two are tested and two are not.
 * (a), right and not left: free, because this pass has no left-script notion,
 *      so every script it labels is a right one.
 * (b), first order only: the `endsWith` test. A subscript inside a subscript is
 *      second order, and Example 14-40 shows the Code writing that one out.
 * (c), the base: the `IMPLICIT_SUBSCRIPT_BASES` test.
 * (d), numeric only, no scripts of its own: self-enforcing rather than tested.
 *      Where it fails the Code REQUIRES the explicit `⠰` (Examples 14-46 to
 *      14-49), so a bare digit run cannot be one of those cases.
 *
 * `afterBaseline` is Rule 24.1.b: an explicit `⠐` between the letter and the
 * digits says the numeral is on the baseline, and blocks the promotion.
 */
function startsImplicitSubscript(previous, level, afterBaseline) {
  if (!previous || afterBaseline) return false;
  if (!IMPLICIT_SUBSCRIPT_BASES.has(previous.kind) || previous.level !== level) return false;
  return !level.endsWith(SUBSCRIPT) && level.length < MAX_LEVEL_DEPTH;
}

/**
 * The contrapositive of Rule 14.6, and the only thing in the cells that can
 * catch a base this pass has misread.
 *
 * Where conditions (a)-(d) hold the Code says the subscript indicator "is not
 * used", so an indicator standing before a first-order numeric-only subscript
 * proves one of them fails -- and the only one that can fail without leaving a
 * trace in these very cells is (c), the base. Example 14-45 (line 6514) is
 * exactly that: `seven;3` carries the indicator "because condition c does not
 * hold", the base being the word "seven" and not the letter that happens to sit
 * against the indicator. Reading it as that letter would hand on a subscript
 * hung off the wrong base, so it is refused instead.
 *
 * Condition (d) is what the digit walk tests: only a run that ends the input or
 * ends at a baseline indicator is numeric-only with no scripts of its own. A
 * run followed by an operator, a letter or a further level indicator is one of
 * Examples 14-46 to 14-49, where the indicator is genuinely required.
 */
function redundantSubscriptIndicator(tokens, start, previous, level, afterBaseline) {
  if (!startsImplicitSubscript(previous, level, afterBaseline)) return false;
  let index = start;
  while (index < tokens.length && tokens[index].kind === 'digit') index += 1;
  if (index === start) return false;
  return index === tokens.length || tokens[index].kind === 'baseline';
}

export function resolveLevels(tokens, context = {}) {
  const resolved = [];
  let level = '';
  let afterBaseline = false;
  let index = 0;
  // Rule 14.8.4 (Nemeth_2022.txt lines 6793-6795): when a function name carries
  // a script, "the space which follows such a superscript or subscript
  // reinstates the level in effect" -- the level the NAME was written at, not
  // the script's. `scriptedName` holds that level from the moment a level
  // indicator directly follows a function name until the first space after it.
  let scriptedName = null;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token.kind === 'baseline') {
      level = '';
      afterBaseline = true;
      index += 1;
      continue;
    }

    if (token.kind === 'level') {
      const read = readLevelPath(tokens, index);
      if (read.path.length > MAX_LEVEL_DEPTH) {
        throw new NemethUnsupportedError({
          offset: token.offset,
          cells: token.cells,
          detail: `level path "${read.path}" is deeper than the ${MAX_LEVEL_DEPTH} components BANA Rule 2 enumerates`
        });
      }
      if (
        read.path === level + SUBSCRIPT &&
        redundantSubscriptIndicator(tokens, read.index, resolved.at(-1), level, afterBaseline)
      ) {
        throw new NemethUnsupportedError({
          offset: token.offset,
          cells: token.cells,
          detail:
            'a subscript indicator stands before a first-order numeric subscript that ' +
            'BANA Rule 14.6 writes without one, so this base is not the single letter it looks like'
        });
      }
      // A level indicator asserts that a script follows it. If nothing does, that
      // assertion is unmet and the cells cannot be read -- dropping the indicator
      // silently answers `⠭⠘` as plain `x`, which is a confident wrong answer where
      // a refusal was available. The lexer already refuses a dangling typeform or
      // capitalisation run for the same reason ('indicator run governs nothing');
      // this is that rule for level indicators. A trailing BASELINE indicator is
      // deliberately not covered: it asserts a return to the baseline, not that
      // anything follows, so with nothing after it it is vacuous rather than unmet.
      if (read.index >= tokens.length) {
        throw new NemethUnsupportedError({
          offset: token.offset,
          cells: token.cells,
          detail: `level indicator run "${read.path}" governs nothing -- no script follows it`
        });
      }
      const previous = resolved.at(-1);
      if (previous && previous.kind === 'function' && previous.level === level) scriptedName = level;
      level = read.path;
      index = read.index;
      continue;
    }

    if (token.kind === 'blank' && scriptedName !== null) {
      // The space itself already sits at the name's level: left at the script's,
      // the parser would read it as one more script of the name.
      level = scriptedName;
      resolved.push(Object.freeze({ ...token, level, afterBaseline }));
      afterBaseline = false;
      scriptedName = null;
      index += 1;
      continue;
    }

    if (endsScriptLevel(token, tokens[index + 1])) level = '';

    if (token.kind === 'digit' && startsImplicitSubscript(resolved.at(-1), level, afterBaseline)) {
      const run = readImplicitSubscript(tokens, index, level);
      resolved.push(...run.digits);
      index = run.index;
      continue;
    }

    resolved.push(Object.freeze({ ...token, level, afterBaseline }));
    afterBaseline = false;
    index += 1;
  }

  return resolved;
}
