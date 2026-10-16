# Omniya Core

A research prototype exploring screen-reader-first mathematical workspaces.

The usage notes below apply to **`testing` only**. They are not on `main`. This page is the alpha branch.

## How to use this alpha

**Write text.** Each note is one document, and it works like Word. Type in it. **Enter**
starts a new paragraph. **Ctrl+Z** undoes and **Ctrl+Y** redoes (**Cmd+Z** and
**Cmd+Shift+Z** on Mac), for typing and equations alike. Braille for your text is
your screen reader's job, in the table you chose there. [`docs/word-editor.md`](docs/word-editor.md) lists every key and why it is there.

**Insert an equation.** **Alt+=** (Windows) or **Control+=** (Mac) opens a small field at the
caret. Type Nemeth or LaTeX: **Ctrl+E** picks Nemeth and **Ctrl+L** picks LaTeX while the
field is empty. **Enter** inserts the equation and puts you back in the document, right
after it. **Escape** cancels. An equation sits inside the sentence as one unit.

**Type Nemeth.** The field works in braille cells, and it works out how your input
arrives on its own — there is nothing to configure. A braille display sending raw cells,
a display set to a computer-braille table that sends plain text, and an ordinary keyboard
typing the computer-braille spelling all reach the parser the same way. As you type, the
status line reads back what it has: *"5 cells read as x^{2}+1. Enter inserts it."*, and it
names the reading it used (*"read as computer braille"*) whenever your input was text
rather than cells — so if it ever reads your device wrongly, you hear it immediately.

With no braille hardware at all, type the computer-braille spelling: `?a/b#` is the
fraction a over b, `#2+#2 .k #4` is 2+2=4, `x^2` is x squared.

A construct genuinely outside Nemeth's current coverage is refused with a fixed message —
but only once you press **Enter**. While typing, *"not a complete expression yet"* is the
normal, expected state, not an error.

**If input seems to do nothing,** the setting that matters is on your braille device, not
in this app: it has to be sending either raw braille cells or a *computer-braille* /
uncontracted table. A contracted literary table (UEB grade 2) cannot be read back into
Nemeth by anything, because contractions are not reversible. On NVDA, Settings → Braille →
Input table set to **Unicode braille** or **English (U.S.) computer braille** both work.

Still stuck? **Help → Copy braille input diagnostics** puts the build you are on, the
reading in force, and what the field actually received for your last few keystrokes on the
clipboard — paste that into your report. It is copied only when you ask, is never written
to disk or sent anywhere, and you can read it first: it includes the mathematics you were
typing.

**Read and edit math.** Arrow keys move past an equation as one unit: the first press
selects it, the next moves on. **Backspace** next to it selects it, and a second
**Backspace** deletes it. With an equation selected, **Enter** explores inside it. There,
**r** replaces the focused part, **a** inserts after it, and **o** inserts before it.
**Escape** returns to the document with the equation still selected.

Everything above is also in the application menus (Insert / Format / Help — Alt on Windows,
menu bar on Mac) and in Shortcuts, the button in the toolbar. Ctrl+N (Cmd+N) starts a new note. Ctrl+F (Cmd+F) finds in the note. Ctrl+P (Cmd+P) prints. **Export** saves a web page, a LaTeX file or plain text. Double-click an equation to read it by parts.

