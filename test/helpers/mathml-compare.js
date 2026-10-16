/**
// lab hostile
 * Structural MathML comparison for the Nemeth corpus gate.
 *
 * This is the comparison MathCAT's maintainer proposed for exactly this
 * problem: round-trip our LaTeX through the same MathJax pipeline the app
 * already uses, canonicalize both sides through the app's own MathML tree
 * utilities, and compare structurally rather than by string.
 *
 *   parseNemeth(cells).latex
 *     -> convertLatexToMathML(latex)     [src/main/mathml.js, ASYNC]
 *     -> canonicalizeMathML(...)         [src/domain/math-tree.js]
 *     -> parseMathML(...)                [src/domain/math-tree.js]
 *     -> structuralEquivalent(ours, theirs)  [src/domain/math-tree.js]
 *
 * The case's own `mathml` goes through the same canonicalizeMathML ->
 * parseMathML steps, so both sides are normalized identically.
 *
 * `structuralEquivalent` already strips `data-omniya-id` and unwraps a
 * single-child unannotated `mrow`. Everything below adds exactly four more
 * rules on top of that, each named, scoped narrowly, and verified against
 * the actual corpus and the actual MathJax output before being written (see
 * the comments on each rule, and test/unit/helpers/mathml-compare.test.js
 * for the proof that none of them masks a real difference). This file does
 * not touch `src/domain/`, and `src/domain/` never imports from `src/main/`
 * -- that boundary is unaffected by these tests living here.
 */

import { canonicalizeMathML, parseMathML, structuralEquivalent } from '../../src/domain/math-tree.js';
import { convertLatexToMathML } from '../../src/main/mathml.js';

const INVISIBLE_TIMES = '⁢';
const INVISIBLE_FUNCTION_APPLICATION = '⁡';
const ASCII_MINUS = '-';
const UNICODE_MINUS = '−';

function soleText(node) {
  return node.children.length === 1 && node.children[0].text !== undefined ? node.children[0].text : undefined;
}

/**
 * Rule 1: drop <mo> elements whose entire content is one invisible operator.
 *
 * The corpus's source MathML carries invisible-times (U+2062) and invisible
 * function-application (U+2061) as their own <mo> element -- verified
 * directly: `mathcat-rules:num_indicator_9_a_4` has
 * `<mn>2</mn><mo>&#x2062;</mo><mrow><mi>sin</mi><mo>&#x2061;</mo>...`.
 * MathJax's serializer, verified empirically, never emits U+2062 for
 * implicit multiplication (`2x` produces `<mn>2</mn><mi>x</mi>` with no <mo>
 * between them at all) but DOES emit U+2061 for named functions like `\sin`
 * -- so either codepoint can legitimately appear on either side. Either way
 * the element carries no visible mathematics, so it must be removed as a
 * *node*, not merely blanked: blanking would leave a dangling empty <mo/>
 * with no counterpart on the other side, which would itself cause a false
 * DISAGREE. Scoped to exactly these two codepoints, as an <mo> whose sole
 * text is one of them -- not broadened to "invisible characters" generally.
 */
export function stripInvisibleOperators(node) {
  if (node.text !== undefined) return node;
  const children = node.children
    .filter((child) => {
      if (child.text !== undefined || child.name !== 'mo') return true;
      const text = soleText(child);
      return text !== INVISIBLE_TIMES && text !== INVISIBLE_FUNCTION_APPLICATION;
    })
    .map(stripInvisibleOperators);
  return { ...node, children };
}

/**
 * Rule 2: inside an <mo>, rewrite a sole ASCII hyphen-minus to U+2212.
 *
 * MathJax always emits U+2212 for a LaTeX `-` operator (verified). The
 * corpus is inconsistent: of 613 cases, 16 spell the minus operator
 * `<mo>-</mo>` (ASCII U+002D) and 27 spell it `<mo>−</mo>` (U+2212).
 * Without this rule, every one of those 16 would DISAGREE on spelling
 * alone, never on mathematics. Scoped to <mo> only -- never <mn>, <mi>, or
 * <mtext>, where a literal hyphen could be real content -- because a search
 * of the whole corpus (verified) found no case with a bare "-" inside any
 * of those elements.
 */
export function normalizeMinusOperator(node) {
  if (node.text !== undefined) return node;
  const children = node.children.map((child) => {
    if (child.text !== undefined) return child;
    if (child.name === 'mo' && soleText(child) === ASCII_MINUS) {
      return { ...child, children: [{ text: UNICODE_MINUS }] };
    }
    return normalizeMinusOperator(child);
  });
  return { ...node, children };
}

