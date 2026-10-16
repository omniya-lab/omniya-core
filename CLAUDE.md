# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Omniya Core is an experimental local-first Electron app exploring screen-reader-first
mathematical workspaces (research prototype, not a production product). Users write
"napkins" — local JSON documents, each one a Word-style document of paragraphs with
inline equations — and can author math in LaTeX or Nemeth braille, explore equation
structure via MathJax, and read literary text in the screen reader's own braille table (the app sets none; see `docs/word-editor.md`, "Braille for ordinary text"). No network access, no
accounts, no cloud.

The editing experience is deliberately **not innovative**: it copies Word. Type, Enter
for a new paragraph, undo and redo, Alt+= (Windows) or Control+= (Mac) to insert an
equation. Before changing any key or editing behaviour read `docs/word-editor.md`,
which lists every key and why it is what it is.

The screen is meant to *feel* like a note-taking app and to be discoverable by Tab: a notes
list, one toolbar of labelled buttons, a white page, a status bar. The interface says
**note**. The code, the files and the schema still say **napkin**; do not rename those. Layout
and wording are checked by blind judges who see only screenshots and the accessibility tree
(`npm run judge:capture -- <dir>`, then fresh judge agents; see `docs/judging.md`). Change
the look, rerun a round, and compare with the table there. Buttons with nothing to do are
`aria-disabled`, never `disabled`. Find in note (Ctrl/Cmd+F), export (web page, LaTeX, plain text) and
print, and an equation preview are built. Bold, italic, headings, lists, replace, a symbol picker and
note search are NOT; adding any is a decision for the owner, not polish.

You are almost always working on **`testing`**, the active alpha branch. `main` is the
last human-signed-off snapshot; large parts of `testing` (Nemeth authoring, the Word-style
editor) are not on `main`. Check `git branch` if in doubt — do not
assume `main`'s behavior applies here.

Accessibility work in this repo is evidence-driven, not sighted-developer guesswork.
Don't make UX decisions "for blind users" without a cited rationale (BANA rule, prior
audit note, or explicit user testing). See `docs/guided-nemeth-bana-audit-notes.md` and
`docs/nemeth-v2/HANDOFF.md` for the standing rules this project has already learned the
hard way.

## Commands

```bash
npm start                 # run the Electron app (never open src/renderer/index.html in a browser — no preload bridge)
npm test                  # unit tests only (node --test test/unit/**/*.test.js)
npm run test:e2e          # Electron/Playwright e2e tests (test-concurrency=1)
npm run test:all          # unit + e2e
npm run test:inspect      # generate an editable example napkin and open it in the app
npm run open:napkin -- /path/to/file.napkin.json   # open an arbitrary napkin file in the app
npm run nemeth:coverage   # Nemeth correctness gate against the BANA corpus (test/corpus/nemeth-v1.json)
npm run nemeth:utility    # Nemeth utility gate ("can a student do their homework")
```

Run a single unit test file directly, e.g.:
```bash
node --test test/unit/nemeth/parser.test.js
```

The renderer imports a generated bundle, `src/renderer/editor/editor.bundle.js`
(ProseMirror, built by `scripts/build-editor.mjs`, gitignored). `npm start`,
`npm run test:e2e` and the `dist:*` scripts build it first through `pre*` hooks. If you run
a test file with `node --test` directly, run `node scripts/build-editor.mjs` once first, or
the app fails to start with a missing-module error.

Run a single e2e test file (still needs concurrency=1):
```bash
node --test --test-concurrency=1 test/e2e/nemeth-composer.test.js
```

`npm run test:screen-reader` drives a REAL screen reader (VoiceOver on macOS, NVDA on
Windows) through Guidepup. It is meant for CI (`.github/workflows/screen-reader.yml`),
which does the one-time machine setup. It takes over focus and sound, so do not run it
on a working machine. The spoken transcript is saved to `test/artifacts/screen-reader/`
and uploaded as a CI artifact.

