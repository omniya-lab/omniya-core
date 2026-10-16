/**
 * Token[] -> AST. Recursive descent, single pass, no backtracking, no modes.
 *
 * Grammar:
 *   expression := terms ( BLANK comparison BLANK terms )*
 *   terms      := postfix ( OP? postfix )*
 *   postfix    := primary script*
 *   primary    := Number | Identifier | Fraction | Root | Fenced | FunctionCall
 *
 * The two productions are BANA's two spacing rules, not a precedence ladder.
 * Rule 21.13 (Nemeth_2022.txt lines 10775-10779) spaces a comparison sign on
 * both sides; Rule 20.1.2 (line 9964) leaves no space beside an operation sign
 * except in the five circumstances 20.1.1 lists (lines 9916-9963), none of
 * which this parser reads. So a blank is grammar, not whitespace: it is exactly
 * what tells `⠨⠅` the equals sign from `⠨⠅` the Greek letter kappa, and
 * dropping or collapsing one would turn `⠎⠊⠝⠀⠭` into `sinx` and
 * `⠼⠲⠲⠀⠒⠢⠆` into a single numeral.
 *
 * `expression` is FLAT: one `Sequence` holding operands and operators in source
 * order, never a nested one. There are no precedence tiers, because grouping by
 * precedence is an assertion about operator binding, and Nemeth does not encode
 * it -- the code is structurally explicit (this fraction has this numerator) and
 * semantically silent (it never says that is division over the reals). The
 * target is Presentation MathML, which is flat for the same reason:
 * `<mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow>`. Tier nesting would have made
 * `Sequence` -- the node whose contract is that it asserts nothing -- the one
 * place binding got asserted.
 *
 * An operator between two operands is therefore optional and carries no weight:
 * `a+b` and `ab` differ only in whether an `Operator` item sits between them.
 * What the loop does still enforce is that an operator has an operand after it,
 * so `a+` is refused rather than yielding a dangling item. An operand *before*
 * it is required only of a sign with no prefix reading on its row: `+a` and `-a`
 * are the positive and negative signs of Rule 20, and are read by `parseUnary`.
 *
 * Scripts are attached here, not in `levels.js`: a token at level `P + '^'`
 * belongs to the base parsed at level `P`, which is a prefix test on the
 * absolute level paths. A script operand is a `postfix`, not a full expression
 * -- a relation inside a script has to restate its own level indicator, which
 * is out of scope.
 *
 * Whether two scripts on one base are simultaneous is NOT read off the level
 * paths -- both readings put the scripts at the same two levels. The explicit
 * baseline indicator is the only thing that separates them, and `levels.js`
 * hands it over as `afterBaseline`; `parsePostfix` is where it is consumed.
 *
 * `unary := (+|-|±)? postfix` is reached through the `prefix` flag on a symbol
 * row, which is what marks an operator as usable before the term it applies to.
 * `⠬`, `⠤` and Rule 20.6's combined `⠬⠤` / `⠤⠬` carry it. See `parseUnary` --
 * and note that 20.6 is why the combinations need rows of their own: without
 * them `⠬⠤` would lex as two signs and, once `⠤` has a prefix reading, come
 * back as "plus, then negative" rather than `±`.
 */

import {
  Fenced,
  Fraction,
  FunctionCall,
  Identifier,
  Number,
  Operator,
  Root,
  Sequence,
  SubSuperscript,
  Subscript,
  Superscript
} from './ast.js';
import { NemethUnsupportedError } from './errors.js';

const TERM_STARTS = new Set(['numeric', 'digit', 'letter', 'constant', 'function', 'fracOpen', 'radOpen', 'radIndex', 'groupOpen']);

function peek(state) {
  return state.index < state.tokens.length ? state.tokens[state.index] : null;
}

function advance(state) {
  const token = state.tokens[state.index];
  state.index += 1;
  return token;
}