Download the alpha (or run from source): [Run this alpha](#run-this-alpha). Longer walkthrough: [`docs/HUMAN-TESTING.md`](docs/HUMAN-TESTING.md).

## What the app is

Omniya Core is a small **local Electron app** for writing and reading mathematics with a screen reader, a keyboard, and (on this branch) a Braille display. You create named documents the interface calls **napkins**, add text and equations, explore equation structure, and save the work as JSON on your computer. There is no account and no cloud. Testers can download an unsigned build from the [testing prerelease](https://github.com/ParkingSoman/omniya-core/releases/tag/testing-app).

It is an experimental workspace for blind mathematicians, blind STEM students, screen-reader users, and accessibility researchers. It is not a finished editor. Automated tests are not evidence that the workflow is usable without feedback from blind users.

You are on **`testing`**, the alpha. Newer functionality lives here and has **not** been completely verified by humans. **`main`** is the GitHub default and the last snapshot a human has signed off.

## Which branch should I use?

- **`main` (default).** Last human-signed-off snapshot. `git clone` lands there. Napkin read / add / edit shell, local MathJax, LaTeX equations, offline save. Later experiments are not on that branch.
- **`testing` (alpha, this branch).** The current product assembly. A Word-style editor, literary UEB, Nemeth authoring, and BANA evidence grind. This functionality has not been completely verified by humans. It is not a BANA conformance release. If you want to try the current app, stay here.
- **Feature / `codex/…` lanes.** Experimental work. Not for running the app.

## Run this alpha

Open the [testing-app prerelease](https://github.com/ParkingSoman/omniya-core/releases/tag/testing-app).

- **Apple Silicon Mac:** download the arm64 mac zip, unzip, and open **Omniya Core**. If macOS blocks it: System Settings → Privacy & Security → Open Anyway, or right-click the app → Open. The app is unsigned, so it does not auto-update; it checks each launch and shows a banner with a link back to this release page when a newer testing build exists — re-download and reinstall from there.
- **Windows x64:** download and run the installer, **Omniya-Core-Setup-x64.exe**. If SmartScreen: More info → Run anyway. After that first install, the app auto-updates itself in the background on future testing-branch pushes — no more re-downloading. (If you already have an older unzip-and-run install, it does not upgrade automatically; do this one manual reinstall once, then updates take over.)

Literary UEB is bundled with the app. This path does not need Homebrew liblouis or Node.

Intel Mac is not packaged yet — use [run from source](#run-from-source).

### Run from source

You need [Node.js](https://nodejs.org/) and git. Do not open `src/renderer/index.html` in a browser; the app has to run through Electron.

If you just cloned the repo (you will be on `main`):

```bash
git clone https://github.com/ParkingSoman/omniya-core.git
cd omniya-core
git checkout testing
npm install
npm start
```

If you are already on `testing`:

```bash
npm install
npm start
```

When you are not using a packaged build, literary UEB labels need Homebrew [liblouis](https://liblouis.io/) (`lou_translate` on your PATH, or set `OMNIYA_LOU_TRANSLATE`). Walkthrough: [`docs/HUMAN-TESTING.md`](docs/HUMAN-TESTING.md). More runtime detail is later under [Run and test](#run-and-test).

## At a glance

The bullets below describe **this alpha**, not the signed-off `main` snapshot. None of it is a claim that humans have signed the workflow off.

- **Status:** Unverified alpha (human-testing gate, not a release)
- **Platform:** Electron, vanilla HTML/CSS/JavaScript
- **Storage:** Local JSON files
- **Math:** LaTeX and Nemeth, native MathML, local MathJax explorer
- **Braille:** Literary UEB via liblouis; Nemeth in the equation field
- **Network:** No network access required
- **Primary purpose:** Generate conversation about screen-reader-first mathematical workflows
- **Best contributions now:** Community discussion, critique, assistive-technology testing on this branch

## Contents

- [How to use this alpha](#how-to-use-this-alpha)
- [What the app is](#what-the-app-is)
- [Which branch should I use?](#which-branch-should-i-use)
- [Run this alpha](#run-this-alpha)
- [Run from source](#run-from-source)
- [Why this exists](#why-this-exists)
- [The document model](#the-document-model)
- [Current capabilities](#current-prototype-capabilities)
- [Status and boundaries](#current-project-phase-and-boundaries)
- [Where help is most useful now](#where-help-is-most-useful-now)
- [Project direction](#project-direction)
- [How to contribute](#how-to-contribute)
- [Run and test](#run-and-test)
- [Project status and license](#project-status-stewardship-and-license)

## Why this exists

Most mathematical software is designed visually first and made accessible afterward. That order can leave the underlying document model, navigation, focus behavior, and interaction language mismatched with how a blind person actually reads and constructs mathematics.

Omniya Core is exploring the opposite order. The project is trying to understand what a mathematical workspace should be when semantic structure, speech, Braille, keyboard navigation, and user control are primary design inputs rather than accessibility layers added at the end.

The current prototype is intentionally modest so that these questions remain visible:

- How should a screen-reader-first workspace represent a sequence of mathematical thoughts?
- How should a user move between prose, equations, annotations, and earlier ideas?
- What should reading, editing, exploration, and recovery feel like when visual layout is not primary?
- How should native MathML, speech, Braille, keyboard interaction, and local privacy work together?

These are research questions, not settled product requirements.

## Who this project is for

Omniya Core is being built for and with:

- blind mathematicians and blind STEM students;
- screen-reader users who work with mathematical notation;
- accessibility engineers and assistive-technology specialists;
- MathML, LaTeX, speech, and Braille specialists;
- interaction and UX researchers;
- educators, Electron/JavaScript developers, and technical writers.

You do not need to be a programmer to contribute. The most valuable contribution may be a careful description of a confusing interaction, a screen-reader observation, a better evaluation question, or evidence that a seemingly obvious design decision does not work.

## The current document model

The prototype stores named local documents. Each document is one Word-style document of paragraphs, with equations inside the text. The interface calls these documents “napkins,” but the name is only a friendly label. Users can create and switch between documents, type and undo as in any word processor, insert equations as Nemeth or LaTeX, explore equations semantically, edit part of an equation, and save the work locally.

## Why the approach is different

This project is not trying to retrofit a conventional visual editor with labels and keyboard shortcuts. The prototype is intentionally scratchwork: a small research instrument for asking better design questions before committing to a larger architecture.

The intended process is to:

- begin with the lived experience of blind mathematicians and screen-reader users, rather than treating accessibility as a later compliance pass;
- keep the document model, interaction rules, and visual layer small and reversible while assumptions are being tested;
- use concrete workflows—reading a sequence, entering an equation, revisiting an earlier idea, recovering from an error—to expose where a design helps or fails;
- preserve semantic structure so research can examine MathML, speech, Braille, focus, and keyboard behavior directly;
- prefer local, offline experiments that are easy to run, inspect, and change;
- treat every current interaction as a hypothesis, not as the final product language.

The point of the Electron app is to make these hypotheses testable. The architecture is provisional and may be replaced when research with blind users exposes a better model. Major decisions should be discussed, tested, and revised with the people who rely on the resulting experience—not inferred by sighted developers from visual convenience alone.

## Current prototype capabilities

This section is the **alpha** on `testing`, not the signed-off `main` snapshot. Humans have not completely verified it. The practical checklist is [`docs/HUMAN-TESTING.md`](docs/HUMAN-TESTING.md).

On this branch you can create, switch, rename and delete notes; write in a Word-style document with inline equations; insert an equation with Alt+= (Windows) or Control+= (Mac), as Nemeth or LaTeX; explore MathML and press **r** to replace a part of an equation; save locally; and run the BANA evidence grind.

The interface uses semantic HTML, native form controls, labeled fields, visible focus indicators, a narrow preload bridge, context isolation, a sandboxed renderer, and a restrictive content-security policy.

## Current project phase and boundaries

Omniya Core is in a ground-up exploration and conversation phase. The immediate question is not whether this particular UI is the right one. It is what people need from an accessibility-first workspace for creating, revisiting, and navigating mathematics, and which assumptions should be discarded before a real product is designed.

The architecture is provisional. This prototype should be treated as a conversation prompt and source of concrete questions, not as a finished replacement for existing mathematical software.

This prototype deliberately does not include:

- accounts, authentication, or profiles;
- cloud sync, collaboration, or network services;
- AI features or telemetry;
- rich text, visual layout editing, or a conventional canvas;
- general import/export, search, or formal proof management;
- production-signed installers and Intel Mac zips (the testing prerelease is unsigned alpha packaging only);
- a claim that the current interaction model is ready for sustained mathematical work.

Keeping these boundaries narrow is intentional. Large features would make it harder to learn whether the core reading, equation exploration, editing, and persistence model is sound.

## Where help is most useful now

The highest-priority contribution right now is conversation with the community about what an accessibility-first mathematical workspace should be. The existing client is a concrete prompt for that conversation, not an interaction model the project has already chosen.

Useful ways to participate are:

1. Share how you currently read, write, revisit, and organize mathematics with a screen reader, Braille display, keyboard, or other assistive technology.
2. Question the assumptions represented by this scratchwork and propose fundamentally different models.
3. Discuss what should be designed from the ground up before implementation choices become constraints.

For now, start a design-focused GitHub issue for a conceptual question, lived experience, or alternative model. Use an issue for concrete behavior reports too; broader discussion threads, interviews, and community calls can grow around those questions as the project develops.

Assistive-technology testing, documentation, MathML review, interaction experiments, usability-study design, and focused bug fixes are useful when they support that discussion. Contributors are encouraged to question the current UI and architecture rather than assume they must preserve them.

## Project direction

Near-term and longer-term work are both research questions, not a feature roadmap. The distinction is urgency and scope: near-term questions concern the basic shape of a workspace, while longer-term questions concern what that workspace might support once its foundations are understood.

### Near-term design questions

The most pressing questions are simple but foundational:

- How should a person create and read a sequence of thoughts, return to earlier context, and understand where they are?
- What should focus, selection, and screen-reader announcements communicate at each level?
- How should entering, exploring, editing, and discussing an equation relate to one another?
- Which parts of a mathematical document should be visible, available, or local at each moment?
- How should these questions be discussed and evaluated with blind mathematicians and students?

Usability sessions, assistive-technology testing, interaction experiments, and documentation are ways to investigate these questions—not commitments to preserve the current interface.

### Longer-term research questions

If those foundations prove useful, later research might explore organizing proofs, definitions, claims, equations, and dependencies; nonvisual representations of larger mathematical structures; searching substantial bodies of work; accessible collaboration and interoperable formats; Braille and educational workflows; privacy-preserving synchronization; and extensibility without compromising semantic and keyboard access.

These directions should be shaped through research and collaboration with blind users, not selected solely by maintainers or sighted developers.

## How to contribute

The project is especially interested in thoughtful discussion before implementation. You do not need to write code, and you do not need to treat the current client as a foundation to preserve.

Useful entry points include screen-reader testing, reproducible accessibility reports, automated keyboard/accessibility tests, MathML or MathJax review, interaction experiments, documentation, focused bug fixes, and respectful usability-study design. Small experiments are preferred to large unsolicited rewrites.

### Reporting a bug in the alpha

If you are running the alpha and something behaves wrongly, use the **Bug report** issue form rather than a blank issue. It asks what happened, what you expected instead, and for the output of Help → Copy braille input diagnostics. A report filed that way is picked up, reproduced, fixed and built for you to install and check on your own hardware, without anyone couriering it by hand. See [docs/contributor-pipeline.md](docs/contributor-pipeline.md) for what happens after you press submit, and for what the diagnostics dump contains before you paste it into a public issue.

That path is for bugs only. A request for behavior that does not exist yet is a design decision, and the guidance below applies instead.

### What makes a strong issue

Start with the user problem and affected workflow. Describe the observed experience or open design question; expected and actual behavior; operating system, screen reader, runtime, and input method; exact napkin content or reproduction steps; and a focused reproduction when possible.

### What makes a strong pull request

Keep the change narrow and link it to an issue or documented experiment. Explain the rationale, accessibility impact, and whether the implementation is intentionally exploratory. Include or update tests for behavioral changes, preserve offline behavior, semantic HTML, native MathML, and understandable focus behavior.

Accessibility work should not be treated as guesswork. Please avoid making broad design decisions “for blind users” without evidence, testing, or consultation. A respectful report that says “I do not know yet; here is what I observed” is more useful than confident visual-first speculation.

Major interaction and document-model changes should begin as issues or small experiments. They should not be merged solely because they are visually convenient or pass automated accessibility checks.

## Testing with assistive technology

Automated tests cover important invariants, but they cannot establish that the workflow is genuinely usable. Before expanding the prototype, manually complete the full flow with a screen reader: create and switch napkins; type a paragraph, put an equation inside a sentence, and undo and redo it; explore nested expressions and matrix cells; edit and cancel; trigger a conversion error; delete an equation and a napkin; then close and reopen saved work.

Pay attention to how the equation is announced as the caret passes it, equation structure, focus after every action, save status, and recovery instructions. Record the screen reader, operating system, Electron version, and keyboard used.

## Run and test

For the human-testing gate build (guided Nemeth + UEB command mode), check out
the `testing` branch and see [`docs/HUMAN-TESTING.md`](docs/HUMAN-TESTING.md). Clone and `npm start` steps are under [Run from source](#run-from-source).

The prototype requires a current Node.js installation.

```bash
npm install
npm start
```

Run the application through Electron. Opening `src/renderer/index.html` directly does not provide the preload bridge and is not a supported way to test the product.

The renderer and MathJax assets are installed locally. The application is designed to run offline and does not load a CDN. If local MathJax assets are missing, reinstall dependencies with `npm install` rather than adding a network fallback.

By default, committed state is stored as `napkins.json` under Electron’s platform-specific `app.getPath("userData")` directory. The `OMNIYA_TEST_USER_DATA_DIR` environment variable is reserved for isolated automated tests.

## Keyboard interaction

On **`testing`**, start with [How to use this alpha](#how-to-use-this-alpha). In the app, **Shortcuts** (the toolbar button, or Help → Keyboard shortcuts) is the live list.

- Use Tab and Shift+Tab to move through ordinary controls.
- In the notes list, focus a note and press Backspace to delete it after confirmation,
  or Ctrl+U (Cmd+U on macOS) to rename it.
- Type in the document to write. Enter starts a new paragraph. Ctrl+Z (Cmd+Z) undoes. Ctrl+Y (Cmd+Shift+Z on Mac) redoes.
- Alt+= (Windows) or Control+= (Mac) inserts an equation at the caret. In the field, Ctrl+E picks Nemeth and Ctrl+L picks LaTeX while it is empty. Enter inserts the equation. Escape cancels.
- Arrow keys select an equation as one unit, then move past it. Backspace next to an equation selects it. A second Backspace deletes it.
- Press Enter on a selected equation to enter MathJax’s expression explorer. MathJax handles movement through the expression; Escape returns to the document.
- In the explorer, press `r` to replace the focused part. `a` inserts after that same node; `o` inserts before it. Backspace deletes the equation, and undo brings it back.
- Arrow keys inside the equation field retain normal text-cursor behavior.

The document is saved shortly after each change. An unfinished equation in the field is not saved.

## Tests

```bash
npm test
npm run test:e2e
npm run test:all
```

The unit tests cover the domain model, state validation, local JSON persistence, queued atomic writes, corrupt-data recovery, and LaTeX-to-MathML conversion. The Electron tests use isolated user-data directories and cover typing and undo, inserting and editing equations, napkin deletion, upgrading old napkin files, semantic MathML, keyboard exploration, relaunch persistence, offline behavior, and accessibility checks with axe-core. `npm run test:screen-reader` drives real screen readers and is meant for CI; see `docs/word-editor.md`.

The Electron test browser context is placed offline and records unexpected external HTTP requests. On macOS, run GUI tests from a normal logged-in terminal rather than a restricted GUI sandbox; the sandbox can abort GUI applications before the app’s JavaScript starts.

## Opening editable example napkins

Generate a single ignored napkin file containing several separate examples and open it in the normal Electron application:

```bash
npm run test:inspect
```

The examples include plain text, `a+b`, a nested fraction, a matrix, a radical and sum, and a mixed proof scratch napkin. Each is editable through the same application flow as ordinary work. The command overwrites:

`test/artifacts/latest/test.napkin.json`

That path is gitignored and is not a collection of permanent test reports.

To open another compatible napkin file:

```bash
npm run open:napkin -- /path/to/example.napkin.json
```

Committed changes made after opening a file are saved back to that file. A napkin file uses the application’s local JSON state format and may contain multiple napkins.

## Repository structure

- `src/main.js`, `src/preload.cjs`, and `src/main/` provide the secure Electron boundary, narrow bridge, MathML conversion, and local persistence.
- `src/domain/model.js` contains state factories, validation, and immutable napkin operations. `src/domain/document.js` is the saved shape of a document.
- `src/renderer/` contains the semantic page, restrained styling, application behavior, and local MathJax configuration. `src/renderer/editor/` is the Word-style editor, built on ProseMirror and bundled by `scripts/build-editor.mjs`.
- `scripts/open-napkin.mjs` opens an existing napkin file in the normal application.
- `test/unit/` covers model, persistence, MathML, and local assets; `test/e2e/` covers Electron workflows and accessibility acceptance; `test/screen-reader/` drives real screen readers in CI.
- `docs/word-editor.md` is the design record for the editor and its keys.
- `test/inspect.mjs` generates the editable example napkin file.

## Project status, stewardship, and license

Omniya Core is an early prototype maintained by Axiya and released under the Apache License 2.0. The implementation is intentionally small and experimental so people can question its assumptions while ground-up research develops.
