// How a power of a function is spoken. Issue #71, from a blind braille reader:
//
//   cos^2 x   "cosine squared of x"          (was "cosine squared x")
//   tan^3 3   "tangent cubed of 3"           (was "tangent cubed 3")
//   cos^5 x   "cosine to the fifth of x"     (was "the fifth power of cosine x")
//   sin^n x   "sine to the enth of x"        (was "the n-th power of sine x")
//
// The speech engine has no setting that says this: ClearSpeak's Exponent
// preferences all keep "power" in the sentence and none of them says "of" after a
// squared function. Its wording lives in rule files (mathmaps), which the speech
// worker loads by URL, so the way to change it is to give the worker a patched
// copy of the English file. `scripts/build/build-editor.mjs` writes that copy next to
// the page (see `writePatchedMathmaps`) and `mathjax-config.js` points the loader
// at it. Only English ClearSpeak is touched; every other rule is the engine's own.
//
// The rules only match a function name with an integer or a plain letter as its
// exponent and an argument after it. The inverse (cos^-1), a negative exponent, a
// compound exponent and a function with no argument fall through to the engine's
// own rules, so those read as they did before.

const ENGLISH_ACTIONS = 'en/rules/clearspeak_english_actions.min';
const ENGLISH_RULES = 'en/rules/clearspeak_english.min';

// An `appl`: a prefix function applied to an argument, whose function part is a
// superscript on a function name (the engine types `cos` as a "function").
const POWERED_FUNCTION = [
  'self::appl',
  '@role="prefix function"',
  'name(children/*[1])="superscript"',
  'name(children/*[1]/children/*[1])="function"'
];

const OF_ARGUMENT = '[t] "of"; [n] children/*[2] (pause:short)';
const NAME = '[n] children/*[1]/children/*[1]';

// name -> [extra conditions on the exponent, the words]. Each rule excludes the
// cases the others handle: the engine picks between rules that match equally well
// by their order, and that is not a thing to lean on.
const POWERS = [
  ['squared', ['name(children/*[1]/children/*[2])="number"', 'children/*[1]/children/*[2][text()="2"]'], `${NAME}; [t] "squared"; ${OF_ARGUMENT}`],
  ['cubed', ['name(children/*[1]/children/*[2])="number"', 'children/*[1]/children/*[2][text()="3"]'], `${NAME}; [t] "cubed"; ${OF_ARGUMENT}`],
  ['number', ['name(children/*[1]/children/*[2])="number"', 'children/*[1]/children/*[2][@role="integer"]',
    'children/*[1]/children/*[2][text()!="2" and text()!="3"]'],
    `${NAME}; [t] "to the"; [n] children/*[1]/children/*[2] (grammar:ordinal:noArticle); ${OF_ARGUMENT}`],
  // A screen reader says "n-th" as letters; the contributor's spelling "enth" is
  // what it says as a word. Other letters keep the engine's "x-th" reading.
  ['n', ['name(children/*[1]/children/*[2])="identifier"', 'children/*[1]/children/*[2][text()="n"]'],
    `${NAME}; [t] "to the enth"; ${OF_ARGUMENT}`],
  ['letter', ['name(children/*[1]/children/*[2])="identifier"', 'children/*[1]/children/*[2][@role="latinletter" or @role="greekletter" or @role="otherletter"]',
    'children/*[1]/children/*[2][text()!="n"]'],
    `${NAME}; [t] "to the"; [n] children/*[1]/children/*[2] (grammar:ordinal:noArticle); ${OF_ARGUMENT}`]
];

/** The patched English mathmap: a copy, the input is not changed. */
export function patchEnglishMathmap(en) {
  const patched = structuredClone(en);
  const rules = patched[ENGLISH_RULES];
  const actions = patched[ENGLISH_ACTIONS];
  if (!rules?.rules || !actions?.rules) {
    throw new Error('speech rules: the English ClearSpeak rule files are not where they were; update speech-rules.js for this speech-rule-engine version');
  }
  for (const [name, exponent, words] of POWERS) {
    const id = `function-power-${name}`;
    rules.rules.push(['Precondition', id, 'default', ...POWERED_FUNCTION, ...exponent]);
    actions.rules.push(['Action', id, `[p] (pause:short); ${words}`]);
  }
  return patched;
}
