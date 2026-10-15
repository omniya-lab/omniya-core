/**
 * Lab only. Proves the shipper's PRODUCT LANE live, in the lab repo, with the lab's own
 * rulesets, environment `pipeline` and App. Never port.
 *
 *   node scripts/lab/product-live.mjs prepare        put lab `testing` = lab testing + lab/product-lane (rulesets off for that push)
 *   node scripts/lab/product-live.mjs open-happy     open the product/ pull request that should merge
 *   node scripts/lab/product-live.mjs refusals       open and dispatch every refusal case
 *   node scripts/lab/product-live.mjs happy          refuse it twice (no words, wrong actor), then ship it for real
 *   node scripts/lab/product-live.mjs restore        put lab `testing` back where `prepare` found it
 *
 * State is in /tmp/product-live.json. The results table is in /tmp/product-live-results.md.
 * GH_TOKEN is the lab bot (also the lab owner). CONTRIB_GH_TOKEN is a plain account with write access.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { withRulesetsOff } from './lab-admin.mjs';

const repo = process.env.LAB_REPO;
const BOT = process.env.GH_TOKEN;
const CONTRIB = process.env.CONTRIB_GH_TOKEN;
const STATE = '/tmp/product-live.json';
const RESULTS = '/tmp/product-live-results.md';
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const sh = (cwd, cmd, ...a) => execFileSync(cmd, a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gh = (token, ...a) => execFileSync('gh', a, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, maxBuffer: 1 << 26 }).trim();
const url = (token) => `https://x-access-token:${token}@github.com/${repo}.git`;

function clone(token, ref = 'testing') {
  const dir = mkdtempSync(join(tmpdir(), 'pl-'));
  sh(dir, 'git', 'init', '-q');
  sh(dir, 'git', 'remote', 'add', 'origin', url(token));
  sh(dir, 'git', 'fetch', '-q', '--depth', '50', 'origin', ref);
  sh(dir, 'git', 'checkout', '-q', '-B', 'work', 'FETCH_HEAD');
  sh(dir, 'git', 'config', 'user.name', 'lab-agent');
  sh(dir, 'git', 'config', 'user.email', 'lab-agent@users.noreply.github.com');
  return dir;
}

async function prepare() {
  const dir = clone(BOT);
  state.original = sh(dir, 'git', 'rev-parse', 'HEAD');
  sh(dir, 'git', 'fetch', '-q', '/workspace', 'lab/product-lane');
  sh(dir, 'git', 'merge', '-q', '--no-edit', 'FETCH_HEAD');
  if (existsSync('/workspace/node_modules')) symlinkSync('/workspace/node_modules', join(dir, 'node_modules'));
  sh(dir, 'node', '--test', ...sh(dir, 'git', 'ls-files', 'test/unit/pipeline').split('\n').filter((f) => f.endsWith('.test.js')));
  state.applied = sh(dir, 'git', 'rev-parse', 'HEAD');
  await withRulesetsOff(repo, async () => sh(dir, 'git', 'push', '-q', '-f', url(BOT), 'HEAD:testing'));
  save();
  log('lab testing was', state.original, 'now', state.applied);
}

async function restore() {
  const dir = clone(BOT);
  sh(dir, 'git', 'fetch', '-q', 'origin', state.original).catch?.(() => {});
  await withRulesetsOff(repo, async () => sh(dir, 'git', 'push', '-q', '-f', url(BOT), `${state.original}:refs/heads/testing`));
  log('lab testing put back on', state.original);
}

/** Make a branch from lab testing, apply `edit(dir)`, push it as `token`, open a pull request. */
function openPr({ branch, edit, token = BOT, title }) {
  const dir = clone(token);
  sh(dir, 'git', 'checkout', '-q', '-b', branch);
  edit(dir);
  sh(dir, 'git', 'add', '-A');
  sh(dir, 'git', 'commit', '-qm', title);
  sh(dir, 'git', 'push', '-q', url(token), `${branch}:refs/heads/${branch}`);
  const sha = sh(dir, 'git', 'rev-parse', 'HEAD');
  const out = gh(token, 'pr', 'create', '--repo', repo, '--base', 'testing', '--head', branch, '--title', title, '--body', 'Lab rehearsal of the product lane.');
  return { number: Number(out.split('/').pop()), sha, branch, dir };
}
const write = (dir, path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };

