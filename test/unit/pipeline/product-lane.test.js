import assert from 'node:assert/strict';
import test from 'node:test';

import { decide, ship } from '../../../scripts/ci/ship-pipeline-pr.mjs';
import { decideProduct, namesPull, outsideZone, readModes } from '../../../scripts/ci/product-lane.mjs';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const allowedAuthors = ['ParkingSoman', 'omniya-bot'];
const pr = {
  number: 106,
  changedFiles: 1,
  state: 'OPEN',
  baseRefName: 'testing',
  isCrossRepository: false,
  headRefName: 'product/sandbox-renderer-switch',
  headRefOid: SHA,
  author: { login: 'omniya-bot' },
  isDraft: false,
  mergeable: 'MERGEABLE'
};
const SAID = 'ship it: the owner wrote "ship it" about PR 106';
const file = (filename, extra = {}) => ({ filename, status: 'modified', additions: 3, deletions: 1, ...extra });
const plain = (files) => ({ head: Object.fromEntries(files.map((f) => [f.filename, '100644'])), base: Object.fromEntries(files.map((f) => [f.previous_filename ?? f.filename, '100644'])) });
const product = (files, over = {}, extra = {}) =>
  decide({
    pr: { ...pr, changedFiles: files.length, ...over }, sha: SHA, allowedAuthors, missing: [], pushers: ['omniya-bot'],
    files, ownerSaid: SAID, modes: plain(files), ...extra
  });

// ---- accepted ----

test('a product pull request that touches only src, test and docs ships on the owner\'s words', () => {
  const files = [file('src/main.js'), file('src/main/renderer-sandbox.js', { status: 'added', deletions: 0 }), file('test/unit/renderer-sandbox.test.js', { status: 'added', deletions: 0 }), file('docs/word-editor.md')];
  const out = product(files);
  assert.equal(out.ship, true);
  assert.equal(out.tier, 'product');
});

test('the owner may also author it, and a plain rename inside the zone is fine', () => {
  assert.equal(product([file('src/a.js')], { author: { login: 'ParkingSoman' } }).ship, true);
  const moved = file('src/b.js', { status: 'renamed', previous_filename: 'src/a.js', additions: 0, deletions: 0 });
  assert.equal(product([moved]).ship, true);
  assert.equal(product([file('test/unit/new.test.js', { status: 'added', deletions: 0 })]).ship, true);
  assert.equal(product([file('src/x.js', { status: 'removed', additions: 0 })]).ship, true);
  assert.equal(product([file('docs/CHANGELOG.md')]).ship, true);
});

test('a path that is deep, or has dots, dashes and digits inside a name, is fine', () => {
  for (const p of ['src/renderer/editor/math-node-view.js', 'test/e2e/launch-electron.js', 'docs/nemeth-v2/HANDOFF.md', 'src/domain/nemeth/symbols.json', 'test/unit/a.b.c-1_2.test.js']) {
    assert.equal(outsideZone(p), null, p);
  }
});

// ---- refused: the file rule ----

test('refuses every file outside src, test and docs, whatever else is in the pull request', () => {
  const outside = [
    '.github/workflows/pipeline-agent.yml', '.github/workflows/anything.yml', '.github/CODEOWNERS', '.github/contributors.yml',
    'package.json', 'package-lock.json', 'electron-builder.yml', 'scripts/ci/hand-off.mjs', 'scripts/build-editor.mjs',
    '.claude/skills/pipeline-change/SKILL.md', '.claude/settings.json', 'CLAUDE.md', 'README.md', 'LICENSE', '.gitignore', '.npmrc', 'CODEOWNERS'
  ];
  for (const path of outside) {
    const alone = product([file(path)]);
    assert.equal(alone.ship, false, path);
    assert.ok(alone.reason.includes(path), `names ${path}: ${alone.reason}`);
    const mixed = product([file('src/ok.js'), file(path), file('docs/ok.md')]);
    assert.equal(mixed.ship, false, `mixed with ${path}`);
    assert.ok(mixed.reason.includes(path), mixed.reason);
  }
});