function unsupported(state, detail, userDetail = '') {
  const token = peek(state) ?? state.tokens[state.tokens.length - 1] ?? null;
  return new NemethUnsupportedError({
    offset: token ? token.offset : 0,
    cells: token ? token.cells : '',
    detail,
    userDetail
  });
}

const SCRIPT_NAMES = { '^': 'superscript', _: 'subscript' };

/**
 * The plain-language half of a refusal, where one can be written; see
 * `errors.js` for what a `userDetail` is held to. `level` is an absolute path,
 * so its last character is the script the run never came back from -- and an
 * empty string, meaning the failure was on the baseline and had some other
 * cause, yields no message rather than a guessed one.
 */
function baselineUserDetail(level) {
  const name = SCRIPT_NAMES[level.slice(-1)];
  if (!name) return '';
  return (
    `This ${name} never returns to the baseline, so the rest of the expression is being read as ` +
    `part of it. Write the baseline indicator (dot 5) before the part that is back on the baseline.`
  );
}

function spanFrom(state, startIndex) {
  const first = state.tokens[startIndex];
  const last = state.tokens[state.index - 1];
  if (!first || !last) return null;
  return [first.offset, last.offset + last.len];
}

function expect(state, kind, detail, userDetail = '') {
  const token = peek(state);
  if (!token || token.kind !== kind) throw unsupported(state, detail, userDetail);
  return advance(state);
}

function atLevel(state, level) {
  const token = peek(state);
  return Boolean(token) && token.level === level;
}

// -- primary -----------------------------------------------------------------

/**
 * Is the token at `state.index` a Rule 3 numeric punctuation mark that belongs
 * INSIDE the numeral being read, rather than a mark of punctuation beside it?
 *
 * Both marks share their cells with a Rule 2 indicator, and both rules answer
 * the same way -- by what follows.
 *   3.2.3 (test/corpus/sources/Nemeth_2022.txt lines 818-819): the decimal point
 *     "is regarded as a numeric symbol only when it is followed by a number".
 *     Example 3-5 (line 828) is `#.35`, so it may also OPEN one.
 *   3.2.2 (lines 808-810): the numeric comma is one "which is interior to a
 *     modified numeral, and which is used to partition the numeral into short
 *     regular segments". Interior is both sides, so unlike the decimal point it
 *     needs digits already read. Example 3-4 (line 815) is `#1,478.00`.
 * A comma with nothing numeric after it is Rule 8's mark of punctuation instead
 * (its own table spells the two identically, line 3887), and this parser has no
 * grammar for that, so it is left for `parse` to refuse by name.
 */
function isInteriorNumericMark(state, level, digits) {
  const token = peek(state);
  if (!token || token.level !== level) return false;
  if (token.kind !== 'decimal' && !(token.kind === 'comma' && digits !== '')) return false;
  const next = state.tokens[state.index + 1];
  return Boolean(next) && next.kind === 'digit' && next.level === level;
}

