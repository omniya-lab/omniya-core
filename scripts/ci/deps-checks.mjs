/**
 * The static checks of the dependency gate (see `deps-gate.mjs`): what package.json, the lockfile and
 * electron-builder.yml may say, and whether a new audit report holds a new serious advisory. Pure functions over
 * text: nothing here reads a file, runs npm or touches the network. Allow lists, from parsed JSON and YAML.
 * This file is part of the lock.
 */

import { load } from 'js-yaml';

import { readFileSync } from 'node:fs';

import { plain } from './zones.mjs';

/** The exact files this gate judges. A path that only looks like one of these (other case, `./`) is judged too, and refused. */
export const CONFIG_FILES = ['package.json', 'package-lock.json', 'electron-builder.yml'];

/** Does this path name one of the config files, as a Mac would read it? */
export const isConfigPath = (file) => CONFIG_FILES.includes(plain(file ?? '').replace(/^(\.\/)+/, ''));

/** Does a pull request's file list touch the config files at all (also by an old name)? */
export const touchesConfig = (files) => files.some((f) => isConfigPath(f.filename) || isConfigPath(f.previous_filename));

export const REGISTRY_HOST = 'registry.npmjs.org';
const SHARED = new URL('./install-script-allowlist.json', import.meta.url);

/** package.json keys that may differ. Nothing else, and a new key is a difference. */
export const PACKAGE_KEYS = ['version', 'dependencies', 'devDependencies', 'optionalDependencies'];
export const DEPENDENCY_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const NUM = String.raw`(?:0|[1-9]\d*|[xX*])`;
const PARTIAL = String.raw`${NUM}(?:\.${NUM}(?:\.${NUM}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?)?`;
const COMPARATOR = String.raw`(?:\^|~|>=|<=|>|<|=)?\s*v?${PARTIAL}`;
const HYPHEN = String.raw`v?${PARTIAL}\s+-\s+v?${PARTIAL}`;
const SET = String.raw`(?:${HYPHEN}|${COMPARATOR}(?:\s+${COMPARATOR})*)`;
/** A plain semver range: a version, `^1.2.3`, `~1`, `>=1 <2`, `1.x`, `1 - 2`, `a || b`. Not a tag, URL, path, alias or git spec. */
export const PLAIN_RANGE = new RegExp(String.raw`^\s*${SET}(?:\s*\|\|\s*${SET})*\s*$`);

/** @returns {string|null} why this spec is not a plain semver range */
export function specProblem(name, spec) {
  if (typeof spec !== 'string') return `${name} has a version that is not text`;
  if (spec.length > 100) return `${clip(name)} has a version that is far too long`;
  if (/[\u0000-\u001f\u007f]/.test(spec)) return `${clip(name)} has a version with a control character in it`;
  if (!NAME.test(name)) return `${name} is not a plain package name`;
  if (/[:/\\@#]|^\s*$|\.tgz|\.tar/i.test(spec.replace(/\+[0-9A-Za-z.-]+/g, ''))) return `${name} is "${clip(spec)}", which is a link, a path, a tarball, an alias or a git address, not a version`;
  if (!PLAIN_RANGE.test(spec)) return `${name} is "${clip(spec)}", which is not a plain version range`;
  return null;
}

export const clip = (text, n = 60) => String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, n);
export const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parse(text, label) {
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) return { problem: `${label} is not a JSON object` };
    return { value };
  } catch {
    return { problem: `${label} is not valid JSON` };
  }
}


// ------------------------------------------------------------------ package.json

/**
 * @param {string} baseText package.json where the branch left `testing`
 * @param {string} headText package.json on the branch
 * @returns {string[]} one plain sentence per problem
 */
export function checkPackageJson(baseText, headText) {
  const base = parse(baseText, 'package.json (before)');
  const head = parse(headText, 'package.json');
  if (head.problem) return [head.problem];
  if (base.problem) return [base.problem];
  const problems = [];
  const keys = new Set([...Object.keys(base.value), ...Object.keys(head.value)]);
  for (const key of keys) {
    if (PACKAGE_KEYS.includes(key) || same(base.value[key], head.value[key])) continue;
    const added = !(key in base.value);
    const removed = !(key in head.value);
    problems.push(`package.json: the "${clip(key)}" setting was ${added ? 'added' : removed ? 'removed' : 'changed'}, and only the version and the dependency lists may change here${key === 'scripts' ? ' (a scripts change is code that CI runs, so it goes through the pipeline with a reading of the diff)' : ''}`);
  }
  for (const key of DEPENDENCY_KEYS) {
    const list = head.value[key];
    if (list === undefined) continue;
    if (!isObject(list)) {
      problems.push(`package.json: "${key}" is not a list of packages`);
      continue;
    }
    for (const [name, spec] of Object.entries(list)) {
      // Only what the branch changed is judged, so an old odd spec does not block an unrelated bump.
      if (base.value[key]?.[name] === spec) continue;
      const why = specProblem(name, spec);
      if (why) problems.push(`package.json: ${why}`);
    }
  }
  if (typeof head.value.version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(head.value.version)) {
    problems.push('package.json: the version is not a plain version number');
  }
  return problems;
}

