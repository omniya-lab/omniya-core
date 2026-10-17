/**
 * The dependency gate: automatic safety checks for a change to `package.json`, `package-lock.json`
 * or `electron-builder.yml`, in ANY lane. The owner's "ship it" is enough for such a change only when
 * every check here passes. The gate only ever makes shipping stricter.
 *
 * THE REAL RISK. `npm ci` runs in the agent job, which holds the pipeline's secrets. A new package with an
 * install script, or one fetched from a git URL or a tarball, would run code beside those secrets on the
 * next agent run. A `scripts` entry in package.json runs in CI and on the owner's Mac. A `publish` URL
 * in electron-builder.yml decides where the app updates itself from, and a hook there runs while building.
 *
 * Everything is an ALLOW list, read from parsed JSON or YAML, never from a line of text:
 *   package.json         only `version`, `dependencies`, `devDependencies`, `optionalDependencies` may differ,
 *                        and every spec must be a plain semver range.
 *   package-lock.json    every package comes from https://registry.npmjs.org/ under its own name and
 *                        version, carries an integrity hash, and gains no install script that is not on
 *                        `install-script-allowlist.json` (exact name and exact major version). An
 *                        unchanged version keeps its integrity. `npm ci --ignore-scripts` must succeed.
 *   electron-builder.yml only a short list of cosmetic settings may differ. Anything that decides where the
 *                        app updates from, what runs while building, or the app's identity is refused.
 *   npm audit            no new high or critical advisory in the runtime dependencies, against the base.
 *
 * WHERE IT RUNS. In a job with no secret and no environment (`pipeline-ship.yml`, job `deps`), from the
 * trusted copy of `testing`. The pull request's files are only DATA here: they are read with `git show`
 * into a scratch folder that holds nothing else, and `npm ci` runs there with `--ignore-scripts`, after the
 * static checks have passed, with a bare environment. The shipper reads the verdict from the job's output.
 *
 * WHAT IT CANNOT DO. It cannot tell a malicious but plain version of an allow-listed package from a good one,
 * and it cannot see a package that turns hostile later. Registry-hosted code that is not an install script
 * still runs when the app or a test imports it. A person reading the summary is the check for that.
 *
 * Usage:
 *   node scripts/ci/deps-gate.mjs check <sha>                    (the workflow; needs GH_TOKEN, GITHUB_REPOSITORY)
 *   node scripts/ci/deps-gate.mjs local <base-ref> <head-ref>    (a session, before it asks the owner)
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONFIG_FILES, checkBuilderYml, checkLockfile, checkPackageJson, clip, compareAudit, readAllowList, touchesConfig } from './deps-checks.mjs';
import { diffPackages, packageJsonLines, plural, shown, summaryLines } from './deps-summary.mjs';
import { modeRefusal, namesPull } from './product-lane.mjs';

export { CONFIG_FILES, touchesConfig };

// ------------------------------------------------------------------ the whole check

/**
 * Everything the gate decides, from file TEXT. `run` does the two things that need a machine: `npm ci` and `npm audit`.
 * @param {{package: [string, string], lock: [string, string], builder: [string|null, string|null], allowed: {name: string, major: number}[], touched: string[]}} input
 * @param {{ci: (dir: string) => void, audit: (dir: string) => object, files: (which: 'base'|'head') => string}} [machine] left out in tests of the static part
 * @returns {{result: 'pass'|'fail', problems: string[], summary: string[]}}
 */