function parseNumber(state, level, marks) {
  const start = state.index;
  const numeric = peek(state).kind === 'numeric' ? advance(state) : null;
  // BANA Rule 3.3.1 (test/corpus/sources/Nemeth_2022.txt lines 862-865): the
  // numeric indicator "is used at the beginning of a braille line or after a
  // space". A numeral written there WITHOUT one is therefore not a numeral, and
  // the lower-cell digits share their dots with punctuation -- `⠦` is both the
  // digit 8 and an opening quotation mark, so reading it as 8 here invents a
  // number the cells do not carry.
  //
  // Scoped exactly as 3.3.1 scopes it, and no wider: the rule governs line start
  // and after a space only, so `2+3` is written `⠼⠆⠬⠒` with ONE indicator and the
  // bare `3` after the operator stays legitimate. Rule 14.6's indicator-less
  // subscript is untouched too, since those digits sit at a script level, never
  // at the baseline.
  if (!numeric && level === '') {
    const previous = start > 0 ? state.tokens[start - 1] : null;
    if (!previous || previous.kind === 'blank') {
      throw unsupported(
        state,
        'a numeral at the start of the input or after a space needs the numeric indicator ' +
          'BANA Rule 3.3.1 requires, so these cells are not the number they resemble',
        'A number at the start of an expression, or after a space, needs the numeric indicator ' +
          '(dots 3456) before it. Without one these cells are not the number they look like, ' +
          'because the lower-cell digits share their dots with punctuation.'
      );
    }
  }
  const promoted = Boolean(peek(state).implicit);
  // Example 3-5 (line 828) writes `.35` with the decimal point OPENING the
  // numeral, so the interior test runs once here as well as inside the walk.
  let digits = isInteriorNumericMark(state, level, '') ? advance(state).value : '';
  // A digit carrying its own baseline indicator begins a new script event and is
  // not more of this numeral. Rule 14.11.2 makes `afterBaseline` the carrier of
  // that distinction, and a digit run is the one place it can be silently eaten:
  // without this break `⠭⠂⠐⠰⠆` reads as x sub 12 instead of (x sub 1) sub 2 --
  // two re-based scripts merged into one wrong number, with nothing refused.
  //
  // The second break is Rule 14.6 read backwards. Where its conditions hold the
  // subscript indicator "is not used" (Nemeth_2022.txt lines 6420-6439), so a
  // digit the writer DID indicate cannot be more of a run this pass promoted
  // with no indicator at all, nor the reverse: `⠠⠏⠂⠰⠆⠐⠠⠟` is P sub 1 followed
  // by a left-subscripted Q, not P sub 12.
  while (atLevel(state, level) && peek(state).kind === 'digit') {
    if (digits && peek(state).afterBaseline) break;
    if (digits && Boolean(peek(state).implicit) !== promoted) break;
    digits += advance(state).value;
    if (isInteriorNumericMark(state, level, digits)) digits += advance(state).value;
  }
  if (!digits) throw unsupported(state, 'numeric indicator is not followed by a numeral');
  return Number(digits, {
    src: spanFrom(state, start),
    marks: { ...marks, numericIndicator: Boolean(numeric) }
  });
}

/**
 * `Fraction := fracOpen expression fracLine expression fracClose`, all three
 * indicators of the SAME order.
 *
 * BANA Rule 13 gives each order of fraction its own indicator triple, and says
 * of each that its indicators are the ones that enclose a fraction of that
 * order: 13.2.1 (test/corpus/sources/Nemeth_2022.txt lines 5543-5546) "Simple
 * fraction indicators must be used ... to enclose a simple fraction", 13.6
 * (lines 5753-5755) "Complex fraction indicators must be used to enclose a
 * complex fraction". The order is therefore what pairs the three signs, exactly
 * as nesting depth pairs them in print, and Example 13-23 (lines 5757-5762,
 * `,??3/8#,/5,#`) is the shape that needs it: the inner simple fraction's own
 * `⠌` and `⠼` sit between the outer complex `⠠⠹` and `⠠⠼`, so an order-blind
 * `expect` would close the outer fraction on the inner one's line.
 *
 * Unlike `parseFenced`, which deliberately does NOT require its open and close
 * to match (BANA Example 19-12 pairs a left bracket with a right parenthesis),
 * nothing in Rule 13 sanctions a mixed triple, and reading one would silently
 * re-parent a nested fraction.
 */
function expectFractionSign(state, kind, order, what) {
  const token = peek(state);
  if (!token || token.kind !== kind || token.order !== order) {
    throw unsupported(
      state,
      `the ${order} fraction opened here has no ${order} ${what} -- BANA ${order === 'simple' ? '13.2.1' : '13.6'} ` +
        `encloses a ${order} fraction in ${order} fraction indicators, and this pipeline has no node for a mixed triple`
    );
  }
  return advance(state);
}

function parseFraction(state, level, marks) {
  const start = state.index;
  const order = advance(state).order;
  const numerator = parseExpression(state, level);
  expectFractionSign(state, 'fracLine', order, 'fraction line');
  const denominator = parseExpression(state, level);
  expectFractionSign(state, 'fracClose', order, 'closing indicator');
  return Fraction(numerator, denominator, {
    src: spanFrom(state, start),
    marks: { ...marks, fractionOrder: order }
  });
}