test('refuses a path that only contains the word src, test or docs', () => {
  for (const path of ['lib/src-fake/x.js', 'srcx/y.js', 'src-fake/y.js', 'a/src/y.js', 'scripts/src/y.js', 'testing/x.js', 'tests/x.js', 'docs-old/x.md', 'documents/x.md', 'src', 'src/', 'test', 'docs']) {
    assert.equal(product([file(path)]).ship, false, path);
  }
});

test('refuses the grading data and the pipeline\'s own tests, in any case', () => {
  for (const path of ['test/corpus/nemeth-v1.json', 'test/corpus/new/row.json', 'test/Corpus/x.json', 'test/CORPUS/x.json', 'test/corpus', 'test/unit/pipeline/hand-off.test.js', 'test/unit/Pipeline/x.test.js', 'test/unit/PIPELINE/x.js', 'test/unit/pipeline/product-lane.test.js']) {
    const out = product([file(path)]);
    assert.equal(out.ship, false, path);
    assert.match(out.reason, /does not ship|a word/, path);
  }
  assert.equal(product([file('test/corpus-notes.md')]).ship, true, 'a name that merely starts like the corpus directory is not it');
  assert.equal(product([file('test/unit/pipelines.test.js')]).ship, true);
});

test('refuses a path that could resolve elsewhere: dot-dot, backslash, trailing dot or space, different case, odd characters', () => {
  const bad = [
    'src/../scripts/ci/x.mjs', 'docs/../.github/workflows/x.yml', 'src/./x.js', 'src//x.js', '/src/x.js', 'src/x.js/',
    'src\\..\\scripts\\x.js', 'src\\x.js', 'test/corpus./x.json', 'test/corpus /x.json', 'src/x.js.', 'src/x.js ', 'src/x y.js',
    'SRC/x.js', 'Src/x.js', 'Test/x.js', 'DOCS/x.md', 'test/corpu~1/x', 'test/corpus::$DATA', 'src/ｘ.js', 'src/x\u0000.js', 'src/.hidden.js', 'src/.git/config', 'test/.env', 'docs/.github/x', 'src/x%2e%2e/y', 'src/é.js'
  ];
  for (const path of bad) assert.equal(product([file(path)]).ship, false, JSON.stringify(path));
});

test('refuses a rename or copy whose OLD path is outside the zone', () => {
  for (const from of ['scripts/ci/ship-pipeline-pr.mjs', '.github/workflows/pipeline-ship.yml', 'package.json', 'test/corpus/nemeth-v1.json', 'test/unit/pipeline/hand-off.test.js']) {
    for (const status of ['renamed', 'copied']) {
      const out = product([file('src/stolen.js', { status, previous_filename: from, additions: 0, deletions: 0 })]);
      assert.equal(out.ship, false, `${status} from ${from}`);
      assert.ok(out.reason.includes(from), out.reason);
    }
  }
});

test('refuses a symlink, an executable, a submodule, or a flipped mode, before or after', () => {
  const f = file('src/link.js');
  for (const mode of ['120000', '100755', '160000', '040000', undefined]) {
    const out = product([f], {}, { modes: { head: { 'src/link.js': mode }, base: { 'src/link.js': '100644' } } });
    assert.equal(out.ship, false, String(mode));
    assert.match(out.reason, /src\/link\.js/);
  }
  // it was an executable and is now plain: that is also a flip
  const flip = product([f], {}, { modes: { head: { 'src/link.js': '100644' }, base: { 'src/link.js': '100755' } } });
  assert.equal(flip.ship, false);
  assert.match(flip.reason, /before this change/);
  // an added file has no old mode, and that is fine
  assert.equal(product([file('src/new.js', { status: 'added' })], {}, { modes: { head: { 'src/new.js': '100644' }, base: {} } }).ship, true);
  // a rename: the old mode is read under the old name
  const moved = file('src/b.js', { status: 'renamed', previous_filename: 'src/a.js', additions: 0, deletions: 0 });
  assert.equal(product([moved], {}, { modes: { head: { 'src/b.js': '100644' }, base: { 'src/a.js': '120000' } } }).ship, false);
  assert.equal(product([moved], {}, { modes: { head: { 'src/b.js': '100644' }, base: {} } }).ship, false, 'no old mode for a rename: cannot tell');
});