export function judge({ package: pkg, lock, builder, allowed, touched }, machine = null) {
  const problems = [];
  let diff = null;
  let extra = {};
  const wants = (file) => touched.includes(file);
  if (wants('package.json')) {
    if (pkg[1] == null) problems.push('package.json: it was removed');
    else problems.push(...checkPackageJson(pkg[0], pkg[1]));
  }
  if (wants('package-lock.json')) {
    if (lock[1] == null) problems.push('package-lock.json: it was removed');
    else {
      const r = checkLockfile(lock[0], lock[1], allowed);
      problems.push(...r.problems);
      if (r.base && r.head) diff = diffPackages(r.base, r.head);
    }
  }
  if (wants('electron-builder.yml')) {
    if (builder[1] == null) problems.push('electron-builder.yml: it was removed');
    else {
      problems.push(...checkBuilderYml(builder[0] ?? '', builder[1]));
      extra.builder = true;
    }
  }
  // A changed dependency list with an unchanged lockfile cannot pass `npm ci`. (A lockfile alone may change: a transitive update.)
  if (wants('package.json') && !wants('package-lock.json') && pkg[1] != null && packageJsonLines(pkg[0], pkg[1]).lines.length > 0) {
    problems.push('package.json changed its dependencies but package-lock.json did not, so they cannot agree');
  }
  if (wants('package.json') && pkg[1] != null) {
    const p = packageJsonLines(pkg[0], pkg[1]);
    extra = { ...extra, packageJson: p.lines, versionChange: p.versionChange };
  }
  if (problems.length === 0 && machine && (wants('package.json') || wants('package-lock.json'))) {
    // Only now, with every static check passed, does anything run. `npm ci --ignore-scripts` in a folder that holds
    // the two package files and nothing else.
    try {
      machine.ci(machine.files('head'));
    } catch (error) {
      problems.push(`npm ci --ignore-scripts failed on the new files, so package.json and the lockfile do not agree${error?.hint ? ` (${clip(error.hint, 120)})` : ''}`);
    }
    if (problems.length === 0) {
      try {
        const verdict = compareAudit(machine.audit(machine.files('base')), machine.audit(machine.files('head')));
        if (!verdict.ok) problems.push(verdict.why);
        else {
          extra.audit = verdict;
          if (verdict.added.length > 0) problems.push(`npm audit finds ${plural(verdict.added.length, 'new high or critical advisory')} in the runtime packages: ${shown(verdict.added, String, 4)}`);
        }
      } catch (error) {
        problems.push(`npm audit could not run (${clip(error?.hint ?? error?.message ?? 'unknown', 120)}), so the check fails closed; run the shipper again`);
      }
    }
  }
  const summary = summaryLines(diff, extra);
  return { result: problems.length === 0 ? 'pass' : 'fail', problems, summary };
}

/** The text the shipper prints and the session pastes to the owner. One list, no markup. */
export function plainSummary({ result, problems, summary }) {
  return [
    'Dependency change, in plain words:',
    ...summary,
    result === 'pass' ? 'Every automatic safety check passed.' : `Not safe to ship: ${problems[0]}.`,
    ...(result === 'pass' ? [] : problems.slice(1, 4).map((p) => `Also: ${p}.`))
  ].join('\n');
}

// ------------------------------------------------------------------ the shipper's side

/**
 * The verdict of the job that ran the checks, as the shipper needs it. Anything but a pass stops a pull request that
 * touches a config file, in every lane.
 * @param {{result?: string, summary?: string}|null|undefined} deps
 * @returns {string|null} the plain reason, or null when the checks passed
 */
export function gateRefusal(deps) {
  const result = String(deps?.result ?? 'not-run');
  if (result === 'pass') return null;
  const text = String(deps?.summary ?? '').trim();
  const hint = result === 'not-applicable' ? 'it found no config file that differs, which does not fit this pull request' : result === 'error' || result === 'not-run' ? 'it did not finish, so nobody can tell whether the change is safe' : 'it found the change unsafe';
  return `the automatic dependency safety check says ${clip(result, 20)}, and ${hint}, so it is not shipped${text ? `.\n${text}` : ''}`;
}

