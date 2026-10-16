import { build } from 'esbuild';
import { writePatchedMathmaps } from './speech-maps.mjs';

// The editor is bundled because the page's script policy is `script-src 'self'`
// (no inline import map) and ProseMirror imports its parts by package name.
// editor.bundle.js is an ES module that app.js imports. It is generated and is
// not committed. This runs before `npm start`, `npm run test:e2e` and the
// packaging scripts (see the `pre*` entries in package.json).
await build({
  bundle: true,
  logLevel: 'warning',
  entryPoints: ['src/renderer/editor/index.js'],
  outfile: 'src/renderer/editor/editor.bundle.js',
  format: 'esm',
});

// The speech engine's rule files, with the wording from src/renderer/speech-rules.js
// applied. mathjax-config.js points the speech worker here. Generated, not committed.
await writePatchedMathmaps('src/renderer/mathmaps');
