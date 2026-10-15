/**
 * Read a workflow as YAML, before and after a change, and say what it newly grants.
 *
 * The shipper's line patterns read TEXT. GitHub reads YAML. Every gap between the two has
 * been a way past the patterns: a quoted key, an alias, an anchor, a merge key. Patching them
 * one at a time never ends. Here the workflow is parsed with a real YAML parser, which has
 * already resolved the quotes, the aliases and the merge keys, and each setting is turned
 * into one plain line, `path: value`, such as
 *
 *     jobs.ship.permissions.contents: write
 *     jobs.ship.steps.[].with.private-key: ${{ secrets.PIPELINE_APP_PRIVATE_KEY }}
 *
 * The shipper's patterns are then asked about those lines. A setting counts as changed when
 * the number of times it occurs differs between the file as it was and the file as it will
 * be, so a reordered step is not a change and a moved guard is. A workflow that cannot be
 * read as YAML, before or after, counts as changed: what cannot be read cannot be trusted.
 *
 * This takes `whyOf` as an argument instead of importing the patterns, so there is no
 * circular import. `whyOf(line)` returns the reasons a line is sensitive, or an empty list.
 */

import { load } from 'js-yaml';

/** @returns {Array<{path: string, value: string}>} every setting in the file, one plain line each */
export function leaves(text) {
  const doc = load(String(text));
  const out = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') {
      out.push({ path: path.join('.'), value: String(node) });
    } else if (Array.isArray(node)) {
      // The place in a list is not a setting: moving a step is not a change to what it grants.
      node.forEach((item) => walk(item, [...path, '[]']));
    } else {
      for (const [key, value] of Object.entries(node)) walk(value, [...path, String(key)]);
    }
  };
  walk(doc, []);
  return out;
}

/** Where a `permissions` key sits. Taking one away widens the job to the default. */
export function permissionBlocks(text) {
  const doc = load(String(text));
  const found = new Set();
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((item) => walk(item, [...path, '[]']));
    for (const [key, value] of Object.entries(node)) {
      if (key === 'permissions') found.add([...path, key].join('.'));
      walk(value, [...path, String(key)]);
    }
  };
  walk(doc, []);
  return found;
}

/** @returns {Map<string, {n: number, why: string[], path: string}>} the sensitive settings, counted */
export function sensitiveSettings(text, whyOf) {
  const counted = new Map();
  for (const { path, value } of leaves(text)) {
    const why = whyOf(`${path}: ${value}`);
    if (why.length === 0) continue;
    const key = `${path}\u0000${value}`;
    const entry = counted.get(key) ?? { n: 0, why, path };
    entry.n += 1;
    counted.set(key, entry);
  }
  return counted;
}

/**
 * @param {string|null} baseText the file as it was, or null when it is new
 * @param {string|null} headText the file as it will be, or null when it is removed
 * @param {(line: string) => string[]} whyOf
 * @returns {string[]} plain reasons, empty when nothing sensitive changed
 */
export function structuralChanges(baseText, headText, whyOf) {
  let base;
  let head;
  let basePermissions;
  let headPermissions;
  try {
    base = baseText == null ? new Map() : sensitiveSettings(baseText, whyOf);
    head = headText == null ? new Map() : sensitiveSettings(headText, whyOf);
    basePermissions = baseText == null ? new Set() : permissionBlocks(baseText);
    headPermissions = headText == null ? new Set() : permissionBlocks(headText);
  } catch {
    return ['a workflow that cannot be read as YAML'];
  }
  const reasons = new Set();
  for (const [key, entry] of head) {
    if ((base.get(key)?.n ?? 0) !== entry.n) for (const why of entry.why) reasons.add(`${why} (${entry.path})`);
  }
  for (const [key, entry] of base) {
    if (!head.has(key)) for (const why of entry.why) reasons.add(`${why}, taken away (${entry.path})`);
  }
  // A workflow that is removed takes its permissions with it, and that is not widening anything.
  if (headText != null) {
    for (const path of basePermissions) if (!headPermissions.has(path)) reasons.add(`a permissions block taken away (${path})`);
  }
  return [...reasons];
}