Notes on the test setup:
- e2e tests run the Electron browser context **offline** and record unexpected external
  HTTP requests — don't add network fallbacks to fix a failure.
- On macOS, run GUI (e2e) tests from a normal logged-in terminal, not a restricted GUI
  sandbox — the sandbox can kill the app before its JS starts.
- `OMNIYA_TEST_USER_DATA_DIR` isolates persisted state for automated tests.
- Local MathJax assets are vendored/installed, not CDN-loaded. If they're missing,
  `npm install` — do not add a network fallback.
- Current baseline: `npm test` 632/632 and `npm run test:e2e` 83/83, both green. The 11
  old e2e failures (`enterCommand` timeouts and one `mathjax-navigation` assertion, see
  `docs/nemeth-v2/HANDOFF.md`, "Known rot") are gone: those tests drove the old item-list
  UI and were rewritten for the Word-style editor. A red test is now yours to explain.
- Sending a key right after another action can race the editor: the browser tells it
  about the caret just after the key. In tests, `settle`/`press` (in
  `test/e2e/launch-electron.js`) wait for that, and `goToDocStart` checks that a
  Cmd/Ctrl+Home arrived.

### Auto-commit hook

`.claude/hooks/commit-on-task-complete.sh` runs on `TaskUpdate` → `completed` and
auto-commits a checkpoint **only if `npm test` is green**; it never pushes and never
commits a red tree. Keep the unit suite passing as you go rather than batching fixes
for the end, or your in-progress task checkpoints silently stop happening.

## Architecture

### Process boundary (Electron security model)

- `src/main.js` — main process. Owns the `BrowserWindow` (sandboxed, context-isolated,
  `nodeIntegration: false`), the application menu, and all `ipcMain.handle` endpoints.
  Every handler calls `assertTrustedSender(event)` first, which checks
  `event.senderFrame.url` against the loaded renderer file's URL — do not add an IPC
  handler without this check.
- `src/preload.cjs` — the *only* bridge between renderer and main, via
  `contextBridge.exposeInMainWorld('omniya', …)`. The renderer never gets Node/Electron
  APIs directly; every capability it needs (state load/save, settings, LaTeX↔MathML,
  UEB translate) must be added here explicitly.
- `src/main/` — main-process services behind that bridge: `storage.js` (queued atomic
  napkin JSON persistence under `app.getPath('userData')`, or `OMNIYA_NAPKIN_FILE` when
  set), `settings-storage.js`, `mathml.js` (LaTeX→MathML via MathJax), `math-service.js`
  (import/export), `ueb-service.js` (liblouis translate/back-translate).
- `src/renderer/` — the semantic HTML page and its behavior (`app.js`), the editor,
  MathJax explorer wiring, input capture, and styling. No Node access; everything goes
  through `window.omniya`.
- `src/renderer/editor/` — the Word-style editor: ProseMirror view, history and keys
  (`index.js`), the document schema, the inline equation node view
  (`math-node-view.js`, `math-render.js`), and Word's "Backspace selects an equation
  first" (`commands.js`). Bundled to `editor.bundle.js`.

### The `src/domain` boundary — the rule that matters most

**`src/domain/` must never import from `src/main/`.** This is enforced by convention
(see `docs/nemeth-v2/INTERFACES.md`) and is why the Nemeth parser emits LaTeX rather
than MathML directly — MathML generation stays centralized in `src/main/mathml.js`, one
path (`convertLatexToMathML` → `canonicalizeMathML` → `parseMathML`) for both
LaTeX-authored and Nemeth-authored equations, so they can never silently drift apart. If
you're adding domain logic that seems to need something from `src/main`, that's a signal
the boundary belongs somewhere else, not a reason to add the import.

