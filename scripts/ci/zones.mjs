/**
 * The one map from a path to what it takes to change it. Path only: nothing here
 * reads a line of a file.
 *
 * Zones, from `zones.json`:
 *   automatic  reversible, and never run by a job that holds power. A contributor's fix
 *              merges by itself, and the owner's "ship it" merges a product change.
 *   shipIt     runs with power, or decides what is trusted. Needs the owner's "ship it".
 *   goalposts  defines what counts as correct. Never shipped by a word.
 *   lock       decides who may merge what. "ship it" plus the strictness check.
 *   owner      every path in no zone. The default is deny.
 *
 * Read by `hand-off.mjs` (a contributor's fix), by `product-lane.mjs` and
 * `ship-pipeline-pr.mjs` (the shipper), and by `protection-report.mjs`. A zone is
 * changed in `zones.json`, which is itself in the lock.
 */

import { readFileSync } from 'node:fs';

export const ZONES = ['automatic', 'shipIt', 'goalposts', 'lock'];

/** What a change needs, weakest first. */
export const NEEDS = ['nothing', 'ship-it', 'owner', 'lock'];
const NEED_OF = { automatic: 'nothing', shipIt: 'ship-it', goalposts: 'owner', lock: 'lock', owner: 'owner' };

/** The one plain form a path is compared in: composed Unicode, lower case. */
export const plain = (file) => String(file).normalize('NFKC').toLowerCase();

const MAP_URL = new URL('./zones.json', import.meta.url);

/** @returns {Record<string, string[]>} the zone lists. Never falls back to an empty map. */
export function loadMap(url = MAP_URL) {
  const map = JSON.parse(readFileSync(url, 'utf8'));
  for (const zone of ZONES) {
    if (!Array.isArray(map[zone]) || map[zone].length === 0) throw new Error(`zones.json has no list called ${zone}`);
  }
  return map;
}

/** How specific a pattern is: more folders first, then a file before a folder. */
function parse(pattern) {
  const p = plain(pattern);
  const dir = p.endsWith('/**');
  const base = dir ? p.slice(0, -3) : p;
  if (!base || base.startsWith('/') || base.includes('*') || base.includes('..')) throw new Error(`zones.json: bad pattern ${pattern}`);
  const written = String(pattern).normalize('NFKC');
  return { dir, base, written: dir ? written.slice(0, -3) : written, weight: base.split('/').length * 2 + (dir ? 0 : 1) };
}

/** Every pattern of the map, with its zone. Throws when one pattern is in two zones. */
export function compile(map = loadMap()) {
  const seen = new Map();
  const rules = [];
  for (const zone of ZONES) {
    for (const pattern of map[zone]) {
      const rule = { zone, pattern, ...parse(pattern) };
      const key = `${rule.dir ? 'dir' : 'file'}:${rule.base}`;
      if (seen.has(key) && seen.get(key) !== zone) throw new Error(`zones.json: ${pattern} is in both ${seen.get(key)} and ${zone}`);
      seen.set(key, zone);
      rules.push(rule);
    }
  }
  return rules;
}

const RULES = compile();

/** A path this pipeline never makes. It is OWNER, whatever it looks like. */
const odd = (p) => !p || p.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(p) || p.split('/').some((part) => part === '' || part === '.' || part === '..');

/**
 * @param {string} file a path as GitHub gives it
 * @param {ReturnType<typeof compile>} [rules]
 * @returns {{zone: 'automatic'|'shipIt'|'goalposts'|'lock'|'owner', pattern: string|null}}
 */
export function zoneOf(file, rules = RULES) {
  const p = plain(file);
  if (odd(p)) return { zone: 'owner', pattern: null };
  let best = null;
  for (const rule of rules) {
    const hit = rule.dir ? p.startsWith(`${rule.base}/`) : p === rule.base;
    if (!hit) continue;
    if (!best || rule.weight > best.weight) best = rule;
    // Two zones at the same weight is an error `compile` and the tests refuse. If it still
    // happens, the stricter zone wins.
    else if (rule.weight === best.weight && NEEDS.indexOf(NEED_OF[rule.zone]) > NEEDS.indexOf(NEED_OF[best.zone])) best = rule;
  }
  if (!best) return { zone: 'owner', pattern: null };
  // The deny zones match in lower case, so `test/Corpus` cannot slip past `test/corpus`. AUTOMATIC does
  // not: `Src/a.js` is a different path on Linux, and a path that only looks like a safe one is the owner's.
  if (best.zone === 'automatic') {
    const exact = String(file).normalize('NFKC');
    if (!(best.dir ? exact.startsWith(`${best.written}/`) : exact === best.written)) return { zone: 'owner', pattern: null };
  }
  return { zone: best.zone, pattern: best.pattern };
}

/**
 * What it takes to change all of these. The strongest need wins.
 * @param {string[]} files
 * @returns {{needs: 'nothing'|'ship-it'|'owner'|'lock', by: Array<{file: string, zone: string}>}}
 */
export function needsFor(files, rules = RULES) {
  let level = 0;
  const by = [];
  for (const file of files) {
    const { zone } = zoneOf(file, rules);
    const need = NEEDS.indexOf(NEED_OF[zone]);
    if (need > level) level = need;
    if (need > 0) by.push({ file, zone });
  }
  return { needs: NEEDS[level], by };
}

/** The files of a pull request that are not AUTOMATIC. Empty means a contributor's fix may merge by itself. */
export const outsideAutomatic = (files) => files.filter((file) => zoneOf(file).zone !== 'automatic');

/** The exact files of a zone (no folders): what the size and baseline checks walk. */
export const filesOf = (zone, map = loadMap()) => map[zone].filter((p) => !p.endsWith('/**'));

/** The folders of a zone, as prefixes with a trailing slash. */
export const foldersOf = (zone, map = loadMap()) => map[zone].filter((p) => p.endsWith('/**')).map((p) => p.slice(0, -2));
