import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { decide as handOff } from '../../../scripts/ci/hand-off.mjs';
import { commandsOf, readWorkflow, whyNotAllowed } from '../../../scripts/ci/job-power.mjs';
import { decideProduct, outsideZone } from '../../../scripts/ci/product-lane.mjs';
import { compile, loadMap, needsFor, outsideAutomatic, ZONES, zoneOf } from '../../../scripts/ci/zones.mjs';

// The rules that make the AUTOMATIC zone safe, held as tests. Classification is by PATH only.
// (a) every path is in exactly one zone, or is the owner's; (b) a job with power runs only gh, git
// and files under scripts/ci/, so nothing in the AUTOMATIC zone ever executes with power;
// (c) a change that touches only AUTOMATIC paths needs nothing, and anything else follows its zone.

const tracked = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => {
    try { readFileSync(f); return true; } catch { return false; }
  });

// ---------------------------------------------------------------- (a) the map

test('the map has the four zones, and a pattern in two zones is refused', () => {
  const map = loadMap();
  for (const zone of ZONES) assert.ok(map[zone].length > 0, `${zone} is empty`);
  assert.doesNotThrow(() => compile(map));
  assert.throws(() => compile({ ...map, goalposts: [...map.goalposts, 'src/**'] }), /src\/\*\* is in both automatic and goalposts/);
  assert.throws(() => compile({ ...map, shipIt: [...map.shipIt, '.gitignore'] }), /\.gitignore is in both/);
  // The same pattern spelled in another case is the same pattern.
  assert.throws(() => compile({ ...map, shipIt: [...map.shipIt, 'SRC/**'] }), /is in both/);
  assert.throws(() => compile({ ...map, shipIt: [...map.shipIt, 'src/*.js'] }), /bad pattern/);
});

test('every path in the repository resolves to exactly one zone, and the ones that fall to the owner are known', () => {
  const rules = compile();
  const owner = [];
  for (const file of tracked()) {
    const hits = rules.filter((r) => (r.dir ? file.toLowerCase().startsWith(`${r.base}/`) : file.toLowerCase() === r.base));
    const top = Math.max(0, ...hits.map((r) => r.weight));
    const best = hits.filter((r) => r.weight === top);
    assert.ok(best.length <= 1, `${file} matches two patterns of the same strength: ${best.map((r) => r.pattern).join(', ')}`);
    assert.equal(zoneOf(file).zone, best[0]?.zone ?? 'owner');
    if (best.length === 0) owner.push(file);
  }
  // Nothing falls to the owner by accident: a new kind of file is a decision, so this list is explicit.
  const expected = (f) =>
    f.startsWith('.github/ISSUE_TEMPLATE/') || f.startsWith('scripts/lab/') ||
    ['.github/CODEOWNERS', '.github/contributors.yml', 'CLAUDE.md', 'README.md', 'LICENSE'].includes(f);
  assert.deepEqual(owner.filter((f) => !expected(f)), [], 'these paths are in no zone: put each in one, with a reason');
});

test('each zone holds what the owner said it holds', () => {
  const zone = (path) => zoneOf(path).zone;
  for (const path of ['src/main.js', 'src/domain/nemeth/parser.js', 'test/e2e/x.test.js', 'test/unit/nemeth/parser.test.js', 'docs/a.md',
    'scripts/build/build-editor.mjs', 'scripts/build/speech-maps.mjs', 'scripts/build/build-sre-mathmaps.mjs', 'scripts/dev/open-napkin.mjs', '.gitignore']) {
    assert.equal(zone(path), 'automatic', path);
  }
  for (const path of ['.github/workflows/pr-build.yml', '.github/prompts/agent.md', 'scripts/ci/hand-off.mjs', '.claude/settings.json',
    'package.json', 'package-lock.json', 'electron-builder.yml', 'test/unit/pipeline/hand-off.test.js']) {
    assert.equal(zone(path), 'shipIt', path);
  }
  for (const path of ['test/corpus/nemeth-v1.json', 'scripts/nemeth-coverage.mjs', 'test/helpers/mathml-compare.js']) {
    assert.equal(zone(path), 'goalposts', path);
  }
  for (const path of ['scripts/ci/zones.json', 'scripts/ci/ship-pipeline-pr.mjs', '.github/workflows/pipeline-ship.yml', 'test/unit/pipeline/zones.test.js']) {
    assert.equal(zone(path), 'lock', path);
  }
  for (const path of ['random.txt', 'scripts/new-thing.mjs', '.github/CODEOWNERS', 'vendor/x']) assert.equal(zone(path), 'owner', path);
});

