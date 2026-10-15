/**
 * Is the new lock at least as strict as the old one?
 *
 * The files that decide who may merge what used to need the owner's click in the browser. The
 * owner asked for no more clicks, because a click on a change the owner does not understand
 * proves only that the owner was there. This is what stands in its place, together with the
 * owner's words: the old rules and the new rules are loaded side by side and asked the same
 * thousands of made-up questions (`lock-corpus.mjs`). The new answer must refuse, or ask for,
 * at least as much as the old answer, every time. One case that gets looser fails the check.
 *
 * Who runs what:
 *   - The check runs in a job that has NO secrets and no environment, and the verdict goes to
 *     the shipping job only through that job's output.
 *   - The new code is untrusted. It is loaded only inside a child process with a bare
 *     environment (no tokens, no GITHUB_* variables), a time limit, and its working directory
 *     set to a scratch copy. The child prints the answers. THIS process, the trusted one from
 *     `testing`, compares them and writes the verdict, so the new code cannot write it.
 *
 * What it cannot do. A fixed set of questions catches a mistake: a pattern edited until it
 * matches nothing, a path dropped from a list. It cannot catch a backdoor written to answer
 * these questions correctly and others wrongly. And a change that loosens the lock on purpose
 * fails the check, by design. Only the owner can do that, with the repository's own bypass box.
 *
 * Usage:
 *   node scripts/ci/lock-differential.mjs check <commit-sha>   (the workflow; needs GH_TOKEN and GITHUB_REPOSITORY)
 *   node scripts/ci/lock-differential.mjs child <dir>          (internal: answers the questions for the code in <dir>)
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LINES, PHRASES, RANK, YAML_PAIRS, decideCases } from './lock-corpus.mjs';

const TIME_LIMIT_MS = 120_000;
const THIS_FILE = new URL(import.meta.url).pathname;

/** What the rules at `dir` answer to every question. Run only inside the child process. */
export async function answers(dir, paths) {
  const ship = await import(pathToFileURL(join(dir, 'scripts/ci/ship-pipeline-pr.mjs')).href);
  const diff = await import(pathToFileURL(join(dir, 'scripts/ci/workflow-diff.mjs')).href);
  const outcome = (input) => {
    try {
      const r = ship.decide(input);
      return r.ship ? r.tier : 'refuse';
    } catch {
      return 'refuse';
    }
  };
  const flagged = (fn) => {
    try {
      return Boolean(fn());
    } catch {
      // A rule that throws is a rule that refuses to say it is fine.
      return true;
    }
  };
  return {
    lists: {
      lock: ship.LOCK_FILES ?? ship.BYPASS_FILES ?? [],
      shipIt: ship.SHIP_IT_FILES ?? [],
      shipItPrefixes: ship.SHIP_IT_PREFIXES ?? [],
      allowedPrefixes: ship.ALLOWED_PREFIXES ?? []
    },
    decisions: decideCases({ paths }).map(({ id, input }) => [id, outcome(input)]),
    phrases: PHRASES.map((phrase) => {
      try {
        return Boolean(ship.saysShip(phrase));
      } catch {
        return false;
      }
    }),
    lines: LINES.map((line) => flagged(() => ship.sensitiveIn({ filename: '.github/workflows/pipeline-new.yml', status: 'modified', patch: `+${line}` }).length > 0)),
    yaml: YAML_PAIRS.map(({ base, head }) => flagged(() => diff.structuralChanges(base, head, ship.whyOfLine).length > 0))
  };
}

/**
 * Pure: is `head` at least as strict as `base`?
 * @returns {{ok: boolean, problems: string[]}}
 */