`src/domain/model.js` holds napkin/item state factories, validation, and immutable
operations (`SCHEMA_VERSION` / `MATH_SCHEMA_VERSION` for migrations — see
`src/domain/migration.js`). `src/domain/math-tree.js` handles MathML canonicalization
used by both the model and the Nemeth pipeline.

### Nemeth (braille math authoring)

`src/domain/nemeth/` is a clean-room Nemeth-braille → LaTeX pipeline:
`lexer.js → levels.js → parser.js → latex.js`, orchestrated by `index.js`'s
`parseNemeth(input) -> { ast, latex, diagnostics }`. It's pure and synchronous, no I/O.

- Input is Unicode braille cells (`U+2800`–`U+28FF`) only — Braille-ASCII and QWERTY
  text are rejected by design, not accepted and mistranslated. `symbols.json` is the
  data authority for what cells/kinds exist (not the design doc in
  `docs/nemeth-v2/INTERFACES.md`, which is explicitly marked historical/superseded in
  several places — read the inline superseded-notes there before trusting a section).
  `kinds.js` and `levels.js` similarly carry doc-comments explaining why the shipped
  model differs from the original design (e.g. `levels.js` uses absolute-path level
  strings, not signed integers, because the signed model silently mis-parsed `x_a^n`).
- Unsupported constructs throw `NemethUnsupportedError` — never a partial/guessed parse.
  Its `message` is always `UNSUPPORTED_MESSAGE`, and so is the `userMessage` the composer
  shows, *unless* the throwing call site passed a `userDetail`. Only a handful do: those
  that can name what is missing in plain words and without citing a rule number ("write
  the baseline indicator (dot 5)"), which is the difference between a typo and a construct
  this pipeline cannot read. Adding one is opt-in per call site — there is deliberately no
  `detail`→message map, because refusal causes are not an enumerable set (46 cause families
  across the corpus alone). A new `unsupported()` call site that passes nothing keeps
  today's behaviour. See `src/domain/nemeth/errors.js` and `test/unit/nemeth/user-message.test.js`.
  `ERROR` in the
  correctness gate must stay 0; `REFUSE` (honest unsupported) and `DISAGREE` (silently
  wrong) are not interchangeable, and reducing DISAGREE by weakening a check or deleting
  a test/corpus row is considered gaming the gate.
- Two separate gates measure different things — **never plan Nemeth work from the
  correctness corpus**, it measures rule coverage, not real usage; `nemeth:utility`'s
  core set (currently 26/26) is the one that must not regress. See
  `docs/nemeth-v2/HANDOFF.md` for the full standing-rules list before touching this code.
- `src/domain/nemeth-input.js` is the correct accumulator for cells feeding the Nemeth
  parser. **Do not** reuse `src/domain/ueb-cell-buffer.js` for this — it flushes on
  `U+2800`, which Nemeth uses as a significant token (comparison-sign spacing), so
  reusing it truncates expressions at the first space.
- "Computer braille" keyboard input (a braille keyboard configured to send translated
  text instead of raw cells) is decoded through
  `src/domain/nemeth/computer-braille-en-us.js` for the one verified table
  (`en-us-comp8`). `nemethBrailleInputTable` defaults to `'auto'`:
  `resolveBrailleInputTable` picks between cells and a known table by measurement, which
  is safe *only* because cells (`U+2800`–`U+28FF`) and ASCII are disjoint ranges. It
  still never guesses between two text tables, and unexplained input resolves to `'none'`
  so it refuses rather than half-decodes. The reading is always named in the status line
  — that readback is the containment for a wrong detection, so don't remove it.
  It used to be off by default; that was changed because a contributor whose display was
  correctly configured was refused on every keystroke and had no way to discover the
  picker existed.
- **There is no input-table setting and no six-key chording.** Both were deliberately
  removed; do not reintroduce either without reading this. The table is measured, and
  chording made `s d f j k l` ambiguous — a press of `f` was either dot 1 or the letter
  f, with nothing in the event to tell them apart, which silently corrupted `f(x)` and
  the Nemeth equals sign `.k`. Every fix for that ambiguity was a setting someone had to
  know to set, so the feature went instead. Typing the computer-braille spelling
  (`?a/b#`) is the hardware-free path now, and it is easier than chording was.
- Consequence to keep in mind: `8bc05ae`'s outright refusal of letter keys is gone with
  it — there is no cells-only mode left to fall back to. Its stated concern was input
  being *silently* reinterpreted as mathematics; what holds that line now is the status
  line naming the reading on every keystroke. **Do not remove that readback.**
- `handleComposerUebCell` is gone. It was unreachable (its callers sat behind the
  never-set `__omniyaBrailleSimulation`), so the ⠿-inserts-Nemeth shortcut it implemented
  never ran in a shipped build. It went away with the item-list code it lived in. The
  building block, `isBrailleInsertEquationCell` in `src/domain/ueb-cell-buffer.js`, and
  the old function in git history remain. To revive the shortcut, ⠿ has to be noticed in
  the editor's own input handling.
- `src/renderer/input-capture.js` + `input-log.js` ship and record the input path in
  memory (capped, never persisted). They watch the equation field and the napkin-name
  field. Text typed in the document is NOT logged: the document is a rich editor, not
  a field, and the log must not become a document-wide key log. They exist so a remote blind contributor can send
  Help → Copy braille input diagnostics instead of a description. The dev panel under
  `src/renderer/dev/` renders the same log and is excluded from packaged builds by
  `electron-builder.yml`; `npm run start:dev` is the only way to see it.

### Document model

A napkin is a named local document. Schema v3 stores `{ id, name, doc }`, where `doc` is
plain JSON: paragraphs of text and inline `math` nodes (`{ mathml, source, sourceKind }`).
The shape, its validation and the conversion from the old item list are in
`src/domain/document.js`, which deliberately does not import ProseMirror, so the domain
stays standalone. State round-trips through `storage.js` as JSON; migrations live in
`src/domain/migration.js` keyed off `SCHEMA_VERSION`.

v1 and v2 napkins were a list of items (`text` or `equation`, each with a note). They are
upgraded on load: text becomes paragraphs, an equation becomes a paragraph holding one
math node, and a note becomes a paragraph of its own. `storage.js` copies the old file to
`napkins.before-v3-<time>.json` before the first save overwrites it. Do not remove that
copy: an older build cannot read v3.

The editor is the source of truth while a napkin is open. `app.js` commits its document
into `state` after a short pause (and before switching napkin or closing), then saves.
One undo history, owned by the editor, covers typing and equation changes. It resets when
another napkin is opened.

## Repository structure

- `src/main.js`, `src/preload.cjs`, `src/main/` — Electron boundary, IPC, MathML
  conversion, local persistence.
- `src/domain/` — state model, validation, immutable operations, Nemeth parser (no
  Electron/DOM dependency; must stay importable standalone).
- `src/renderer/` — semantic page, styling, app behavior, MathJax config.
- `scripts/` — corpus import, coverage/utility gates, liblouis staging for packaged
  builds, `open-napkin.mjs`.
- `test/unit/` — model, persistence, MathML, Nemeth pipeline (mirrors `src/domain/nemeth/`).
- `test/e2e/` — Electron workflow + accessibility (axe-core) tests via Playwright.
- `test/corpus/` — the externally-sourced BANA Nemeth corpus graded by `nemeth:coverage`.
- `test/inspect.mjs` — generates the gitignored example napkin at
  `test/artifacts/latest/test.napkin.json` (not a permanent test report).
- `docs/nemeth-v2/` — design record and handoff notes for the Nemeth rewrite; read
  `HANDOFF.md` before `INTERFACES.md` (the latter is superseded in several places).
- `docs/HUMAN-TESTING.md` — the manual human-testing checklist gating `testing` → `main`.