function parseRoot(state, level, marks) {
  const start = state.index;
  advance(state);
  const radicand = parseExpression(state, level);
  expect(
    state,
    'radClose',
    'radical has no termination indicator',
    'This radical is never closed. Write the termination indicator that ends it.'
  );
  return Root(radicand, null, { src: spanFrom(state, start), marks });
}

/**
 * `Root := radIndex expression radOpen expression radClose` -- BANA 16.2
 * (test/corpus/sources/Nemeth_2022.txt lines 8248-8254): a radical of index
 * other than 2 is written as the index-of-radical indicator `⠣`, then the
 * index, then the three steps of 16.1.1. Example 16-10 (lines 8256-8259) is
 * `<3>2]` = the cube root of 2; Example 16-13 (lines 8271-8273) is `<m+n>p+q]`,
 * so the index is a whole expression, not one sign.
 *
 * `⠣` is a homograph: Rule 15's "directly over" modifier indicator is the same
 * cell. It is not disambiguated here and does not need to be, because a
 * modifier's `⠣` follows the expression it modifies and is not at the start of
 * a term, so it is never reached by this production -- and where those cells do
 * reach it (nothing else in the modifier's shape starts a radicand) the index
 * runs into a sign that cannot open one and the case refuses, which is what it
 * did before Rule 16.2 shipped.
 */
function parseIndexedRoot(state, level, marks) {
  const start = state.index;
  advance(state);
  if (!peek(state) || peek(state).kind === 'radOpen') {
    throw unsupported(state, 'index-of-radical indicator is not followed by an index');
  }
  // The index runs up to the radical sign, so `⠜` cannot start a term inside it.
  // That is 16.3's own doing (lines 8275-8290): a radical nested inside another
  // carries order-of-radical indicators, which are separate signs, so an
  // unindicated radical sign after the index is always THIS radical's.
  const index = parseTerms(state, level, 'radOpen');
  expect(state, 'radOpen', 'index-of-radical indicator is not followed by a radical sign');
  const radicand = parseExpression(state, level);
  expect(
    state,
    'radClose',
    'indexed radical has no termination indicator',
    'This indexed radical is never closed. Write the termination indicator that ends it.'
  );
  return Root(radicand, index, { src: spanFrom(state, start), marks });
}

/**
 * `Fenced := groupOpen expression groupClose`, at one level.
 *
 * Nesting is the call stack, not a counter: `⠷⠷⠂⠆⠾⠷⠲⠾⠾` recurses and returns,
 * and there is no depth variable anywhere for a later reader to have to keep in
 * their head. The body is a full `expression`, because BANA Example 3-31
 * (Nemeth_2022.txt lines 1017-1020, `(0 .k x)` = "(0 = x)") puts a whole
 * relation, spaces and all, inside one pair of grouping symbols.
 *
 * The open and close signs are NOT required to match. Example 19-12 (lines
 * 9434-9437, `` `(a, +,=) `` = "[a, +∞)") is a left square bracket closed by a
 * right parenthesis, so a matching test would refuse the Code's own example.
 * What IS required is that a close exists at this level: BANA 19.1.2 (lines
 * 9438-9443) preserves a grouping sign that has no partner, and this pipeline
 * has no node for half a fence, so an unpartnered one refuses rather than
 * being quietly dropped or paired with the wrong sign.
 */
function parseFenced(state, level, marks) {
  const start = state.index;
  const open = advance(state);
  const body = parseExpression(state, level);
  const close = peek(state);
  if (!close || close.kind !== 'groupClose' || close.level !== level) {
    throw unsupported(
      state,
      `the grouping symbol "${open.value}" has no right grouping symbol at level "${level}"; ` +
        'BANA 19.1.2 preserves an unpaired one and this parser has no node for it',
      `The grouping symbol "${open.value}" is never closed. Write the grouping symbol that closes it.`
    );
  }
  advance(state);
  return Fenced(open.value, body, close.value, { src: spanFrom(state, start), marks });
}

