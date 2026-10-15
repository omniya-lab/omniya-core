/**
 * The product lane of the shipper: the owner says "ship it" about a change to the
 * app, and it merges. No click in the browser.
 *
 * The shipper (`ship-pipeline-pr.mjs`) used to take `pipeline/` branches only, so an
 * app change written in a chat session could not be shipped, and the owner had to
 * click Merge. This file decides one thing: is every file of a `product/` pull
 * request inside the PRODUCT ZONE? Everything before this (open, into `testing`,
 * same repository, owner or session account as author, nobody else pushed, head is
 * the commit the caller named, whole file list seen, mergeable) is decided by
 * `decide` in the shipper, once, for both lanes. Merging is the shipper's code too.
 *
 * THE PRODUCT ZONE is an allow list of paths. Nothing else.
 *   allowed   src/**   test/**   docs/**
 *   refused   test/corpus/**  (the grading data)  and  test/unit/pipeline/**  (tests of this pipeline)
 *   refused   everything else: package.json, the lockfile, electron-builder.yml, scripts/**,
 *             .github/**, .claude/**, CODEOWNERS, CLAUDE.md, any dotfile, any other top-level file
 *
 * Why the branch must be `product/<slug>` and not `claude/<slug>`: the agent that
 * fixes a contributor's issue names its branches `claude/...`, and a contributor's
 * words steer it. A `claude/` name is therefore not proof of who wrote the branch. The
 * name does not carry the trust (the author and the push history do), but it keeps
 * the two lanes apart: a contributor fix can never be shipped by a session's word.
 * The session pushes its work as `product/<slug>`.
 *
 * Beyond the zone, a pull request is refused for: a symlink, an executable bit, or a
 * submodule (git file mode other than 100644, before or after); a name that changed
 * from outside the zone; a path with a character outside letters, digits and `._-/`,
 * so no `..`, backslash, space, colon, `~` or non-ASCII look-alike; a segment that starts
 * or ends with a dot; a deleted or moved test; a test that loses more lines than it
 * gains; modes that cannot be read; checks not green; and no "ship it" naming this PR.
 * The zone is compared in lower case for the two exclusions, so `test/Corpus/x` on a
 * Mac, which is `test/corpus/x`, is refused.
 *
 * This file and its test are part of the lock: changing the zone changes who may
 * ship what, so a product pull request cannot reach it (`scripts/` is outside the zone).
 */

import { gh as realGh } from './gh.mjs';
import { plain, zoneOf } from './zones.mjs';

export const PRODUCT_PREFIX = 'product/';

const MAX_PATH = 240;
const SAFE_CHARS = /^[A-Za-z0-9._\-/]+$/;
const STATUSES = ['added', 'modified', 'removed', 'renamed', 'copied'];

/**
 * @param {unknown} path
 * @returns {string|null} why this path is outside the product zone, or null when it is inside
 */
export function outsideZone(path) {
  const p = typeof path === 'string' ? path : '';
  if (!p || p.length > MAX_PATH) return 'is empty or too long';
  if (!SAFE_CHARS.test(p)) return 'has a character other than letters, digits and . _ - /';
  const parts = p.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return 'has an empty, dot or dot-dot part';
  // A dot part is refused unless the map names that very file (`.gitignore`).
  const { zone, pattern } = zoneOf(p);
  if (parts.some((part) => part.startsWith('.') || part.endsWith('.')) && plain(pattern ?? '') !== plain(p)) return 'is a dotfile or ends in a dot';
  if (zone === 'automatic') return null;
  if (zone === 'goalposts') return 'is the grading data or its gate, which a word does not ship';
  if (zone === 'owner') return 'is in no zone the map knows, so it is the owner\'s';
  return 'runs with power or decides who may merge, so it needs a ship-it of its own kind';
}

/** Does the text name this pull request number, as a whole number? "106" is in "PR 106" and "#106", not in "1060". */
export const namesPull = (said, number) =>
  new RegExp(`(^|[^0-9])${String(number).replace(/[^0-9]/g, '')}($|[^0-9])`).test(String(said ?? ''));

