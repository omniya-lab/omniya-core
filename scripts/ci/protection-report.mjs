/**
 * Which automation files are protected, and is that protection in the right place?
 *
 * Protection by file name has two faults. Sensitive code can sit in a file that is
 * not protected, and a harmless edit to a protected file still asks for the owner.
 * The rule this file serves: THE PROTECTED SET HOLDS ONLY SENSITIVE CODE, AND
 * SENSITIVE CODE LIVES ONLY IN THE PROTECTED SET. `protection.json` lists the
 * protected files and records how many sensitive lines each automation file holds
 * today. `protection-manifest.test.js` fails when a new sensitive line shows up in
 * a file that is not allowed to hold it, so the change cannot go in unnoticed.
 *
 * Usage:
 *   node scripts/ci/protection-report.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { matchesLine, SENSITIVE_LINES } from './ship-pipeline-pr.mjs';
import { filesOf, foldersOf, loadMap, zoneOf } from './zones.mjs';

/** The places the shipper reads line by line, as [directory, file name pattern]. */
export const AUTOMATION_DIRS = [
  ['.github/workflows', /\.ya?ml$/],
  ['scripts/ci', /\.(mjs|json)$/],
  ['.github/prompts', /\.md$/]
];

/** @returns {string[]} every automation file, as a repo-relative path */
export function automationFiles(root = '.') {
  return AUTOMATION_DIRS.flatMap(([dir, pattern]) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir)).filter((name) => pattern.test(name)).map((name) => `${dir}/${name}`)
      : []
  ).sort();
}

const COMMENT = /^\s*(#|\/\/|\*|\/\*)/;

/**
 * Code lines are the ones that are not blank and not a comment. A sensitive line is a
 * code line that matches one of the shipper's patterns.
 * @param {string} text
 * @returns {{code: number, sensitive: number}}
 */
export function measure(text) {
  const code = text.split('\n').filter((line) => line.trim() && !COMMENT.test(line));
  return { code: code.length, sensitive: code.filter((line) => SENSITIVE_LINES.some(([pattern]) => matchesLine(pattern, line))).length };
}

/** The sizes and the baseline from `protection.json`, and the lists from the one map, `zones.json`. */
export function loadManifest(root = '.') {
  const sizes = JSON.parse(readFileSync(join(root, 'scripts/ci/protection.json'), 'utf8'));
  const map = loadMap(join(root, 'scripts/ci/zones.json'));
  return { ...sizes, lock: filesOf('lock', map), shipIt: filesOf('shipIt', map), shipItPrefixes: foldersOf('shipIt', map) };
}

/** @returns {'lock'|'ship-it'|'free'} */
export function tierOf(file) {
  const { zone } = zoneOf(file);
  return zone === 'lock' ? 'lock' : zone === 'shipIt' ? 'ship-it' : 'free';
}

/** One row per automation file, the most sensitive first. */
export function report(root = '.') {
  const manifest = loadManifest(root);
  return automationFiles(root)
    .map((file) => ({ file, tier: tierOf(file), ...measure(readFileSync(join(root, file), 'utf8')) }))
    .sort((a, b) => b.sensitive - a.sensitive || a.file.localeCompare(b.file));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const rows = report();
  console.log('file'.padEnd(52), 'protected as'.padEnd(13), 'code'.padEnd(6), 'sensitive');
  for (const row of rows) console.log(row.file.padEnd(52), row.tier.padEnd(13), String(row.code).padEnd(6), row.sensitive);
  const leaks = rows.filter((row) => row.tier === 'free' && row.sensitive > 0);
  const empty = rows.filter((row) => row.tier !== 'free' && row.sensitive === 0);
  console.log(`\n${leaks.length} unprotected files hold sensitive lines. ${empty.length} protected files hold none.`);
}