/**
 * `FunctionCall := function BLANK postfix` -- BANA Rule 18.
 *
 * 18.4.1 (test/corpus/sources/Nemeth_2022.txt lines 9186-9190) leaves a space
 * after an unmodified function name, and that space is grammar here for the same
 * reason 21.13's two are: it is the only thing in the cells separating `⠇⠝⠀⠭`,
 * ln applied to x, from `⠇⠝`, the letters l and n. The lexer reads these cells
 * as a function name only when the space is there, so it is present by
 * construction from `lex()`; the check below is what makes `parse()` refuse
 * rather than mis-consume when it is handed tokens directly.
 *
 * The argument is a `postfix`, not a full `expression`, and that is 18.4.3's
 * doing (lines 9239-9241): "The expression which follows ... is spaced in
 * accordance with the other spacing rules of this Code", and Example 18-14
 * (lines 9243-9247) is `sin x+y` for print "sin x + y" -- the name applies to
 * the term, and the operation sign that follows belongs to the sequence around
 * it. A wider argument would silently re-parent the `+y`.
 */
function parseFunctionCall(state, level, marks) {
  const start = state.index;
  const name = advance(state);
  expect(state, 'blank', `BANA 18.4.1 leaves a space after the function name "${name.cells}", and none is here`);
  const argument = parsePostfix(state, level);
  return FunctionCall(name.value, argument, { src: spanFrom(state, start), marks });
}

function parsePrimary(state, level) {
  const token = peek(state);
  if (!token || token.level !== level || !TERM_STARTS.has(token.kind)) {
    throw unsupported(
      state,
      `expected the start of a term at level "${level}"`,
      baselineUserDetail(level)
    );
  }
  const start = state.index;
  // An explicit baseline indicator before this token is the only carrier of the
  // `x_1^2` vs `(x_1)^2` distinction (Rule 14.11.2), so it is recorded as a mark.
  // `token.marks` is what the lexer's prefix pass composed onto this sign --
  // typeform, alphabet, capitalization -- and travels with it unchanged.
  const marks = { ...token.marks, ...(token.afterBaseline ? { afterBaseline: true } : {}) };
  switch (token.kind) {
    case 'fracOpen':
      return parseFraction(state, level, marks);
    case 'radOpen':
      return parseRoot(state, level, marks);
    case 'radIndex':
      return parseIndexedRoot(state, level, marks);
    case 'groupOpen':
      return parseFenced(state, level, marks);
    case 'function':
      return parseFunctionCall(state, level, marks);
    case 'letter':
      advance(state);
      return Identifier(token.value, { src: spanFrom(state, start), marks });
    // BANA 23.11 infinity. The AST has no node for a named constant and adding
    // one would touch every backend's exhaustive dispatch for a single glyph, so
    // it is an `Operator` whose glyph is the Unicode ∞, as `±` and `÷` are written. It is
    // reached from here, not from `isOperatorAt`, so it is still an operand:
    // `x+∞` parses as x, +, ∞ and never as two operators in a row.
    case 'constant':
      advance(state);
      return Operator(token.value, { src: spanFrom(state, start), marks });
    default:
      return parseNumber(state, level, marks);
  }
}

// -- postfix -----------------------------------------------------------------

function scriptSlot(state, level) {
  const token = peek(state);
  if (!token) return null;
  const extendsByOne = token.level.length === level.length + 1 && token.level.startsWith(level);
  if (!extendsByOne) return null;
  return token.level.slice(level.length);
}

/**
 * A term at `level` that carries its own explicit baseline indicator, i.e. the
 * `"q` of Example 24-7 `p~b"~c"x` (Nemeth_2022.txt line 11966; the rule that
 * puts the first indicator there is 24.1.d, at line 11962).
 */