export function compare(base, head) {
  const problems = [];
  const includes = (name, wide, narrow) => {
    for (const item of narrow) if (!wide.includes(item)) problems.push(`${name}: the new rules no longer list ${item}`);
  };
  includes('the lock files', head.lists.lock, base.lists.lock);
  includes('the ship-it files', head.lists.shipIt, base.lists.shipIt);
  includes('the ship-it prefixes', head.lists.shipItPrefixes, base.lists.shipItPrefixes);
  // Fewer places a change may touch is stricter, never more.
  for (const item of head.lists.allowedPrefixes) if (!base.lists.allowedPrefixes.includes(item)) problems.push(`the allowed places grew: ${item}`);

  const headById = new Map(head.decisions);
  for (const [id, was] of base.decisions) {
    const now = headById.get(id) ?? 'refuse';
    if ((RANK[now] ?? 4) < (RANK[was] ?? 4)) problems.push(`looser: ${id} was ${was}, is ${now}`);
  }
  base.phrases.forEach((was, i) => { if (!was && head.phrases[i]) problems.push(`looser: the words ${JSON.stringify(PHRASES[i])} now count as ship`); });
  base.lines.forEach((was, i) => { if (was && !head.lines[i]) problems.push(`looser: the line ${JSON.stringify(LINES[i])} is no longer sensitive`); });
  base.yaml.forEach((was, i) => { if (was && !head.yaml[i]) problems.push(`looser: workflow pair ${i} is no longer flagged`); });
  if (head.decisions.length !== base.decisions.length) problems.push('the two versions were asked different questions');
  return { ok: problems.length === 0, problems };
}

/** Run the child for the code in `dir`, with nothing it could use: no tokens, no GITHUB_* variables, a time limit. */
export function runChild(dir, paths) {
  const out = execFileSync(process.execPath, [THIS_FILE, 'child', dir], {
    input: JSON.stringify({ paths }),
    env: { PATH: process.env.PATH ?? '' },
    cwd: dir,
    timeout: TIME_LIMIT_MS,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

/** The paths both versions protect, read as data (never run), so nothing either one protects goes unasked. */
export function protectedPaths(...dirs) {
  const paths = new Set();
  for (const dir of dirs) {
    const file = join(dir, 'scripts/ci/protection.json');
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, 'utf8'));
    for (const key of ['lock', 'tick', 'shipIt']) for (const p of m[key] ?? []) paths.add(p);
  }
  return [...paths].sort();
}

/** @returns {{ok: boolean, problems: string[]}} */
export function check(baseDir, headDir) {
  const paths = protectedPaths(baseDir, headDir);
  return compare(runChild(baseDir, paths), runChild(headDir, paths));
}

function git(args, { buffer = false } = {}) {
  return execFileSync('git', args, { encoding: buffer ? undefined : 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Put the files at `ref` into a scratch directory, with the dependencies of this checkout beside them. */
function extract(ref, dir) {
  const tar = git(['archive', '--format=tar', ref, 'scripts/ci', 'package.json'], { buffer: true });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  if (existsSync('node_modules')) symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'child') {
    const { paths } = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(await answers(arg, paths)));
    return;
  }
  if (mode !== 'check') throw new Error('usage: lock-differential.mjs check <sha> | child <dir>');

  const sha = arg ?? '';
  const out = (result, lines) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `result=${result}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Strictness check: ${result}\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
    console.log(`strictness check: ${result}`);
    for (const line of lines.slice(0, 20)) console.log(`  ${line}`);
  };
  try {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`sha must be 40 hex characters, got: ${sha}`);
    const repo = process.env.GITHUB_REPOSITORY;
    const mergeBase = execFileSync('gh', ['api', `repos/${repo}/compare/testing...${sha}`, '--jq', '.merge_base_commit.sha'], { encoding: 'utf8' }).trim();
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) throw new Error(`could not find where the branch left testing: ${mergeBase}`);

    git(['fetch', '--no-tags', '--depth=1', 'origin', mergeBase]);
    git(['fetch', '--no-tags', '--depth=1', 'origin', sha]);
    const base = mkdtempSync(join(tmpdir(), 'lock-base-'));
    const head = mkdtempSync(join(tmpdir(), 'lock-head-'));
    extract(mergeBase, base);
    extract(sha, head);

    // Nothing to compare when no file of the lock differs between the two. A file that is missing on one side counts as differing.
    const blob = (ref, path) => {
      try {
        return git(['rev-parse', '--verify', '--quiet', `${ref}:${path}`]).trim();
      } catch {
        return '';
      }
    };
    const lockPaths = JSON.parse(readFileSync(join(base, 'scripts/ci/protection.json'), 'utf8')).lock ?? [];
    if (lockPaths.every((p) => blob(mergeBase, p) === blob(sha, p) && blob(sha, p) !== '')) {
      out('same', ['no file of the lock differs between where the branch left testing and its head']);
      return;
    }
    const result = check(base, head);
    out(result.ok ? 'pass' : 'fail', result.problems);
  } catch (error) {
    out('error', [String(error.message ?? error)]);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