async function mergeable(number, want = 'MERGEABLE') {
  for (let i = 0; i < 40; i += 1) {
    const v = JSON.parse(gh(BOT, 'pr', 'view', String(number), '--repo', repo, '--json', 'mergeable,headRefOid'));
    if (v.mergeable === want) return v.headRefOid;
    await sleep(3);
  }
  throw new Error(`#${number} never became ${want}`);
}

/** Dispatch the shipper, wait for its run, return {url, conclusion, text}. */
async function dispatch({ number, sha, said = '', token = BOT }) {
  const before = new Set(JSON.parse(gh(BOT, 'run', 'list', '--repo', repo, '--workflow', 'pipeline-ship.yml', '-L', '30', '--json', 'databaseId')).map((r) => r.databaseId));
  gh(token, 'workflow', 'run', 'pipeline-ship.yml', '--repo', repo, '--ref', 'testing', '-f', `pr_number=${number}`, '-f', `sha=${sha}`, '-f', `owner_said=${said}`);
  let run;
  for (let i = 0; i < 40 && !run; i += 1) {
    await sleep(3);
    run = JSON.parse(gh(BOT, 'run', 'list', '--repo', repo, '--workflow', 'pipeline-ship.yml', '-L', '30', '--json', 'databaseId,url,status,conclusion,event')).find((r) => !before.has(r.databaseId));
  }
  if (!run) throw new Error('no ship run appeared');
  for (let i = 0; i < 100; i += 1) {
    const r = JSON.parse(gh(BOT, 'run', 'view', String(run.databaseId), '--repo', repo, '--json', 'status,conclusion,url'));
    if (r.status === 'completed') {
      let text = '';
      try { text = gh(BOT, 'run', 'view', String(run.databaseId), '--repo', repo, '--log'); } catch { /* skipped jobs have no log */ }
      const line = text.split('\n').map((l) => l.replace(/^.*?\t.*?\t/, '')).find((l) => /^(did not ship|shipped) #/.test(l.replace(/^\S+Z\s/, '').trim()) || /did not ship #|shipped #/.test(l)) ?? '';
      return { url: r.url, conclusion: r.conclusion, line: line.replace(/^\S+Z\s/, '').trim() };
    }
    await sleep(6);
  }
  throw new Error('ship run did not finish');
}

const pullState = (number) => {
  const v = JSON.parse(gh(BOT, 'pr', 'view', String(number), '--repo', repo, '--json', 'state,labels,mergedBy,headRefOid'));
  const statuses = JSON.parse(gh(BOT, 'api', `repos/${repo}/commits/${v.headRefOid}/statuses`)).filter((s) => s.context === 'contributor-tested');
  // newest first. pipeline-ready posts a pending one on every pull request; only success is the lock.
  return { state: v.state, labels: v.labels.map((l) => l.name), mergedBy: v.mergedBy?.login, locked: statuses[0]?.state === 'success' };
};

const HAPPY_FILES = (dir) => {
  write(dir, 'src/main/renderer-sandbox.js', "/** Lab stand-in for a product change. */\nexport const sandboxSwitch = (flag) => flag === 'on';\n");
  write(dir, 'test/unit/renderer-sandbox.test.js', "import assert from 'node:assert/strict';\nimport test from 'node:test';\n\nimport { sandboxSwitch } from '../../src/main/renderer-sandbox.js';\n\ntest('the switch is on only for on', () => {\n  assert.equal(sandboxSwitch('on'), true);\n  assert.equal(sandboxSwitch('off'), false);\n});\n");
  write(dir, 'docs/sandbox-note.md', '# Sandbox note\n\nThe renderer sandbox switch is read from one place.\n');
};

async function openHappy() {
  const t = Date.now().toString(36);
  const p = openPr({ branch: `product/sandbox-switch-${t}`, edit: HAPPY_FILES, title: 'Add the renderer sandbox switch' });
  state.happy = { number: p.number, sha: p.sha, branch: p.branch };
  save();
  log('happy PR', p.number, p.sha);
}

const R = [];
const row = (c) => { R.push(c); appendFileSync(RESULTS, `| ${c.name} | ${c.ok ? 'as expected' : 'UNEXPECTED'} | ${c.pr ? `#${c.pr}` : ''} | ${c.run ?? ''} | ${c.line ?? ''} | ${c.after ?? ''} |\n`); log(c.ok ? 'ok  ' : 'FAIL', c.name, '|', c.line); };

async function refuseCase({ name, want, branch, edit, token, said = 'ship it: the owner wrote "ship it" about PR {n}', dispatcher = BOT, afterPush, dispatchSha }) {
  const t = Date.now().toString(36);
  const p = openPr({ branch: `${branch}-${t}`, edit, token, title: `Lab case: ${name}` });
  let sha = p.sha;
  if (afterPush) sha = await afterPush(p);
  await mergeable(p.number);
  await sleep(8); // the push history can lag a few seconds
  const r = await dispatch({ number: p.number, sha: dispatchSha ? dispatchSha(p, sha) : sha, said: said.replace('{n}', p.number), token: dispatcher });
  const after = pullState(p.number);
  const clean = after.state === 'OPEN' && !after.locked && after.labels.length === 0;
  const matched = want === 'skipped' ? r.conclusion === 'skipped' || r.conclusion === 'failure' : want.test(r.line);
  row({ name, pr: p.number, run: r.url, line: want === 'skipped' ? `job ${r.conclusion}` : r.line, ok: matched && clean, after: `${after.state}, labels ${JSON.stringify(after.labels)}, lock ${after.locked}` });
  return p;
}

async function refusals() {
  writeFileSync(RESULTS, '| case | result | PR | run | shipper said | PR afterwards |\n|---|---|---|---|---|---|\n');
  const src = (d) => write(d, 'src/main/lane-case.js', 'export const x = 1;\n');
  const cases = [
    { name: 'also touches a workflow', want: /\.github\/workflows\/pipeline-sneaky\.yml is a dotfile/, branch: 'product/c-workflow', edit: (d) => { src(d); write(d, '.github/workflows/pipeline-sneaky.yml', 'name: sneaky\non: workflow_dispatch\njobs: {}\n'); } },
    { name: 'touches package.json', want: /package\.json is not under src/, branch: 'product/c-package', edit: (d) => { src(d); const f = join(d, 'package.json'); writeFileSync(f, readFileSync(f, 'utf8').replace('"name"', '"description": "x", "name"')); } },
    { name: 'touches test/corpus', want: /test\/corpus\/lane-row\.json is under test\/corpus/, branch: 'product/c-corpus', edit: (d) => { src(d); write(d, 'test/corpus/lane-row.json', '{}\n'); } },
    { name: 'same, in another case (test/Corpus)', want: /test\/Corpus\/lane-row\.json is under test\/corpus/, branch: 'product/c-corpus-case', edit: (d) => { write(d, 'test/Corpus/lane-row.json', '{}\n'); } },
    { name: 'touches scripts/ci', want: /scripts\/ci\/lane-case\.mjs is not under src/, branch: 'product/c-scripts', edit: (d) => { src(d); write(d, 'scripts/ci/lane-case.mjs', 'export const y = 1;\n'); } },
    { name: 'touches test/unit/pipeline', want: /test\/unit\/pipeline\/lane-case\.test\.js is under test\/unit\/pipeline/, branch: 'product/c-pipeline-test', edit: (d) => { src(d); write(d, 'test/unit/pipeline/lane-case.test.js', 'export {};\n'); } },
    { name: 'lib/src-fake path', want: /lib\/src-fake\/x\.js is not under src/, branch: 'product/c-srcfake', edit: (d) => write(d, 'lib/src-fake/x.js', 'export {};\n') },
    { name: 'contributor fix branch claude/fix-N-slug', want: /neither pipeline\/ nor product\//, branch: 'claude/fix-99-lane', edit: src },
    { name: 'plain claude/ session branch', want: /neither pipeline\/ nor product\//, branch: 'claude/lane-session', edit: src },
    { name: 'a symlink inside src/', want: /src\/main\/link\.js is a symlink/, branch: 'product/c-symlink', edit: (d) => { src(d); symlinkSync('../main.js', join(d, 'src/main/link.js')); } },
    { name: 'an executable file in src/', want: /src\/main\/run\.js is a symlink, an executable/, branch: 'product/c-exec', edit: (d) => { write(d, 'src/main/run.js', '#!/usr/bin/env node\n'); chmodSync(join(d, 'src/main/run.js'), 0o755); } },
    { name: 'a rename from outside the zone', want: /scripts\/ci\/gh\.mjs is not under src/, branch: 'product/c-rename', edit: (d) => { mkdirSync(join(d, 'src/main'), { recursive: true }); sh(d, 'git', 'mv', 'scripts/ci/gh.mjs', 'src/main/gh-copy.js'); } },
    { name: 'a deleted test', want: /deletes or moves a test/, branch: 'product/c-deltest', edit: (d) => { sh(d, 'git', 'rm', '-q', 'test/unit/model.test.js'); } },
    { name: 'a wrong actor starts the shipper (plain account with write access)', want: 'skipped', branch: 'product/c-actor', edit: src, dispatcher: CONTRIB },
    { name: 'the pull request was written by a contributor', want: /author is not the owner/, branch: 'product/c-author', edit: src, token: CONTRIB, dispatcher: BOT },
    { name: 'a contributor pushed onto the owner\'s branch', want: /pushed to the branch/, branch: 'product/c-stranger', edit: src,
      afterPush: async (p) => {
        const d = clone(CONTRIB, p.branch);
        write(d, 'src/main/stranger.js', 'export const s = 1;\n');
        sh(d, 'git', 'add', '-A'); sh(d, 'git', 'commit', '-qm', 'stranger');
        sh(d, 'git', 'push', '-q', url(CONTRIB), `HEAD:refs/heads/${p.branch}`);
        return sh(d, 'git', 'rev-parse', 'HEAD');
      } },
    { name: 'the branch moved after the caller looked', want: /branch moved/, branch: 'product/c-moved', edit: src,
      afterPush: async (p) => {
        const d = clone(BOT, p.branch);
        write(d, 'src/main/more.js', 'export const m = 1;\n');
        sh(d, 'git', 'add', '-A'); sh(d, 'git', 'commit', '-qm', 'one more');
        sh(d, 'git', 'push', '-q', url(BOT), `HEAD:refs/heads/${p.branch}`);
        return p.sha;
      }, dispatchSha: (p, sha) => sha },
    { name: 'no "ship it" (checks not green yet, so: words checked after greens; see happy run for the green case)', want: /./, skip: true }
  ];
  for (const c of cases) {
    if (c.skip) continue;
    try { await refuseCase(c); } catch (e) { row({ name: c.name, ok: false, line: String(e.message).slice(0, 200) }); }
  }
  log(R.every((r) => r.ok) ? 'ALL REFUSALS AS EXPECTED' : 'SOME REFUSALS UNEXPECTED');
}

async function waitGreen(sha) {
  for (let i = 0; i < 180; i += 1) {
    const runs = JSON.parse(gh(BOT, 'api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`)).workflow_runs;
    const want = ['pr-checks', 'pr-build'].map((n) => runs.find((r) => r.name === n));
    if (want.every((r) => r && r.status === 'completed')) return want.map((r) => `${r.name}:${r.conclusion}`);
    await sleep(20);
  }
  throw new Error('checks never finished');
}

async function happy() {
  const { number, sha } = state.happy;
  log('waiting for the checks on', sha);
  log(await waitGreen(sha));
  writeFileSync(RESULTS, readFileSync(RESULTS, 'utf8') + '\nHappy PR\n\n');
  await mergeable(number);
  await sleep(5);
  for (const c of [
    { name: 'green, but no "ship it"', said: '' },
    { name: 'green, "ship it" but no pull request number', said: 'ship it' },
    { name: 'green, words name another pull request', said: 'ship it: PR 1' },
    { name: 'green, wrong actor', said: `ship it: PR ${number}`, token: CONTRIB }
  ]) {
    const r = await dispatch({ number, sha, said: c.said, token: c.token });
    const after = pullState(number);
    row({ name: c.name, pr: number, run: r.url, line: c.token ? `job ${r.conclusion}` : r.line, ok: after.state === 'OPEN' && !after.locked && after.labels.length === 0, after: `${after.state}, labels ${JSON.stringify(after.labels)}, lock ${after.locked}` });
  }
  const r = await dispatch({ number, sha, said: `ship it: the owner wrote "ship it" about PR ${number}` });
  const after = pullState(number);
  row({ name: 'SHIPPED: ship it naming the PR', pr: number, run: r.url, line: r.line, ok: after.state === 'MERGED' && after.locked, after: `${after.state} by ${after.mergedBy}, lock ${after.locked}` });
}

const cmd = process.argv[2];
if (cmd === 'prepare') await prepare();
else if (cmd === 'open-happy') await openHappy();
else if (cmd === 'refusals') await refusals();
else if (cmd === 'happy') await happy();
else if (cmd === 'restore') await restore();
else { console.error('usage: product-live.mjs prepare|open-happy|refusals|happy|restore'); process.exit(2); }
