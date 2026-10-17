/**
 * The plain summary of a dependency change (see `deps-gate.mjs`): what was added, removed and updated, in short
 * sentences that read aloud well. Electron gets its own line. Output only: it decides nothing.
 * This file is part of the lock, so a ship-it cannot quietly make a change look smaller than it is.
 */

import { clip, nameOfKey, DEPENDENCY_KEYS, parse } from './deps-checks.mjs';

// ------------------------------------------------------------------ the plain summary

/**
 * What changed between two lock files, by package.
 * @returns {{added: object[], removed: object[], updated: object[], electron: {from: string, to: string}|null, before: number, after: number, scripts: object[]}}
 */
export function diffPackages(basePackages, headPackages) {
  const entry = (key, pkg) => ({ key, name: pkg.name ?? nameOfKey(key), version: String(pkg.version ?? '?'), script: pkg.hasInstallScript === true });
  const list = (packages) => Object.entries(packages).filter(([k]) => k !== '').map(([k, p]) => entry(k, p));
  const was = new Map(list(basePackages).map((e) => [e.key, e]));
  const now = new Map(list(headPackages).map((e) => [e.key, e]));
  const added = [];
  const removed = [];
  const updated = [];
  for (const [key, e] of now) {
    const w = was.get(key);
    if (!w) added.push(e);
    else if (w.version !== e.version) updated.push({ ...e, from: w.version });
  }
  for (const [key, e] of was) if (!now.has(key)) removed.push(e);
  const byName = (x, y) => x.name.localeCompare(y.name) || x.version.localeCompare(y.version);
  const electronKey = 'node_modules/electron';
  const e0 = was.get(electronKey)?.version;
  const e1 = now.get(electronKey)?.version;
  return {
    added: added.sort(byName),
    removed: removed.sort(byName),
    updated: updated.sort(byName),
    electron: e0 && e1 && e0 !== e1 ? { from: e0, to: e1 } : null,
    before: was.size,
    after: now.size,
    scripts: added.filter((e) => e.script).sort(byName)
  };
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const shown = (items, fmt, max = 12) => {
  const unique = [...new Set(items.map(fmt))];
  return unique.length <= max ? unique.join(', ') : `${unique.slice(0, max).join(', ')}, and ${unique.length - max} more`;
};

/**
 * The summary a person reads in ten seconds. Short sentences, no markup, safe to read aloud.
 * @param {ReturnType<typeof diffPackages>|null} diff
 * @param {{audit?: {added: string[], base: number, head: number}|null, versionChange?: {from: string, to: string}|null, builder?: boolean, packageJson?: string[]}} [extra]
 * @returns {string[]}
 */
export function summaryLines(diff, extra = {}) {
  const lines = [];
  if (diff?.electron) lines.push(`Electron ${diff.electron.from} to ${diff.electron.to}. This changes the browser engine inside the app.`);
  if (diff) {
    const verb = (list, word, fmt) => (list.length === 0 ? `No packages ${word}.` : `${plural(list.length, 'package')} ${word}: ${shown(list, fmt)}.`);
    lines.push(verb(diff.added, 'added', (e) => `${e.name} ${e.version} (install script: ${e.script ? 'yes' : 'no'})`));
    lines.push(verb(diff.removed, 'removed', (e) => `${e.name} ${e.version}`));
    lines.push(verb(diff.updated, 'updated', (e) => `${e.name} ${e.from} to ${e.version}${e.script ? ' (install script: yes)' : ''}`));
    lines.push(`Packages in total: ${diff.before} before, ${diff.after} after.`);
    lines.push(diff.scripts.length === 0 ? 'No new package runs an install script.' : `New install scripts: ${shown(diff.scripts, (e) => `${e.name} ${e.version}`)}.`);
  } else {
    lines.push('The lockfile did not change.');
  }
  for (const text of extra.packageJson ?? []) lines.push(text);
  if (extra.versionChange) lines.push(`The app version goes from ${extra.versionChange.from} to ${extra.versionChange.to}.`);
  if (extra.builder) lines.push('electron-builder.yml changes (cosmetic settings only).');
  if (extra.audit) {
    lines.push(extra.audit.added.length === 0
      ? `Audit: no new high or critical advisory in the runtime packages (${extra.audit.base} before, ${extra.audit.head} after).`
      : `Audit: ${plural(extra.audit.added.length, 'new high or critical advisory')} in the runtime packages: ${shown(extra.audit.added, String, 6)}.`);
  }
  return lines.map((l) => l.replace(/[^\x20-\x7e]/g, '?'));
}

/** package.json differences a person cares about, in words: which packages moved in the three lists. */
export function packageJsonLines(baseText, headText) {
  const base = parse(baseText, '').value;
  const head = parse(headText, '').value;
  if (!base || !head) return { lines: [], versionChange: null };
  const lines = [];
  for (const key of DEPENDENCY_KEYS) {
    const a = base[key] ?? {};
    const b = head[key] ?? {};
    const moves = [];
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[name] === b[name]) continue;
      moves.push(a[name] === undefined ? `${clip(name)} ${clip(b[name])} added` : b[name] === undefined ? `${clip(name)} removed` : `${clip(name)} ${clip(a[name])} to ${clip(b[name])}`);
    }
    if (moves.length) lines.push(`package.json ${key}: ${shown(moves, String, 8)}.`);
  }
  const versionChange = base.version !== head.version ? { from: clip(base.version), to: clip(head.version) } : null;
  return { lines, versionChange };
}