function startsBaselineTerm(state, level) {
  const token = peek(state);
  return Boolean(token) && token.afterBaseline && token.level === level && TERM_STARTS.has(token.kind);
}

function attachScript(base, slot, script, src) {
  return slot === '^' ? Superscript(base, script, { src }) : Subscript(base, script, { src });
}

/**
 * A script is every term written at its level, up to the next baseline
 * indicator: `2^-n` is `⠼⠆⠘⠤⠝` and `2^{x+n}` is `⠼⠆⠘⠭⠬⠝`, with the signs written
 * at the script's own level (issue #73, "x+n is within the exponent, unless I
 * write a baseline indicator after the x").
 *
 * The Code keeps a level in force until a baseline indicator ends it, so the
 * operation sign in `⠭⠘⠆⠬⠼⠂` is part of the superscript: it is `x^{2+1}`, and
 * `x^2+1` takes `⠭⠘⠆⠐⠬⠼⠂`. This once refused the unindicated form for fear that
 * an author who forgot the indicator would be read silently; the reading is the
 * Code's literal one, and the status line still reads the result back.
 */
function parseScript(state, level) {
  const start = state.index;
  const items = [];
  parseUnary(state, level, items);
  // Only an operation sign continues a script. Terms set side by side are NOT
  // taken here: `parsePostfix` and Rule 14.11.2's digit-run breaks rely on a
  // second term at this level being left for the caller to refuse.
  while (isOperatorAt(state, level)) {
    const token = advance(state);
    items.push(Operator(token.value, { src: [token.offset, token.offset + token.len] }));
    parseUnary(state, level, items);
  }
  return items.length === 1 ? items[0] : Sequence(items, { src: spanFrom(state, start) });
}

/**
 * Rule 14.11 decides whether two scripts on one base are simultaneous, and the
 * explicit baseline indicator is its sole carrier -- which is why `levels.js`
 * records `afterBaseline` and why this loop reads it off the script's own first
 * token rather than off the node it parses (the mark sits on the token; a
 * script that carries scripts of its own would bury it).
 *
 * 14.11.1 (Nemeth_2022.txt lines 7234-7240): with no baseline indicator between
 * them the two scripts are simultaneous and "the subscript must be indicated
 * first" -- Example 14-121 `x;a~n`, one `msubsup`.
 * 14.11.2 (lines 7263-7267): with one, "the relative horizontal positions of
 * the signs must be retained" -- Example 14-124 `a~n";m` is (a^n)_m, so the
 * second script re-bases onto the whole postfix parsed so far.
 */
function parsePostfix(state, level) {
  const start = state.index;
  let node = parsePrimary(state, level);
  // Slots filled on the current base since the last baseline indicator.
  let filled = '';
  for (let slot = scriptSlot(state, level); slot; slot = scriptSlot(state, level)) {
    const rebased = peek(state).afterBaseline;
    // A script may carry operation signs: Nemeth keeps a level in force until
    // a baseline indicator ends it, so `2^-n` is `⠼⠆⠘⠤⠝` and `2^{x+n}` is
    // `⠼⠆⠘⠭⠬⠝`, with the signs written at the script's own level. Reading one
    // postfix here left the sign stranded and refused every such power
    // (#73, "I shouldn't have to write a baseline indicator ... at the end").
    const script = parseScript(state, level + slot);
    if (rebased && startsBaselineTerm(state, level)) {
      // Rule 14.5.1 (lines 6311-6315): a LEFT script is written exactly like a
      // right one and told apart only by sitting before the sign it applies to,
      // with the baseline indicator of 14.5.2 between them. So a script fenced
      // by baseline indicators on both sides belongs to what FOLLOWS it, not to
      // the base behind it, and nothing here can render a left script.
      throw unsupported(state, `a "${slot}" script between two baseline indicators is a left script`);
    }
    const src = spanFrom(state, start);
    if (!rebased && filled !== '') {
      if (filled !== '_' || slot !== '^') {
        throw unsupported(
          state,
          `a "${slot}" script on a base already carrying "${filled}" needs a baseline indicator before it`,
          `This base already carries a ${SCRIPT_NAMES[filled.slice(-1)] ?? 'script'}. Write the baseline ` +
            `indicator (dot 5) before the ${SCRIPT_NAMES[slot] ?? 'script'} to attach it to the base too.`
        );
      }
      node = SubSuperscript(node.base, node.index, script, { src });
      filled = '_^';
      continue;
    }
    node = attachScript(node, slot, script, src);
    filled = slot;
  }
  return node;
}