/** The plain summary of a dependency change, whatever the verdict, in the log and the run summary, for the session to read to the owner. */
export function printSummary(env = process.env) {
  const summary = String(env.DEPS_SUMMARY ?? '').trim();
  if (!summary) return;
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

/**
 * The config lane: a pull request that changes package.json, package-lock.json or electron-builder.yml and nothing
 * else. It sits inside the `pipeline/` lane. The shared `decide` has already judged who wrote it, who pushed, the
 * head commit, conflicts and the complete file list, and has asked `gateRefusal`. This adds the file rule and the
 * owner's words.
 * @returns {{ship: true, tier: 'config', why: string[]} | {ship: false, reason: string}}
 */
export function configFileRefusal(files) {
  for (const file of files) {
    for (const name of [file.filename, file.previous_filename].filter((n) => n != null)) {
      if (!CONFIG_FILES.includes(name)) {
        return `${clip(name)} is not one of the config files (${CONFIG_FILES.join(', ')}), and a change that mixes it in is not shipped by a word: ship the config files alone`;
      }
    }
    if (file.status !== 'modified') return `${file.filename} was ${clip(file.status)}, and only an edit to a config file is shipped by a word`;
  }
  return null;
}

export function decideConfig({ files, modes, missing, number, ownerSaid, says, deps }) {
  const refusedFiles = configFileRefusal(files);
  if (refusedFiles) return { ship: false, reason: refusedFiles };
  const refusedMode = modeRefusal(files, modes);
  if (refusedMode) return { ship: false, reason: refusedMode };
  if (missing.length > 0) return { ship: false, reason: `not green on that commit: ${missing.join(', ')}` };
  if (!says || !namesPull(ownerSaid, number)) {
    return { ship: false, reason: `it needs the owner's "ship it" naming pull request ${number}. Read this to the owner first.\n${String(deps?.summary ?? '').trim()}` };
  }
  return { ship: true, tier: 'config', why: [`${files.length} config file(s), and every automatic dependency safety check passed`, ...String(deps?.summary ?? '').split('\n').filter(Boolean)] };
}

// ------------------------------------------------------------------ the machine (npm, git)

const BARE = (home) => ({ PATH: process.env.PATH ?? '', HOME: home, npm_config_cache: join(home, '.npm'), npm_config_update_notifier: 'false', npm_config_fund: 'false' });

function npm(args, cwd, home, { keepFailureOutput = false } = {}) {
  try {
    return execFileSync('npm', args, { cwd, env: BARE(home), encoding: 'utf8', timeout: 600_000, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // `npm audit` exits 1 when it finds something and still prints the report.
    if (keepFailureOutput && typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) return error.stdout;
    const e = new Error('npm failed');
    e.hint = String(error.stderr ?? error.message).split('\n').find((l) => /ERR|error/i.test(l)) ?? '';
    throw e;
  }
}

function realMachine(scratchRoot) {
  const home = mkdtempSync(join(scratchRoot, 'npm-home-'));
  return {
    files: (which) => join(scratchRoot, which),
    ci: (dir) => { npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], dir, home); },
    audit: (dir) => {
      const out = npm(['audit', '--omit=dev', '--audit-level=high', '--package-lock-only', '--json'], dir, home, { keepFailureOutput: true });
      try { return JSON.parse(out); } catch { return null; }
    }
  };
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** The file at a commit, or null when it did not exist there. */
function show(ref, path) {
  try {
    return git(['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * Judge the change from `baseRef` to `headRef` in the local git checkout.
 * @returns {{result: string, problems: string[], summary: string[], text: string}}
 */
export function checkRefs(baseRef, headRef, { machine = true } = {}) {
  const names = git(['diff', '--name-only', '-z', '--no-renames', baseRef, headRef, '--', ...CONFIG_FILES]).split('\0').filter(Boolean);
  if (names.length === 0) return { result: 'not-applicable', problems: [], summary: [], text: 'No config file differs.' };
  const text = (ref, f) => show(ref, f);
  const input = {
    package: [text(baseRef, 'package.json'), text(headRef, 'package.json')],
    lock: [text(baseRef, 'package-lock.json'), text(headRef, 'package-lock.json')],
    builder: [text(baseRef, 'electron-builder.yml'), text(headRef, 'electron-builder.yml')],
    // The list is read from the checkout the job runs from (`testing`), never from the pull request.
    allowed: readAllowList(),
    touched: names
  };
  let judged;
  if (machine) {
    const root = mkdtempSync(join(tmpdir(), 'deps-gate-'));
    for (const which of ['base', 'head']) {
      const dir = join(root, which);
      execFileSync('mkdir', ['-p', dir]);
      const [pj, lk] = which === 'base' ? [input.package[0], input.lock[0]] : [input.package[1], input.lock[1]];
      if (pj != null) writeFileSync(join(dir, 'package.json'), pj);
      if (lk != null) writeFileSync(join(dir, 'package-lock.json'), lk);
    }
    judged = judge(input, realMachine(root));
  } else judged = judge(input);
  return { ...judged, text: plainSummary(judged) };
}

/** One line per fact, safe for a job output: the characters are already printable ASCII. */
function writeOutputs(result, text) {
  if (process.env.GITHUB_OUTPUT) {
    const mark = `EOF_${Math.random().toString(36).slice(2)}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `result=${result}\nsummary<<${mark}\n${text.slice(0, 6000)}\n${mark}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\nSafety check result: ${result}\n`);
  console.log(`dependency gate: ${result}`);
  console.log(text);
}

function main() {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'local') {
    const r = checkRefs(a, b);
    console.log(`dependency gate: ${r.result}\n${r.text}`);
    process.exitCode = r.result === 'pass' || r.result === 'not-applicable' ? 0 : 1;
    return;
  }
  if (mode !== 'check') throw new Error('usage: deps-gate.mjs check <sha> | local <base-ref> <head-ref>');
  try {
    if (!/^[0-9a-f]{40}$/.test(a ?? '')) throw new Error(`sha must be 40 hex characters, got: ${a}`);
    const repo = process.env.GITHUB_REPOSITORY;
    const mergeBase = execFileSync('gh', ['api', `repos/${repo}/compare/testing...${a}`, '--jq', '.merge_base_commit.sha'], { encoding: 'utf8' }).trim();
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) throw new Error(`could not find where the branch left testing: ${mergeBase}`);
    git(['fetch', '--no-tags', '--depth=1', 'origin', mergeBase]);
    git(['fetch', '--no-tags', '--depth=1', 'origin', a]);
    const r = checkRefs(mergeBase, a);
    writeOutputs(r.result, r.text);
  } catch (error) {
    writeOutputs('error', `Dependency change, in plain words:\nThe safety check could not run: ${clip(error.message ?? error, 200)}.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