// ------------------------------------------------------------------ the lockfile

/** @returns {{name: string, major: number}[]} */
export function readAllowList(url = SHARED) {
  const list = JSON.parse(readFileSync(url, 'utf8'));
  if (!Array.isArray(list.allowed)) throw new Error('install-script-allowlist.json has no list called allowed');
  for (const entry of list.allowed) {
    if (typeof entry.name !== 'string' || !Number.isInteger(entry.major)) throw new Error(`install-script-allowlist.json: bad entry ${JSON.stringify(entry)}`);
  }
  return list.allowed;
}

/** The package name of a lock key: the last `node_modules/` segment. */
export const nameOfKey = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
const majorOf = (version) => Number.parseInt(String(version).split('.')[0], 10);

/** The registry tarball address a package of this name and version must have. */
export function tarballFor(name, version) {
  const bare = name.includes('/') ? name.split('/')[1] : name;
  return `/${name}/-/${bare}-${version}.tgz`;
}

/** @returns {string|null} why this `resolved` address is not that package's tarball on the npm registry */
export function resolvedProblem(resolved, name, version) {
  // Exact: the address is written the one way npm writes it, so an encoded dot, a query or a user name cannot hide in it.
  if (resolved === `https://${REGISTRY_HOST}${tarballFor(name, version)}`) return null;
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return 'is not an address';
  }
  if (url.protocol !== 'https:' || url.hostname !== REGISTRY_HOST || url.port !== '' || url.username !== '' || url.password !== '') {
    return `comes from ${clip(url.protocol)}//${clip(url.hostname)}, not https://${REGISTRY_HOST}`;
  }
  return `is not the address ${REGISTRY_HOST} gives to ${clip(name)} ${clip(version)}`;
}

const INTEGRITY = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/**
 * @param {string} baseText package-lock.json where the branch left `testing`
 * @param {string} headText package-lock.json on the branch
 * @param {{name: string, major: number}[]} allowed
 * @returns {{problems: string[], base?: Record<string, object>, head?: Record<string, object>}}
 */
export function checkLockfile(baseText, headText, allowed) {
  const base = parse(baseText, 'package-lock.json (before)');
  const head = parse(headText, 'package-lock.json');
  if (head.problem) return { problems: [head.problem] };
  if (base.problem) return { problems: [base.problem] };
  const problems = [];
  if (head.value.lockfileVersion !== base.value.lockfileVersion || head.value.lockfileVersion !== 3) {
    problems.push(`package-lock.json: the lockfile version is ${clip(head.value.lockfileVersion)}, and only version 3 (as before) is accepted`);
  }
  if (!isObject(head.value.packages) || !isObject(base.value.packages)) {
    return { problems: [...problems, 'package-lock.json: it has no list of packages'] };
  }
  const was = base.value.packages;
  const now = head.value.packages;
  const seen = new Set();
  const note = (text) => {
    if (!seen.has(text) && seen.size < 12) problems.push(text);
    seen.add(text);
  };
  for (const [key, pkg] of Object.entries(now)) {
    if (key === '') continue;
    const before = was[key];
    if (!isObject(pkg) || !(key.startsWith('node_modules/') || key.includes('/node_modules/'))) {
      note(`package-lock.json: the entry "${clip(key)}" is not an installed package (a workspace or a local folder)`);
      continue;
    }
    const name = pkg.name === undefined ? nameOfKey(key) : pkg.name;
    if (pkg.name !== undefined && pkg.name !== nameOfKey(key)) note(`package-lock.json: ${clip(nameOfKey(key))} is an alias for ${clip(pkg.name)}`);
    if (pkg.link) note(`package-lock.json: ${clip(name)} is a link to a local folder`);
    if (typeof pkg.version !== 'string') {
      note(`package-lock.json: ${clip(name)} has no version`);
      continue;
    }
    const unchanged = isObject(before) && before.version === pkg.version;
    // A package that did not change keeps its address and hash. A bundled one has none, and may keep having none.
    if (unchanged && before.resolved === undefined && before.integrity === undefined && pkg.resolved === undefined && pkg.integrity === undefined && pkg.inBundle === true) {
      continue;
    }
    const bad = typeof pkg.resolved === 'string' ? resolvedProblem(pkg.resolved, name, pkg.version) : 'has no address';
    if (bad) note(`package-lock.json: ${clip(name)} ${clip(pkg.version)} ${bad}`);
    if (typeof pkg.integrity !== 'string' || !INTEGRITY.test(pkg.integrity)) note(`package-lock.json: ${clip(name)} ${clip(pkg.version)} has no integrity hash`);
    if (unchanged) {
      if (before.integrity !== pkg.integrity) note(`package-lock.json: ${clip(name)} ${clip(pkg.version)} kept its version but its integrity hash changed, so the package is not the one that was reviewed`);
      else if (before.resolved !== pkg.resolved) note(`package-lock.json: ${clip(name)} ${clip(pkg.version)} kept its version but its address changed`);
    }
    if (pkg.hasInstallScript) {
      const major = majorOf(pkg.version);
      const listed = allowed.some((entry) => entry.name === name && entry.major === major);
      const already = unchanged && before.hasInstallScript === true;
      if (!listed && !already) {
        note(`package-lock.json: ${clip(name)} ${clip(pkg.version)} has an install script, and it is not on the list of packages that may run one (a script there runs beside the agent's secrets)`);
      }
    } else if (unchanged && before.hasInstallScript === true) {
      // Losing a flag on the same version is odd and harmless, but it should not happen.
      note(`package-lock.json: ${clip(name)} ${clip(pkg.version)} lost its install-script flag with no new version`);
    }
  }
  return { problems, base: was, head: now };
}