test('a path that looks safe but resolves elsewhere is the owner\'s, not automatic', () => {
  for (const path of ['src/../scripts/ci/x.mjs', '../src/a.js', 'src//a.js', 'src/./a.js', '/src/a.js', 'src\\a.js', 'src/a\u0000.js', '']) {
    assert.equal(zoneOf(path).zone, 'owner', JSON.stringify(path));
  }
  // A Mac treats these as the same file, so the map does too.
  assert.equal(zoneOf('test/Corpus/x.json').zone, 'goalposts');
  assert.equal(zoneOf('TEST/UNIT/PIPELINE/x.test.js').zone, 'shipIt');
  assert.equal(zoneOf('Scripts/CI/x.mjs').zone, 'shipIt');
  assert.equal(zoneOf('test/unit/pipeline').zone, 'automatic', 'a file called pipeline in test/unit is not the folder');
});

// ---------------------------------------------------------------- (c) what a change needs

test('a change that touches only automatic paths needs nothing; any other follows its zone, the strongest wins', () => {
  assert.equal(needsFor(['src/a.js', 'test/unit/x.test.js', 'docs/a.md', 'scripts/build/speech-maps.mjs', '.gitignore']).needs, 'nothing');
  assert.deepEqual(needsFor(['src/a.js', 'package.json']), { needs: 'ship-it', by: [{ file: 'package.json', zone: 'shipIt' }] });
  assert.equal(needsFor(['src/a.js', 'test/corpus/nemeth-v1.json']).needs, 'owner');
  assert.equal(needsFor(['scripts/nemeth-utility.mjs']).needs, 'owner');
  assert.equal(needsFor(['package.json', 'scripts/ci/zones.json']).needs, 'lock');
  assert.equal(needsFor(['unknown/file']).needs, 'owner');
  assert.equal(needsFor([]).needs, 'nothing');
  assert.deepEqual(outsideAutomatic(['src/a.js', 'scripts/ci/gh.mjs', 'x']), ['scripts/ci/gh.mjs', 'x']);
});

const fixInput = (files, over = {}) => ({
  fixBranch: true, filesComplete: true, mergeable: 'MERGEABLE', body: 'Fixes #1', missing: [],
  files: files.map((filename) => ({ filename, status: 'modified', additions: 5, deletions: 0 })), ...over
});

test('the contributor hand-off and the product lane read the same map', () => {
  const sets = [
    [['src/a.js', 'test/unit/a.test.js', 'docs/a.md', 'scripts/build/speech-maps.mjs', '.gitignore'], true],
    [['src/a.js', 'scripts/ci/hand-off.mjs'], false],
    [['src/a.js', '.github/workflows/pr-build.yml'], false],
    [['src/a.js', 'package.json'], false],
    [['src/a.js', 'test/corpus/nemeth-v1.json'], false],
    [['src/a.js', 'scripts/nemeth-coverage.mjs'], false],
    [['test/unit/pipeline/hand-off.test.js'], false],
    [['src/a.js', 'scripts/mystery.mjs'], false]
  ];
  for (const [files, automatic] of sets) {
    assert.equal(handOff(fixInput(files)).action === 'merge', automatic, `hand-off: ${files.join(', ')}`);
    assert.equal(files.every((f) => outsideZone(f) === null), automatic, `product lane: ${files.join(', ')}`);
  }
});