/**
 * Rule 3: drop the `xmlns` attribute wherever it appears.
 *
 * MathJax always emits `xmlns="http://www.w3.org/1998/Math/MathML"` on the
 * root `<math>` element; the corpus's own fixtures never declare it (they
 * are bare `<math>...</math>` snippets, not full documents). `xmlns` is in
 * `structuralEquivalent`'s `SAFE_ATTRIBUTES` allowlist and is not
 * `data-omniya-id`, so without this rule it survives that function's own
 * cleanup, and *every* successfully-converted case would DISAGREE on a
 * namespace declaration alone, never on mathematics -- verified directly:
 * `mathcat-rules:baseline_80_a_1` (`\sqrt{x^{2}+y^{2}}`) is otherwise
 * byte-for-byte structurally identical on both sides, and only this
 * attribute made it compare unequal. A namespace declaration is not
 * mathematical content, so it is dropped wherever it appears (in practice
 * only ever on the root).
 */
export function stripXmlnsAttribute(node) {
  if (node.text !== undefined) return node;
  const { xmlns, ...attrs } = node.attrs ?? {};
  return { ...node, attrs, children: node.children.map(stripXmlnsAttribute) };
}

function isUnannotatedMrow(node) {
  if (node.name !== 'mrow') return false;
  const attrs = Object.keys(node.attrs ?? {}).filter((key) => key !== 'data-omniya-id');
  return attrs.length === 0;
}

/**
 * Rule 4: inline an unannotated `<mrow>` that is a node's ONLY child.
 *
 * Presentation MathML defines several elements (`<msqrt>`, `<mtd>`, `<math>`
 * itself, ...) as taking either one child representing a whole expression,
 * or -- equivalently, per the spec's own content model -- several children
 * that are implicitly treated as if wrapped in one `<mrow>`. So
 * `<msqrt><mrow>A B C</mrow></msqrt>` and `<msqrt>A B C</msqrt>` are the same
 * tree. `structuralEquivalent`'s own built-in rule only covers the mirror
 * case (an `<mrow>` with exactly one grandchild collapses to that
 * grandchild); it does not cover an `<mrow>` with *several* grandchildren
 * that is itself its parent's only child. The corpus itself proves this is
 * pure serialization noise, not content: `mathcat-rules:sqrt_103_a_2` writes
 * `<msqrt><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow></msqrt>` (wrapped)
 * while `mathcat-rules:sqrt_103_a_4` writes the mathematically-analogous
 * `<msqrt><msup>..</msup><mo>+</mo><msup>..</msup></msqrt>` (unwrapped, no
 * `<mrow>` at all) for the same shape of expression -- the same source
 * treats the two forms as interchangeable. Scoped to "parent has exactly one
 * child, and it is an mrow with no attributes besides `data-omniya-id`" so
 * it can never fire on a fixed-arity element like `<msup>`/`<mfrac>` (those
 * always have >= 2 children, so this never matches them), and never
 * discards an `<mrow>` that carries its own semantic attributes.
 */
export function inlineSoleMrowChild(node) {
  if (node.text !== undefined) return node;
  let children = node.children.map(inlineSoleMrowChild);
  if (children.length === 1 && isUnannotatedMrow(children[0])) {
    children = children[0].children;
  }
  return { ...node, children };
}

function normalizeForComparison(node) {
  return inlineSoleMrowChild(stripXmlnsAttribute(normalizeMinusOperator(stripInvisibleOperators(node))));
}

/**
 * Compare our parser's LaTeX output against a corpus case's own MathML.
 *
 * Returns `{ outcome, ourMathml, theirMathml, error }`:
 *  - outcome 'equal'             -- structurally the same mathematics (PASS)
 *  - outcome 'different'         -- both converted, but differ (DISAGREE)
 *  - outcome 'conversion-error'  -- our LaTeX did not survive MathJax
 *    (ERROR). This is deliberately distinct from a DISAGREE: our parser
 *    claimed success and produced LaTeX that MathJax rejects, which is a
 *    parser bug, not a legitimate difference of opinion about the math.
 *
 * `ourMathml` / `theirMathml` are the canonicalized (not comparison-
 * normalized) MathML strings, suitable for a human-readable report -- the
 * four comparison rules above are applied only to decide `outcome`, not to
 * what gets displayed, so a reviewer sees exactly what was produced.
 */
export async function mathmlEquivalent(latex, theirMathml) {
  const theirCanonical = canonicalizeMathML(theirMathml);
  let ourRaw;
  try {
    ourRaw = await convertLatexToMathML(latex);
  } catch (error) {
    return { outcome: 'conversion-error', ourMathml: null, theirMathml: theirCanonical, error };
  }
  const ourCanonical = canonicalizeMathML(ourRaw);
  const ourTree = normalizeForComparison(parseMathML(ourCanonical));
  const theirTree = normalizeForComparison(parseMathML(theirCanonical));
  const equal = structuralEquivalent(ourTree, theirTree);
  return {
    outcome: equal ? 'equal' : 'different',
    ourMathml: ourCanonical,
    theirMathml: theirCanonical,
    error: null
  };
}