test('refuses when the modes could not be read in full', () => {
  assert.match(product([file('src/a.js')], {}, { modes: null }).reason, /modes could not be read/);
  assert.match(product([file('src/a.js')], {}, { modes: { head: {} } }).reason, /modes could not be read/);
});

test('refuses a deleted test, a test moved out of test/, and a test that loses more lines than it gains', () => {
  assert.match(product([file('test/unit/a.test.js', { status: 'removed', additions: 0, deletions: 20 })]).reason, /deletes or moves a test/);
  const out = product([file('docs/a.test.md', { status: 'renamed', previous_filename: 'test/unit/a.test.js', additions: 0, deletions: 0 })]);
  assert.match(out.reason, /deletes or moves a test/);
  assert.match(product([file('test/unit/model.test.js', { additions: 2, deletions: 9 })]).reason, /loses more lines than it gains/);
  assert.equal(product([file('test/unit/model.test.js', { additions: 9, deletions: 9 })]).ship, true);
  assert.equal(product([file('src/a.js', { additions: 0, deletions: 400 })]).ship, true, 'source may shrink');
});

test('refuses a change kind it does not know, and a pull request with no files', () => {
  assert.equal(product([file('src/a.js', { status: 'changed' })]).ship, false);
  assert.equal(product([file('src/a.js', { status: undefined })]).ship, false);
  assert.equal(decideProduct({ files: [], modes: plain([]), missing: [], number: 106, ownerSaid: SAID, says: true }).ship, false);
});

test('refuses when the file list is not the whole change', () => {
  assert.match(product([file('src/a.js')], { changedFiles: 2 }, { files: [file('src/a.js')] }).reason, /not complete/);
  assert.match(product([file('src/a.js')], { changedFiles: 3000 }, { files: Array.from({ length: 3000 }, (_, i) => file(`src/f${i}.js`)) }).reason, /not complete/);
});

// ---- refused: the shared rules, which come first ----

