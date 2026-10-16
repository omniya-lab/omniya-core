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
// the page (see `patchMathmapsDir`) and `mathjax-config.js` points the loader
// at it. Only English ClearSpeak is touched; every other rule is the engine's own.
//
// Issue #68 is the same kind of change for a symbol. The contributor asked that the
// two Nemeth angle brackets (BANA 19.1) be read "open bracket" and "close bracket".
// The engine's English symbol data says "left angle bracket" and "right angle
// bracket" for U+27E8 and U+27E9. It gives the square brackets a ClearSpeak entry
// of "open bracket" and "close bracket"; the angle brackets get the same entry, so
// only ClearSpeak (what the app speaks) changes and MathSpeak keeps its words.
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

const ENGLISH_DELIMITERS = 'en/symbols/math_delimiters.min';

// code point of the symbol -> what ClearSpeak says. Written as the contributor wrote it.
const ANGLE_BRACKETS = { '27E8': 'open bracket', '27E9': 'close bracket' };

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
  const delimiters = patched[ENGLISH_DELIMITERS];
  const symbols = delimiters && Object.values(delimiters);
  for (const [key, words] of Object.entries(ANGLE_BRACKETS)) {
    const symbol = symbols?.find((entry) => entry?.key === key);
    if (!symbol?.mappings) {
      throw new Error(`speech rules: the English symbol ${key} is not where it was; update speech-rules.js for this speech-rule-engine version`);
    }
    symbol.mappings.clearspeak = { ...symbol.mappings.clearspeak, default: words };
  }
  return patched;
}