// ------------------------------------------------------------------ electron-builder.yml

/** Settings of electron-builder.yml that may change. A change anywhere else is refused. */
export const BUILDER_ALLOWED = [
  'productName',
  'files',
  'asarUnpack',
  'mac.category',
  'mac.artifactName',
  'win.artifactName',
  'nsis.oneClick',
  'nsis.perMachine',
  'nsis.allowToChangeInstallationDirectory'
];

/** Every leaf of a parsed value as `a.b.c` (an array is one leaf, so its whole value is compared). */
function leaves(value, prefix = '', out = new Map()) {
  if (isObject(value)) {
    if (Object.keys(value).length === 0 && prefix) out.set(prefix, {});
    for (const [k, v] of Object.entries(value)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.set(prefix, value);
  return out;
}

const allowedSetting = (path) => BUILDER_ALLOWED.some((a) => path === a || path.startsWith(`${a}.`));

/** @returns {string[]} */
export function checkBuilderYml(baseText, headText) {
  let base;
  let head;
  try {
    base = load(baseText);
    head = load(headText);
  } catch {
    return ['electron-builder.yml: it is not valid YAML'];
  }
  if (!isObject(head) || !isObject(base)) return ['electron-builder.yml: it is not a list of settings'];
  const a = leaves(base);
  const b = leaves(head);
  const problems = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (same(a.get(path), b.get(path)) || allowedSetting(path)) continue;
    problems.push(`electron-builder.yml: the "${clip(path)}" setting changed, and it decides where the app updates from, what runs while it is built, or what the app is (only the product name, the file list and a few installer choices may change here)`);
    if (problems.length >= 6) break;
  }
  return problems;
}

// ------------------------------------------------------------------ audit

/**
 * The high and critical advisories of one `npm audit --json` report, by advisory.
 * @returns {Set<string>}
 */
export function advisoriesOf(report) {
  const found = new Set();
  const vulns = isObject(report?.vulnerabilities) ? report.vulnerabilities : {};
  for (const [name, v] of Object.entries(vulns)) {
    for (const via of Array.isArray(v?.via) ? v.via : []) {
      if (isObject(via) && (via.severity === 'high' || via.severity === 'critical')) {
        found.add(`${clip(via.name ?? name)}: ${clip(via.title ?? 'advisory')} (${clip(via.url ?? via.source ?? '?', 80)})`);
      }
    }
  }
  return found;
}

/**
 * @returns {{ok: true, added: string[], base: number, head: number}|{ok: false, why: string}} fails closed on a report that is not a report
 */
export function compareAudit(baseReport, headReport) {
  for (const [label, report] of [['before', baseReport], ['after', headReport]]) {
    if (!isObject(report) || report.error || !isObject(report.vulnerabilities)) {
      return { ok: false, why: `the audit report ${label} the change could not be read${report?.error ? ` (${clip(report.error.code ?? report.error.summary ?? 'error', 80)})` : ''}, so the check fails closed` };
    }
  }
  const before = advisoriesOf(baseReport);
  const after = advisoriesOf(headReport);
  return { ok: true, added: [...after].filter((a) => !before.has(a)).sort(), base: before.size, head: after.size };
}