test('refuses a contributor fix branch, a plain claude branch, a wrong lane, a fork, a draft, a conflict, a moved head, a stranger', () => {
  const cases = [
    [{ headRefName: 'claude/fix-12-wrong-sign' }, /neither pipeline\/ nor product\//],
    [{ headRefName: 'claude/sandbox-renderer-switch' }, /neither/],
    [{ headRefName: 'claude/issue-12-20261015' }, /neither/],
    [{ headRefName: 'Product/x' }, /neither/],
    [{ headRefName: 'xproduct/x' }, /neither/],
    [{ headRefName: 'feature/product/x' }, /neither/],
    [{ baseRefName: 'main' }, /into testing/],
    [{ isCrossRepository: true }, /fork/],
    [{ isCrossRepository: undefined }, /fork/],
    [{ author: { login: 'a-contributor' } }, /author/],
    [{ isDraft: true }, /draft/],
    [{ state: 'CLOSED' }, /not open/],
    [{ mergeable: 'CONFLICTING' }, /cleanly/],
    [{ headRefOid: 'c'.repeat(40) }, /moved/]
  ];
  for (const [over, why] of cases) {
    const out = product([file('src/a.js')], over);
    assert.equal(out.ship, false, JSON.stringify(over));
    assert.match(out.reason, why);
  }
  assert.match(product([file('src/a.js')], {}, { pushers: ['omniya-bot', 'a-contributor'] }).reason, /pushed to the branch/);
  assert.match(product([file('src/a.js')], {}, { pushers: [] }).reason, /pushed to the branch/);
});

test('a pipeline branch that carries app files is still refused, and a product branch that carries automation is too', () => {
  const lane = decide({ pr: { ...pr, headRefName: 'pipeline/x' }, sha: SHA, allowedAuthors, missing: [], pushers: ['omniya-bot'], files: [file('src/a.js')], ownerSaid: SAID });
  assert.equal(lane.ship, false);
  assert.match(lane.reason, /more than the automation/);
  assert.equal(product([file('scripts/ci/gh.mjs')]).ship, false);
});

test('refuses unless every required check is green on the head, and names the ones that are not', () => {
  const out = product([file('src/a.js')], {}, { missing: ['e2e', 'pack-win'] });
  assert.equal(out.ship, false);
  assert.match(out.reason, /e2e, pack-win/);
});

test('refuses without "ship it", without the pull request number, or with words that are not a ship it', () => {
  for (const said of ['', 'ship it', 'ship it 1060', 'ship it about PR 10', 'looks good, PR 106', 'merge 106', undefined]) {
    const out = product([file('src/a.js')], {}, { ownerSaid: said });
    assert.equal(out.ship, false, JSON.stringify(said));
    assert.match(out.reason, /ship it.*106/);
  }
  for (const said of ['ship it 106', 'ship it: PR 106', 'ship it (#106)', 'Ship It #106!', 'please ship it, https://github.com/o/r/pull/106']) {
    assert.equal(product([file('src/a.js')], {}, { ownerSaid: said }).ship, true, said);
  }
});

test('namesPull matches a whole number only', () => {
  assert.equal(namesPull('PR 106', 106), true);
  assert.equal(namesPull('#106', '106'), true);
  assert.equal(namesPull('1060', 106), false);
  assert.equal(namesPull('2106', 106), false);
  assert.equal(namesPull('', 106), false);
});

test('the first offence is the one named, and the reason is one sentence with no line break', () => {
  const out = product([file('src/ok.js'), file('package.json'), file('scripts/ci/x.mjs')]);
  assert.match(out.reason, /^package\.json /);
  assert.ok(!out.reason.includes('\n'));
});

// ---- the whole run, with a stand-in for gh ----

function fakeGh({ view = pr, conclusion = 'success', pushes = ['omniya-bot'], files, headModes, baseModes, treeFails = false, truncated = false } = {}) {
  const calls = [];
  const run = (args, opts = {}) => {
    calls.push({ args, token: opts.token });
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(view);
    if (args[0] === 'api' && args.some((a) => a.endsWith('/activity'))) return JSON.stringify(pushes.map((a) => ({ a })));
    if (args[0] === 'api' && args[1].endsWith('/files')) return files.map((f) => JSON.stringify(f)).join('\n');
    if (args[0] === 'api' && args.some((a) => a.includes('/compare/'))) return `${BASE}\n`;
    if (args[0] === 'api' && /\/git\/commits\//.test(args[1])) return `tree-${args[1].split('/').pop()}\n`;
    if (args[0] === 'api' && args.some((a) => /\/git\/trees\//.test(a))) {
      if (treeFails) throw new Error('boom');
      const head = args.some((a) => a.includes(`tree-${SHA}`));
      const modes = head ? headModes : baseModes;
      return JSON.stringify({ truncated, entries: Object.entries(modes).map(([path, mode]) => ({ path, mode })) });
    }
    if (args.some((a) => a.endsWith('/actions/runs'))) {
      return JSON.stringify([
        { id: 11, path: '.github/workflows/pr-checks.yml', created_at: 't', conclusion },
        { id: 12, path: '.github/workflows/pr-build.yml', created_at: 't', conclusion }
      ]);
    }
    if (args.some((a) => /\/actions\/runs\/1[12]\/jobs$/.test(a))) {
      const names = args.some((a) => a.includes('/runs/11/')) ? ['unit', 'nemeth', 'e2e'] : ['pack-mac', 'pack-win'];
      return JSON.stringify(names.map((name) => ({ name, conclusion })));
    }
    return '';
  };
  return { run, calls };
}
const files1 = [file('src/main.js'), file('test/unit/x.test.js', { status: 'added', additions: 5, deletions: 0 })];
const goodModes = { headModes: { 'src/main.js': '100644', 'test/unit/x.test.js': '100644', 'run.sh': '100755' }, baseModes: { 'src/main.js': '100644', 'run.sh': '100755' } };
const input = { pr: 106, sha: SHA, repo: 'a/b', allowedAuthors, mergeToken: 'app-token', ownerSaid: SAID };

test('ships through the same lock and merge as the pipeline lane: App status first, then a squash pinned to the head', () => {
  const { run, calls } = fakeGh({ files: files1, view: { ...pr, changedFiles: 2 }, ...goodModes });
  const out = ship(input, run, () => {});
  assert.equal(out.shipped, true);
  assert.equal(out.tier, 'product');
  const status = calls.find((c) => c.args[0] === 'api' && c.args[1].includes('/statuses/'));
  assert.ok(status.args.includes('context=contributor-tested'));
  assert.equal(status.token, 'app-token');
  const merge = calls.find((c) => c.args[1] === 'merge');
  assert.equal(merge.token, 'app-token');
  assert.ok(merge.args.includes('--squash') && !merge.args.includes('--admin'));
  assert.equal(merge.args[merge.args.indexOf('--match-head-commit') + 1], SHA);
  assert.ok(calls.indexOf(status) < calls.indexOf(merge));
});

test('a refusal sets no status, merges nothing, and touches no label', () => {
  const setups = [
    { files: [file('package.json')], headModes: { 'package.json': '100644' }, baseModes: { 'package.json': '100644' } },
    { files: files1, ...goodModes, conclusion: 'failure' },
    { files: files1, ...goodModes, view: { ...pr, changedFiles: 2, headRefName: 'claude/fix-3-x' } },
    { files: files1, ...goodModes, view: { ...pr, changedFiles: 2, headRefOid: 'c'.repeat(40) } },
    { files: files1, ...goodModes, pushes: ['omniya-bot', 'a-contributor'] },
    { files: files1, headModes: { ...goodModes.headModes, 'src/main.js': '120000' }, baseModes: goodModes.baseModes },
    { files: files1, ...goodModes, treeFails: true },
    { files: files1, ...goodModes, truncated: true }
  ];
  for (const setup of setups) {
    const { run, calls } = fakeGh({ view: { ...pr, changedFiles: setup.files.length }, ...setup });
    assert.equal(ship(input, run, () => {}).shipped, false, JSON.stringify(setup.view ?? setup.files));
    assert.equal(calls.some((c) => c.args[0] === 'api' && c.args[1].includes('/statuses/')), false);
    assert.equal(calls.some((c) => c.args[1] === 'merge'), false);
    assert.equal(calls.some((c) => /label|edit/.test(c.args[1] ?? '') && c.args[0] !== 'api'), false);
  }
  const { run } = fakeGh({ files: files1, view: { ...pr, changedFiles: 2 }, ...goodModes });
  assert.equal(ship({ ...input, ownerSaid: 'ship it' }, run, () => {}).shipped, false, 'no pull request number in the words');
});

test('readModes reads the tree of the head and of the merge base, and gives up on a truncated tree', () => {
  const { run } = fakeGh({ files: files1, ...goodModes });
  const modes = readModes({ repo: 'a/b', sha: SHA, gh: run });
  assert.equal(modes.head['src/main.js'], '100644');
  assert.equal(modes.base['run.sh'], '100755');
  assert.equal(readModes({ repo: 'a/b', sha: SHA, gh: fakeGh({ files: files1, ...goodModes, truncated: true }).run }), null);
});

test('the lane\'s own files are in the lock, so a product pull request cannot loosen the zone', async () => {
  const { isLock } = await import('../../../scripts/ci/ship-pipeline-pr.mjs');
  assert.equal(isLock('scripts/ci/product-lane.mjs'), true);
  assert.equal(isLock('test/unit/pipeline/product-lane.test.js'), true);
  for (const path of ['scripts/ci/product-lane.mjs', 'test/unit/pipeline/product-lane.test.js', 'scripts/ci/ship-pipeline-pr.mjs', '.github/workflows/pipeline-ship.yml']) {
    assert.notEqual(outsideZone(path), null, path);
  }
});