const modes = (files) => ({ head: Object.fromEntries(files.map((f) => [f, '100644'])), base: Object.fromEntries(files.map((f) => [f, '100644'])) });
const ship = (files) => decideProduct({
  files: files.map((filename) => ({ filename, status: 'modified', additions: 5, deletions: 0 })),
  modes: modes(files), missing: [], number: 109, ownerSaid: 'ship it 109', says: true
});

test('REPLAY of PR 84 and PR 72 after the scripts are moved: both merge by themselves, with the script changes in', () => {
  const pr84 = ['.gitignore', 'docs/nemeth-v2/coverage.md', 'scripts/build/build-editor.mjs', 'scripts/build/build-sre-mathmaps.mjs', 'src/domain/nemeth/parser.js',
    'src/renderer/mathjax-config.js', 'test/e2e/editor-accessibility.test.js', 'test/unit/nemeth/corpus-gate.test.js', 'test/unit/nemeth/script-run.test.js',
    'test/unit/nemeth/user-message.test.js', 'test/unit/speech-enth.test.js'];
  const pr72 = ['.gitignore', 'docs/nemeth-v2/HANDOFF.md', 'docs/nemeth-v2/coverage.md', 'scripts/build/build-editor.mjs', 'scripts/build/speech-maps.mjs', 'src/domain/nemeth/levels.js',
    'src/domain/nemeth/lexer.js', 'src/domain/nemeth/parser.js', 'src/renderer/mathjax-config.js', 'src/renderer/speech-rules.js', 'test/e2e/equation-preview.test.js',
    'test/unit/nemeth/corpus-gate.test.js', 'test/unit/nemeth/function-script.test.js', 'test/unit/speech-function-power.test.js'];
  for (const files of [pr84, pr72]) {
    assert.deepEqual(handOff(fixInput(files)), { action: 'merge' });
    assert.equal(ship(files).ship, true);
  }
  // Before the move, the same two changes were stopped by these paths.
  assert.equal(handOff(fixInput(['src/a.js', 'scripts/speech-maps.mjs'])).action, 'protected');
});

test('REPLAY of a hostile change: scripts/ci, a workflow, package.json, the corpus, a gate, or the map itself all go to the owner', () => {
  const hostile = ['scripts/ci/hand-off.mjs', '.github/workflows/testing-app.yml', 'package.json', 'package-lock.json', 'electron-builder.yml',
    'test/corpus/nemeth-v1.json', 'test/Corpus/nemeth-v1.json', 'scripts/nemeth-coverage.mjs', 'test/helpers/mathml-compare.js',
    'scripts/ci/zones.json', '.claude/settings.json', '.github/CODEOWNERS', 'test/unit/pipeline/zones.test.js'];
  for (const bad of hostile) {
    const files = ['src/domain/nemeth/parser.js', 'scripts/build/speech-maps.mjs', bad];
    assert.equal(handOff(fixInput(files)).action, 'protected', `hand-off let ${bad} through`);
    const refused = ship(files);
    assert.equal(refused.ship, false, `product lane let ${bad} through`);
    assert.match(refused.reason, /not shipped by a word/);
  }
});

// ---------------------------------------------------------------- (b) power

/** Jobs that hold power and still run a repository tool. Each one is a standing exception, and says why. */
const EXCEPTIONS = {
  'pipeline-agent.yml#agent': {
    commands: ['npm', 'brew'],
    why: 'The repair and fix agent runs the branch\'s own tests, so it installs them. It works in a checkout it made, and the App token is minted only for its tools. This is the one job where repository code can run beside a secret.'
  },
  'pipeline-ship.yml#ship': {
    commands: ['npm'],
    why: '`npm ci --ignore-scripts` installs js-yaml, which reads the workflows. Scripts do not run; the package set is package-lock.json, which is ship-it, and this workflow is the lock.'
  }
};

const workflows = readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f));

