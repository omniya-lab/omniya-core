import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { patchEnglishMathmap } from '../../src/renderer/speech-rules.js';

const SOURCE = 'node_modules/@mathjax/src/bundle/sre/mathmaps';

/**
 * Copy MathJax's speech rule files to `outDir` with the English ClearSpeak
 * wording from `src/renderer/speech-rules.js` applied. The speech worker loads
 * rule files by URL, so a patched copy is how a rule changes (see that file).
 * Generated, gitignored, rebuilt by `scripts/build/build-editor.mjs`.
 */
export async function writePatchedMathmaps(outDir, root = process.cwd()) {
  const from = path.join(root, SOURCE);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.dirname(outDir), { recursive: true });
  await cp(from, outDir, { recursive: true });
  const english = JSON.parse(await readFile(path.join(from, 'en.json'), 'utf8'));
  await writeFile(path.join(outDir, 'en.json'), JSON.stringify(patchEnglishMathmap(english)));
}