/**
 * @param {object} input
 * @param {Array<{filename: string, previous_filename?: string|null, status?: string, additions?: number, deletions?: number}>} input.files
 * @param {{head: Record<string,string>, base: Record<string,string>}|null} input.modes git file modes by path, null when unreadable
 * @param {string[]} input.missing required checks that are not green
 * @param {number|string} input.number the pull request number
 * @param {string} input.ownerSaid the owner's own words
 * @param {boolean} input.says whether those words say "ship it" (the shipper's own phrase checker)
 * @returns {{ship: true, tier: 'product', why: string[]} | {ship: false, reason: string}}
 */
export function decideProduct({ files, modes, missing, number, ownerSaid, says }) {
  if (!Array.isArray(files) || files.length === 0) return { ship: false, reason: 'it changes no files' };
  for (const file of files) {
    if (!STATUSES.includes(file.status)) return { ship: false, reason: `${file.filename} has a change kind this lane does not know (${file.status})` };
    for (const name of [file.filename, file.previous_filename].filter((n) => n != null)) {
      const why = outsideZone(name);
      if (why) return { ship: false, reason: `${name} ${why}, so it is not shipped by a word` };
    }
    const wasTest = String(file.previous_filename ?? '').startsWith('test/');
    const isTest = file.filename.startsWith('test/');
    if ((file.status === 'removed' && isTest) || (wasTest && !isTest)) {
      return { ship: false, reason: `it deletes or moves a test (${file.previous_filename ?? file.filename}), so it is not shipped by a word` };
    }
    if (isTest && Number(file.deletions ?? 0) > Number(file.additions ?? 0)) {
      return { ship: false, reason: `${file.filename} loses more lines than it gains, so it is not shipped by a word` };
    }
  }
  if (!modes || !modes.head || !modes.base) return { ship: false, reason: 'the file modes could not be read, so a symlink could be hidden' };
  for (const file of files) {
    const before = file.previous_filename ?? file.filename;
    const after = file.status === 'removed' ? undefined : modes.head[file.filename];
    const was = file.status === 'added' ? undefined : modes.base[before];
    if (file.status !== 'removed' && after !== '100644') return { ship: false, reason: `${file.filename} is a symlink, an executable or not a plain file (mode ${after}), so it is not shipped by a word` };
    if (file.status !== 'added' && was !== '100644') return { ship: false, reason: `${before} was not a plain file before this change (mode ${was}), so it is not shipped by a word` };
  }
  if (missing.length > 0) return { ship: false, reason: `not green on that commit: ${missing.join(', ')}` };
  if (!says || !namesPull(ownerSaid, number)) {
    return { ship: false, reason: `it needs the owner's "ship it" naming pull request ${number}` };
  }
  return { ship: true, tier: 'product', why: [`${files.length} file(s), all in the automatic zone`] };
}

/**
 * The git mode of every path, at the head and at the commit the branch left `testing` from.
 * @returns {{head: Record<string,string>, base: Record<string,string>}|null} null when anything cannot be read in full
 */
export function readModes({ repo, sha, gh = realGh }) {
  try {
    const tree = (commit) => {
      const treeSha = gh(['api', `repos/${repo}/git/commits/${commit}`, '--jq', '.tree.sha']).trim();
      const out = JSON.parse(
        gh(['api', '--method', 'GET', `repos/${repo}/git/trees/${treeSha}`, '-f', 'recursive=1', '--jq', '{truncated, entries: [.tree[] | {path, mode}]}'])
      );
      if (out.truncated !== false) throw new Error('tree is truncated');
      return Object.fromEntries(out.entries.map((e) => [e.path, e.mode]));
    };
    const mergeBase = gh(['api', '--method', 'GET', `repos/${repo}/compare/testing...${sha}`, '-f', 'per_page=1', '--jq', '.merge_base_commit.sha']).trim();
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) throw new Error('no merge base');
    return { head: tree(sha), base: tree(mergeBase) };
  } catch {
    return null;
  }
}