// -- expression --------------------------------------------------------------

function isOperatorAt(state, level) {
  const token = peek(state);
  return Boolean(token) && token.level === level && token.kind === 'op';
}

/**
 * `stop` is a kind that does not start a term in THIS production, passed by a
 * caller whose own grammar ends where that sign begins -- BANA 16.2's index,
 * which the radical sign terminates. It is a parameter of the production, not a
 * mode: nothing sets it for the rest of the parse, and the default is that
 * every `TERM_STARTS` kind starts a term.
 */
function isTermAt(state, level, stop) {
  return atLevel(state, level) && TERM_STARTS.has(peek(state).kind) && peek(state).kind !== stop;
}

/**
 * `unary := (+|-|±)? postfix`
 *
 * BANA Rule 20 spells the negative sign and the sign of subtraction with the
 * same cell, `⠤`, and the positive sign and the sign of addition with `⠬`. What
 * separates the two readings is position alone: a sign with no term before it
 * on this level applies to the term after it. So the test here is where the
 * sign sits, and `prefix` on the symbol row is what says the sign has such a
 * reading at all -- `×`, `÷` and `⋅` carry no row and stay binary-only.
 *
 * The sign is pushed as a plain `Operator` into the same flat `Sequence` as
 * every other item, for this file's standing reason: a `Unary` node would
 * assert that the sign binds its operand more tightly than the operators around
 * it, and Nemeth does not encode that. Presentation MathML spells `-1` as
 * `<mo>-</mo><mn>1</mn>` and asserts no more either.
 *
 * At most one sign is consumed, so `--1` still refuses rather than nesting.
 */
function parseUnary(state, level, items) {
  const token = peek(state);
  if (token && token.prefix && token.level === level) {
    advance(state);
    items.push(Operator(token.value, { src: [token.offset, token.offset + token.len] }));
  }
  // A prefix sign must be followed by an operand; parsePostfix refuses if not.
  items.push(parsePostfix(state, level));
}

function parseTerms(state, level, stop = null) {
  const start = state.index;
  const items = [];
  parseUnary(state, level, items);
  while (isOperatorAt(state, level) || isTermAt(state, level, stop)) {
    if (isOperatorAt(state, level)) {
      const token = advance(state);
      items.push(Operator(token.value, { src: [token.offset, token.offset + token.len] }));
    }
    // An operator must be followed by an operand; parsePostfix refuses if not.
    parseUnary(state, level, items);
  }
  return items.length === 1 ? items[0] : Sequence(items, { src: spanFrom(state, start) });
}

// -- relation ----------------------------------------------------------------

/**
 * A comparison sign together with the two blanks BANA Rule 21.13 puts around it.
 *
 * 21.13 (Nemeth_2022.txt lines 10775-10779): "A space must be left on either
 * side of a comparison symbol. However, a space is not left between the
 * comparison symbol and any punctuation symbol, grouping symbol, or indicator
 * which applies to it." Those two blanks are the whole of the grammar: nothing
 * else in the Code writes a blank the parser can account for, so nothing else
 * consumes one.
 *
 * The test is on `role`, not on `kind`. `kind` is the grammatical category this
 * file dispatches on; `role` is the spacing class Rules 20 and 21 assign, and
 * they are not the same question -- Example 21-25 (lines 10781-10784) is
 * `x $4 y`, a SHAPE used as a comparison sign and spaced by 21.13 exactly like
 * `.k`. Keying the seam to `role` is what lets such a row arrive as data.
 *
 * The indicators of 21.13's second sentence need no handling here: `levels.js`
 * has already consumed them and stamped the level they name onto the sign, so
 * `⠀⠰⠨⠅⠀` arrives as blank, comparison-at-level-`_`, blank, and the level test
 * below is what checks the indicator applied to the sign and not to something
 * else.
 */