test('a job with power runs only gh, git and files under scripts/ci/, except the two named exceptions', () => {
  const seen = new Set();
  for (const file of workflows) {
    for (const row of readWorkflow(readFileSync(`.github/workflows/${file}`, 'utf8'))) {
      const key = `${file}#${row.job}`;
      if (row.power.length === 0) continue;
      if (EXCEPTIONS[key]) {
        seen.add(key);
        const names = [...new Set(row.violations.map((v) => /: (\S+) is not gh/.exec(v)?.[1]))];
        assert.deepEqual(names.filter((n) => !EXCEPTIONS[key].commands.includes(n)), [], `${key} runs more than it said it would: ${row.violations.join(' | ')}`);
        assert.ok(row.violations.length > 0);
      } else {
        assert.deepEqual(row.violations, [], `${key} holds power (${row.power.join('; ')}) and runs something else`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(EXCEPTIONS).sort(), 'an exception that no longer applies must be taken out');
});

test('the build and the publish are different jobs: no build step holds the write token, and the publish step runs nothing from the repository', () => {
  for (const file of ['pr-build.yml', 'testing-app.yml']) {
    const rows = Object.fromEntries(readWorkflow(readFileSync(`.github/workflows/${file}`, 'utf8')).map((r) => [r.job, r]));
    for (const build of ['pack-mac', 'pack-win']) assert.deepEqual(rows[build].power, [], `${file} ${build} must hold no power`);
    assert.ok(rows.publish.power.length > 0, `${file} publish is the job with the token`);
    assert.deepEqual(rows.publish.violations, []);
    const text = readFileSync(`.github/workflows/${file}`, 'utf8');
  }
});

test('the publish job has no checkout and no setup, and the build jobs name read-only permissions', async () => {
  const { load } = await import('js-yaml');
  for (const file of ['pr-build.yml', 'testing-app.yml']) {
    const wf = load(readFileSync(`.github/workflows/${file}`, 'utf8'));
    const uses = (wf.jobs.publish.steps ?? []).map((s) => s.uses ?? '');
    assert.ok(uses.every((u) => /^actions\/download-artifact@/.test(u) || u === ''), `${file}: publish uses ${uses.join(', ')}`);
    assert.deepEqual(wf.jobs.publish.permissions, { contents: 'write' });
    assert.deepEqual(wf.permissions, { contents: 'read' }, 'the default is read-only');
    for (const build of ['pack-mac', 'pack-win']) {
      assert.deepEqual(wf.jobs[build].permissions, { contents: 'read' });
      assert.equal(wf.jobs[build].environment, undefined);
    }
    assert.deepEqual(wf.jobs.publish.needs, ['pack-mac', 'pack-win']);
  }
});

// ---- the checker itself fails on each violation (a test that cannot fail proves nothing)

const job = (steps, extra = '') => `
name: t
on: push
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    permissions:
      contents: write
${extra}
    steps:
${steps}
`;
const violations = (yml) => readWorkflow(yml)[0].violations;

test('FAILS: a build script called from a write job', () => {
  assert.match(violations(job('      - run: npm run dist:mac'))[0], /npm/);
  assert.match(violations(job('      - run: npm ci'))[0], /npm/);
  assert.match(violations(job('      - run: node scripts/build/build-editor.mjs'))[0], /not a file under scripts\/ci/);
  assert.match(violations(job('      - run: node scripts/nemeth-coverage.mjs'))[0], /not a file under scripts\/ci/);
  assert.match(violations(job('      - run: node -e "process.exit(0)"'))[0], /node runs -e/);
  assert.match(violations(job('      - run: npx tsc'))[0], /npx/);
});

test('FAILS: a repository file run another way', () => {
  for (const run of ['bash scripts/build/x.sh', './scripts/build/x.sh', 'sh x.sh', 'python tools/x.py', 'make build', 'electron .', 'source ./env.sh', '. ./env.sh']) {
    assert.ok(violations(job(`      - run: ${run}`)).length > 0, run);
  }
  assert.ok(violations(job('      - uses: ./.github/actions/local')).length > 0, 'a local action is a file of the repository');
  assert.ok(violations(job('      - shell: pwsh\n        run: gh release list')).length > 0, 'a shell this check cannot read');
});

test('FAILS: a build script hidden where a quick read would miss it', () => {
  assert.ok(violations(job('      - run: echo "$(npm run dist:mac)"')).length > 0, 'inside a substitution');
  assert.ok(violations(job('      - run: |\n          set -e\n          if true; then\n            npm test\n          fi')).length > 0, 'inside an if');
  assert.ok(violations(job('      - run: gh release list && npm ci')).length > 0, 'after &&');
  assert.ok(violations(job('      - run: gh release list | npm ci')).length > 0, 'after a pipe');
  assert.ok(violations(job('      - run: |\n          for x in a b; do\n            npm ci\n          done')).length > 0, 'inside a loop');
  assert.ok(violations(job('      - run: |\n          f() {\n            npm ci\n          }\n          f')).length > 0, 'inside a function');
  assert.ok(violations(job('      - run: FOO=1 npm ci')).length > 0, 'after an assignment');
  assert.ok(violations(job('      - run: |\n          case "$X" in\n            a) npm ci ;;\n          esac')).length > 0, 'inside a case');
});

test('PASSES: what a publish job and the shipper really run', () => {
  assert.deepEqual(violations(job('      - run: gh release upload "$TAG" builds/*.zip --clobber')), []);
  assert.deepEqual(violations(job('      - run: node scripts/ci/reply.mjs "$ISSUE" ready "$PR"')), []);
  assert.deepEqual(violations(job('      - run: node "$RUNNER_TEMP/trusted/scripts/ci/find-fix-pr.mjs" "$ISSUE"')), []);
  assert.deepEqual(violations(job('      - run: |\n          set -euo pipefail\n          NOTES=$(cat <<\'EOF\'\n          npm ci inside a heredoc is text\n          EOF\n          )\n          gh release edit t --notes "$NOTES"')), []);
  assert.deepEqual(violations(job('      - run: echo "Run npm ci to install" >> "$GITHUB_STEP_SUMMARY"')), [], 'a word inside a quoted string is not a command');
});

test('a job with no power is not held to the rule, and every way of getting power counts', () => {
  const read = `
name: t
on: push
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
`;
  assert.deepEqual(readWorkflow(read)[0].power, []);
  assert.deepEqual(readWorkflow(read)[0].violations, []);
  const power = (extra) => readWorkflow(read.replace('    runs-on: ubuntu-latest', `    runs-on: ubuntu-latest\n${extra}`))[0].power.length > 0;
  assert.ok(power('    permissions:\n      pull-requests: write'));
  assert.ok(power('    permissions: write-all'));
  assert.ok(power('    environment: pipeline'));
  assert.ok(power('    env:\n      T: ${{ secrets.SOMETHING }}'));
  assert.ok(!power('    env:\n      T: ${{ secrets.GITHUB_TOKEN }}'), 'the built-in token under read-only permissions is not power');
  const unstated = read.replace('permissions:\n  contents: read\n', '');
  assert.ok(readWorkflow(unstated)[0].power.length > 0, 'no permissions stated means the repository default, which is write');
  assert.ok(readWorkflow(unstated)[0].violations.length > 0);
});

test('commandsOf: quoted text, comments and heredocs are not commands; substitutions are', () => {
  assert.deepEqual(commandsOf('echo "npm ci"\n# npm ci\ncat <<\'X\'\nnpm ci\nX\ngh pr list').map((w) => w[0]), ['echo', 'cat', 'gh']);
  assert.deepEqual(commandsOf('x=$(npm ci)').map((w) => w[0]), ['npm']);
  assert.equal(whyNotAllowed(['node', 'scripts/ci/gh.mjs']), null);
  assert.match(whyNotAllowed(['node', 'scripts/ci/../../x.mjs']), /not a file under scripts\/ci/);
});
