/**
 * The gate for a pipeline change. A change ships only if this exits 0.
 *
 *   node scripts/lab/gate.mjs --diff change.diff   [--scenarios ask,design] [--fast]
 *   node scripts/lab/gate.mjs --branch my-branch   [--out gate-result.md] [--keep]
 *
 * What it does:
 *   1. clones lab `testing` into a temp directory and notes its commit
 *   2. applies the change (`git apply --3way` for a diff, `git merge` for a branch)
 *   3. runs the pipeline unit tests on the result; stops here if they fail
 *   4. makes sure the known bug is planted, so there is something to fix
 *   5. pushes the result to lab `testing` (rulesets are switched off for that push only)
 *      so the REAL jobs run: the agent and hand-off jobs only run from `testing`
 *   6. runs the robot scenarios against it, in parallel
 *   7. writes gate-result.md: pass or fail per scenario, with run URLs and timings
 *   8. puts lab `testing` back to the commit it had (unless --keep)
 *
 * Needs GH_TOKEN (lab admin), CONTRIB_GH_TOKEN, LAB_REPO. Lab only.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { isPlanted, plantBug, pushToTesting } from './lab-admin.mjs';
import { run } from './robot-contributor.mjs';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const repo = process.env.LAB_REPO || process.env.GITHUB_REPOSITORY;
const sh = (cwd, cmd, ...a) => execFileSync(cmd, a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fast = args.includes('--fast');
const outFile = resolve(opt('--out', 'gate-result.md'));
const scenarios = opt('--scenarios', 'ask,design').split(',');

function table(rows) {
  return ['| Scenario | Result | Seconds | Issue | Pull request |', '|---|---|---|---|---|', ...rows].join('\n');
}

async function main() {
  const diff = opt('--diff');
  const branch = opt('--branch');
  if (!repo || (!diff && !branch)) {
    console.error('usage: gate.mjs (--diff FILE | --branch NAME) [--scenarios ask,design,fix] [--fast] [--out FILE] [--keep]');
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const url = `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`;
  sh(dir, 'git', 'init', '-q');
  sh(dir, 'git', 'remote', 'add', 'origin', url);
  sh(dir, 'git', 'fetch', '-q', 'origin', 'testing');
  const original = sh(dir, 'git', 'rev-parse', 'FETCH_HEAD');
  sh(dir, 'git', 'checkout', '-q', '-B', 'gate', original);
  sh(dir, 'git', 'config', 'user.name', 'omniya-lab-agent');
  sh(dir, 'git', 'config', 'user.email', 'lab-agent@users.noreply.github.com');

  // The unit tests need js-yaml and friends. Reuse this checkout's modules instead of a slow install.
  if (existsSync(resolve('node_modules'))) symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));

  const notes = [];
  let failedBefore = null;
  try {
    if (diff) {
      sh(dir, 'git', 'apply', '--3way', '--index', resolve(diff));
      sh(dir, 'git', 'commit', '-qm', 'Pipeline change under test');
    } else {
      sh(dir, 'git', 'fetch', '-q', resolve('.'), branch);
      sh(dir, 'git', 'merge', '-q', '--no-edit', 'FETCH_HEAD');
    }
    notes.push(`Applied ${diff ? `diff ${diff}` : `branch ${branch}`} on lab testing ${original.slice(0, 7)}.`);
  } catch (err) {
    failedBefore = `The change does not apply to lab testing: ${String(err.stderr || err.message).slice(0, 400)}`;
  }

  if (!failedBefore) {
    try {
      sh(dir, 'node', '--test', ...execFileSync('git', ['ls-files', 'test/unit/pipeline'], { cwd: dir, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.test.js')));
      notes.push('Pipeline unit tests passed on the result.');
    } catch (err) {
      failedBefore = `Pipeline unit tests failed before any live run: ${String(err.stdout || err.message).split('\n').filter((l) => /^not ok|error:/.test(l)).slice(0, 6).join(' | ')}`;
    }
  }

  const results = [];
  if (!failedBefore) {
    if (!isPlanted(dir)) {
      await plantBug(repo); // pushes the plant to testing; fetch it so our push builds on it
      sh(dir, 'git', 'fetch', '-q', 'origin', 'testing');
      sh(dir, 'git', 'rebase', '-q', 'FETCH_HEAD');
      notes.push('Planted the lab bug first.');
    }
    const t0 = Date.now();
    await pushToTesting(repo, dir, 'HEAD', { force: true });
    notes.push(`Pushed ${sh(dir, 'git', 'rev-parse', '--short', 'HEAD')} to lab testing; scenarios started.`);
    // Give the push-triggered runs (keep-current and so on) a moment to settle. They do not gate the robot.
    const common = {
      author: process.env.CONTRIB_GH_TOKEN, other: process.env.GH_TOKEN, repo,
      timeoutMin: Number(opt('--timeout-min', 45)), pollS: Number(opt('--poll-s', 12)),
      nonAuthorWaitS: Number(opt('--non-author-wait-s', fast ? 45 : 150)), log: (l) => console.log(l)
    };
    const out = await Promise.all(scenarios.map((scenario) =>
      run({ ...common, scenario }).then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, scenario, error: e.message, ...(e.partial ?? {}) }))
    ));
    results.push(...out);
    notes.push(`All scenarios took ${Math.round((Date.now() - t0) / 1000)} s of wall time.`);
    if (!args.includes('--keep')) {
      await pushToTesting(repo, dir, original, { force: true });
      notes.push(`Put lab testing back on ${original.slice(0, 7)}.`);
    }
  }

  const pass = !failedBefore && results.length > 0 && results.every((r) => r.ok);
  const md = [
    `# Gate result: ${pass ? 'PASS' : 'FAIL'}`,
    '',
    ...notes.map((n) => `- ${n}`),
    ...(failedBefore ? ['', `**Stopped before any live run.** ${failedBefore}`] : []),
    '',
    ...(results.length ? [table(results.map((r) => `| ${r.scenario} | ${r.ok ? 'pass' : 'FAIL'} | ${r.seconds ?? '?'} | #${r.issue ?? '?'} | ${r.pr ? `#${r.pr}` : 'none'} |`))] : []),
    ...results.flatMap((r) => [
      '', `## ${r.scenario}: ${r.ok ? 'pass' : 'FAIL'}`, ...(r.ok ? [] : ['', `Reason: ${r.error}`]),
      '', 'Steps:', ...(r.steps ?? []).map(([s, t]) => `- +${s}s ${t}`),
      '', 'Live runs:', ...(r.runs ?? []).map((u) => `- ${u}`)
    ]),
    ''
  ].join('\n');
  writeFileSync(outFile, md);
  console.log(md);
  process.exit(pass ? 0 : 1);
}

await main();