function comparisonSeam(state, level) {
  const before = state.tokens[state.index];
  const sign = state.tokens[state.index + 1];
  const after = state.tokens[state.index + 2];
  if (!before || before.kind !== 'blank') return null;
  if (!sign || sign.role !== 'comparison' || sign.level !== level) return null;
  if (!after || after.kind !== 'blank') return null;
  return { sign, next: state.index + 3 };
}

/**
 * `expression := terms ( BLANK comparison BLANK terms )*`
 *
 * Flat, for the reason in this file's header: a comparison sign is an item in
 * the `Sequence` beside its operands, never a node that binds them, because
 * Presentation MathML spells `x = y` as `<mi>x</mi><mo>=</mo><mi>y</mi>` and
 * Nemeth asserts no more than that either.
 *
 * A comparison sign needs a term on each side, the same discipline `parseTerms`
 * applies to an operation sign. So the lone `≡` of `sre-aata:AataExpression_330`
 * refuses: 21.13's outer space is real but there is no relation to build.
 */
function parseExpression(state, level) {
  const start = state.index;
  const items = [];
  // `parseTerms` returns either one node or a flat `Sequence` of items at this
  // same level, so its items are spread rather than nested. Nesting them would
  // make `Sequence` -- the node whose contract is that it asserts nothing --
  // assert that `a+b` binds tighter than the `=` beside it, which is exactly
  // the binding claim Nemeth does not encode and MathML does not spell.
  const push = (node) => {
    if (node.kind === 'Sequence') items.push(...node.items);
    else items.push(node);
  };
  push(parseTerms(state, level));
  for (let seam = comparisonSeam(state, level); seam; seam = comparisonSeam(state, level)) {
    state.index = seam.next;
    items.push(Operator(seam.sign.value, { src: [seam.sign.offset, seam.sign.offset + seam.sign.len] }));
    push(parseTerms(state, level));
  }
  return items.length === 1 ? items[0] : Sequence(items, { src: spanFrom(state, start) });
}

/**
 * Why a leftover blank is refused, in the Code's own terms.
 *
 * Rule 20.1.2 (line 9964) "A space is not left on either side of a symbol of
 * operation in any other situation" -- "other" than the five circumstances
 * 20.1.1 lists (lines 9916-9963): beside a comparison symbol, after a function
 * name, beside an ellipsis or dash, beside an abbreviation, or where Rule 23
 * requires it. This parser reads none of those five constructs, so a blank
 * touching an operation sign is out of scope rather than wrong, and saying so
 * with the sign named beats a bare "unparsed blank".
 */
function leftoverDetail(state) {
  const token = peek(state);
  if (token.kind !== 'blank') return `unparsed ${token.kind} token at level "${token.level}"`;
  const operation = [state.tokens[state.index - 1], state.tokens[state.index + 1]].find(
    (neighbour) => neighbour && neighbour.role === 'binary'
  );
  if (operation) {
    return (
      `BANA Rule 20.1.2 leaves no space beside the operation sign "${operation.value}", ` +
      "and none of Rule 20.1.1's five spaced circumstances is a construct this parser reads"
    );
  }
  return (
    'a blank stands where BANA Rule 21.13 does not put one -- it spaces a comparison symbol and ' +
    'nothing else here, and Rule 20.1.1 spaces an operation symbol only next to a function name, ' +
    'an abbreviation, an ellipsis or a dash, none of which this parser reads'
  );
}

export function parse(tokens, context = {}) {
  const state = { tokens, index: 0, context };
  const node = parseExpression(state, '');
  if (state.index < tokens.length) throw unsupported(state, leftoverDetail(state));
  return node;
}
