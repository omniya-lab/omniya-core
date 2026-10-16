import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSreMathmaps, SRE_MATHMAPS_SOURCE } from './build-sre-mathmaps.mjs';
import { patchEnglishMathmap } from '../../src/renderer/speech-rules.js';

/**
 * Apply the English ClearSpeak wording from `src/renderer/speech-rules.js` to a
 * copy of MathJax's speech rule files that already sits in `dir` (made by
 * `build-sre-mathmaps.mjs`, which adds the "enth" rules). The speech worker loads
 * rule files by URL, so a patched copy is how a rule changes. Generated,
 * gitignored, rebuilt by `scripts/build/build-editor.mjs`.
 */
export async function patchMathmapsDir(dir) {
  const file = path.join(dir, 'en.json');
  const english = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify(patchEnglishMathmap(english)));
}

/** A fresh patched copy in `outDir`: the "enth" rules, then the function-power wording. */
export async function writePatchedMathmaps(outDir) {
  buildSreMathmaps(SRE_MATHMAPS_SOURCE, outDir);
  await patchMathmapsDir(outDir);
}
