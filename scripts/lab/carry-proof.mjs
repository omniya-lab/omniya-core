/**
 * Lab only. Live proof of the approval carry-over (scripts/ci/carry-over.mjs). Never ported.
 *
 *   node scripts/lab/carry-proof.mjs setup            sample file on testing + the lab-hold status the rule waits for
 *   node scripts/lab/carry-proof.mjs a                approve at A; testing moves; keep-current merges it; the approval carries
 *   node scripts/lab/carry-proof.mjs b                approve at A; a person changes one added line; testing moves: no carry, then a fresh answer merges it
 *   node scripts/lab/carry-proof.mjs c                approve at A; a person pushes a commit that adds a file; testing moves: no carry
 *   node scripts/lab/carry-proof.mjs teardown         take the hold off
 *
 * The hold: in the real repo an approval at A can sit unmerged when the head moves (the merge waits for something).
 * The lab makes that wait on purpose: `testing-tested` also requires the status `lab-hold`, which this script posts
 * by hand when it wants a pull request to merge. Needs GH_TOKEN (lab admin), CONTRIB_GH_TOKEN, LAB_REPO.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pushToTesting } from './lab-admin.mjs';

const repo = process.env.LAB_REPO;
const BOT = process.env.GH_TOKEN;
const CONTRIB = process.env.CONTRIB_GH_TOKEN;
const SAMPLE = 'docs/lab-carry-sample.md';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`+${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s ${m}`);
const gh = (token, ...args) => execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token } }).trim();
const api = (token, path, ...rest) => JSON.parse(gh(token, 'api', path, ...rest) || 'null');
const url = `https://x-access-token:${BOT}@github.com/${repo}.git`;
const sample = (n = 40) => Array.from({ length: n }, (_, i) => `Sample line ${i + 1}.`).join('\n') + '\n';

function clone(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('fetch', '-q', '--depth', '30', url, ref);
  git('checkout', '-q', '-B', 'work', 'FETCH_HEAD');
  git('config', 'user.name', 'omniya-lab-agent');
  git('config', 'user.email', 'lab-agent@users.noreply.github.com');
  return { dir, git };
}

async function rulesetHold(on) {
  const sets = api(BOT, `repos/${repo}/rulesets`);
  const id = sets.find((s) => s.name === 'testing-tested').id;
  const full = api(BOT, `repos/${repo}/rulesets/${id}`);
  const rule = full.rules.find((r) => r.type === 'required_status_checks');
  const has = rule.parameters.required_status_checks.some((c) => c.context === 'lab-hold');
  if (on && !has) rule.parameters.required_status_checks.push({ context: 'lab-hold' });
  if (!on && has) rule.parameters.required_status_checks = rule.parameters.required_status_checks.filter((c) => c.context !== 'lab-hold');
  const body = { name: full.name, target: full.target, enforcement: full.enforcement, conditions: full.conditions, rules: full.rules, bypass_actors: full.bypass_actors };
  execFileSync('gh', ['api', '-X', 'PUT', `repos/${repo}/rulesets/${id}`, '--input', '-'], { input: JSON.stringify(body), env: { ...process.env, GH_TOKEN: BOT } });
}

async function setup() {
  const { dir, git } = clone('testing');
  if (!(() => { try { readFileSync(join(dir, SAMPLE)); return true; } catch { return false; } })()) {
    writeFileSync(join(dir, SAMPLE), sample());
    git('add', '-A');
    git('commit', '-qm', 'Lab only: a sample page the carry-over fixtures edit');
    await pushToTesting(repo, dir, 'HEAD');
    log('sample page pushed to testing');
  }
  await rulesetHold(true);
  log('lab-hold is required by testing-tested');
}

async function openFix(name) {
  const issue = api(CONTRIB, `repos/${repo}/issues`, '-X', 'POST', '-f', `title=Carry fixture ${name}`, '-f', 'body=Fixture for the carry-over. I tested the build.');
  const n = issue.number;
  const { dir, git } = clone('testing');
  const branch = `claude/fix-${n}-carry-${name}`;
  git('checkout', '-q', '-b', branch);
  const lines = readFileSync(join(dir, SAMPLE), 'utf8').split('\n');
  lines.splice(20, 0, `FIX ${name}: this line is the fix.`);
  writeFileSync(join(dir, SAMPLE), lines.join('\n'));
  git('add', '-A');
  git('commit', '-qm', `Fixture ${name}`);
  git('push', '-q', url, `${branch}:${branch}`);
  const pr = gh(BOT, 'pr', 'create', '--repo', repo, '--base', 'testing', '--head', branch, '--draft', '--title', `Carry fixture ${name}`, '--body', `Fixture for the carry-over.\n\nFixes #${n}`);
  const prNumber = Number(pr.split('/').pop());
  log(`issue #${n}, pull request #${prNumber}, branch ${branch}, A = ${git('rev-parse', 'HEAD')}`);
  return { n, prNumber, branch, A: git('rev-parse', 'HEAD') };
}

const comments = (n) => api(BOT, `repos/${repo}/issues/${n}/comments?per_page=100`);
const state = (c) => /omniya-pipeline-state ([a-z-]+)/.exec(c.body)?.[1] ?? '';
const pr = (num) => api(BOT, `repos/${repo}/pulls/${num}`);
const statuses = (sha) => api(BOT, `repos/${repo}/commits/${sha}/statuses`);

async function until(what, fn, minutes = 30, every = 15_000) {
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

async function built(sha) {
  await until(`pack-mac on ${sha.slice(0, 8)}`, () => {
    const runs = api(BOT, `repos/${repo}/commits/${sha}/check-runs?per_page=100`).check_runs;
    return runs.some((c) => c.name === 'pack-mac' && c.conclusion === 'success');
  }, 40);
  log(`pack-mac is green on ${sha.slice(0, 8)}`);
}

async function allGreen(sha) {
  await until(`unit, nemeth, e2e on ${sha.slice(0, 8)}`, () => {
    const runs = api(BOT, `repos/${repo}/commits/${sha}/check-runs?per_page=100`).check_runs;
    return ['unit', 'nemeth', 'e2e'].every((n) => runs.some((c) => c.name === n && c.conclusion === 'success'));
  }, 40);
  log(`unit, nemeth, e2e are green on ${sha.slice(0, 8)}`);
}

async function say(n, st, prNumber) {
  const before = comments(n).length;
  gh(BOT, 'workflow', 'run', 'lab-reply.yml', '--repo', repo, '--ref', 'testing', '-f', `issue=${n}`, '-f', `state=${st}`, '-f', `pr=${prNumber}`);
  await until(`a ${st} comment`, () => comments(n).length > before && state(comments(n).at(-1)) === st, 5, 6000);
  log(`the pipeline said: ${st}`);
}

const contribSays = (n, body) => { const c = api(CONTRIB, `repos/${repo}/issues/${n}/comments`, '-X', 'POST', '-f', `body=${body}`); log(`contributor: ${body}`); return c; };

async function moveTesting() {
  const { dir, git } = clone('testing');
  const f = join(dir, SAMPLE);
  writeFileSync(f, `Testing moved on ${Date.now()}.\nAnother new line above everything.\n` + readFileSync(f, 'utf8'));
  git('add', '-A');
  git('commit', '-qm', 'Lab only: testing moves on (lines added at the top of the sample page)');
  await pushToTesting(repo, dir, 'HEAD');
  log(`testing is now ${git('rev-parse', 'HEAD').slice(0, 8)}`);
}

async function personPushes(branch, message, edit) {
  const { dir, git } = clone(branch);
  edit(dir);
  git('add', '-A');
  git('commit', '-qm', message);
  git('push', '-q', url, `work:${branch}`);
  const sha = git('rev-parse', 'HEAD');
  log(`a person pushed ${sha.slice(0, 8)}: ${message}`);
  return sha;
}

async function waitHeadChange(prNumber, from, label) {
  const head = await until(label, () => { const h = pr(prNumber).head.sha; return h !== from ? h : null; }, 20);
  log(`head of #${prNumber} is now ${head}`);
  return head;
}

const summary = async (f, h) => {
  const thr = comments(f.n).map((c) => `${c.id}:${c.user.login}:${state(c) || (c.user.login === 'github-actions[bot]' ? 'plain' : 'said')}`);
  const p = pr(f.prNumber);
  log(`RESULT thread=${thr.join(' | ')}`);
  log(`RESULT pr merged=${p.merged} state=${p.state} auto_merge=${JSON.stringify(p.auto_merge && { sha: p.auto_merge.commit_title ? 'set' : 'set' })}`);
  log(`RESULT contributor-tested on head: ${statuses(h).filter((s) => s.context === 'contributor-tested').map((s) => s.state).join(',') || 'none'}`);
};

async function carryRunAfter(since, head) {
  // The newest pipeline-carry run that started after `since`, finished.
  return until('a carry run after the checks of the new head', () => {
    const runs = api(BOT, `repos/${repo}/actions/workflows/pipeline-carry.yml/runs?per_page=10`).workflow_runs;
    const r = runs.find((x) => Date.parse(x.created_at) > since && x.status === 'completed');
    return r ?? null;
  }, 30, 20_000);
}

const carryLine = (runId, prNumber) => {
  const log = gh(BOT, 'run', 'view', String(runId), '--repo', repo, '--log');
  return log.split('\n').filter((l) => l.includes(`#${prNumber} `) && /(carried|would-carry|skip):/.test(l)).map((l) => l.replace(/^.*?Z /, '')).join(' || ') || '(no line for this pull request)';
};

async function scenario(which) {
  await setup();
  const f = await openFix(which);
  await built(f.A);
  await allGreen(f.A);
  // The contributor was handed the build and approves it. The hand-off sets the lock and auto-merge on A. The merge
  // waits for lab-hold, which stands in for whatever holds a real approval back.
  await say(f.n, 'ready', f.prNumber);
  contribSays(f.n, 'it works');
  await until('the hand-off to set the lock on A', () => statuses(f.A).some((s) => s.context === 'contributor-tested' && s.state === 'success'), 15, 10_000);
  await until('the sent notice', () => comments(f.n).some((c) => state(c) === 'sent'), 5, 6000);
  log(`approved at A = ${f.A}; held by lab-hold, merged=${pr(f.prNumber).merged}`);
  let head = f.A;
  if (which === 'b') {
    head = await personPushes(f.branch, 'a person changes one added line', (dir) => {
      const file = join(dir, SAMPLE);
      writeFileSync(file, readFileSync(file, 'utf8').replace(`FIX ${which}: this line is the fix.`, `FIX ${which}: this line is the fix, reworded.`));
    });
  }
  if (which === 'c') {
    head = await personPushes(f.branch, 'a person adds a file', (dir) => { mkdirSync(join(dir, 'docs'), { recursive: true }); writeFileSync(join(dir, 'docs/lab-carry-extra.md'), 'An extra page.\n'); });
  }
  const afterApproval = Date.now();
  await moveTesting();
  const H = await until('keep-current to merge testing into the branch', () => { const h = pr(f.prNumber).head.sha; return h !== head ? h : null; }, 20);
  log(`head is ${H} (A ${f.A}${head === f.A ? '' : `, person's commit ${head}`})`);
  await built(H);
  await allGreen(H);
  const checksDone = Date.now();
  if (which === 'a') {
    await until('the carried notice and the lock on H', () => comments(f.n).some((c) => state(c) === 'carried') && statuses(H).some((s) => s.context === 'contributor-tested' && s.state === 'success'), 30, 15_000);
    log('carried: the lock is on H and the contributor was told');
    const run1 = api(BOT, `repos/${repo}/actions/workflows/pipeline-carry.yml/runs?per_page=5`).workflow_runs.find((x) => Date.parse(x.created_at) > afterApproval && x.status === 'completed');
    if (run1) log(`carry run ${run1.html_url} (${run1.event}): ${carryLine(run1.id, f.prNumber)}`);
    // Run it again by hand: it must find the lock already on H and say nothing new.
    gh(BOT, 'workflow', 'run', 'pipeline-carry.yml', '--repo', repo, '--ref', 'testing');
    await sleep(20_000);
    const again = await carryRunAfter(Date.now() - 25_000, H);
    log(`second carry run ${again.html_url}: ${carryLine(again.id, f.prNumber)}`);
    log(`carried comments on the issue: ${comments(f.n).filter((c) => state(c) === 'carried').length}`);
    await summary(f, H);
    gh(BOT, 'api', `repos/${repo}/statuses/${H}`, '-f', 'state=success', '-f', 'context=lab-hold', '-f', 'description=Lab: let it merge');
    log('lab-hold released on H');
    await until('the merge', () => pr(f.prNumber).merged, 15, 10_000);
    log(`MERGED #${f.prNumber}`);
    await until('the issue to close', () => api(BOT, `repos/${repo}/issues/${f.n}`).state === 'closed', 10, 10_000);
    log(`issue #${f.n} is closed`);
    await summary(f, H);
    return;
  }
  // b and c: the carry must look at it and decline.
  const run = await carryRunAfter(checksDone - 60_000, H);
  log(`carry run ${run.html_url} (${run.event}): ${carryLine(run.id, f.prNumber)}`);
  gh(BOT, 'workflow', 'run', 'pipeline-carry.yml', '--repo', repo, '--ref', 'testing');
  await sleep(20_000);
  const again = await carryRunAfter(Date.now() - 25_000, H);
  log(`second carry run ${again.html_url}: ${carryLine(again.id, f.prNumber)}`);
  await summary(f, H);
  log(`carried comments: ${comments(f.n).filter((c) => state(c) === 'carried').length}; contributor-tested on H: ${statuses(H).filter((s) => s.context === 'contributor-tested' && s.state === 'success').length}; merged: ${pr(f.prNumber).merged}`);
  if (which === 'b') {
    // Today's path is unchanged: the pipeline asks for a fresh answer on the new build, and a fresh "it works" is taken.
    await say(f.n, 'revised', f.prNumber);
    contribSays(f.n, 'it works');
    await until('a new lock on H', () => statuses(H).some((s) => s.context === 'contributor-tested' && s.state === 'success'), 15, 10_000);
    log('the fresh "it works" set the lock on H (normal hand-off, not a carry)');
    gh(BOT, 'api', `repos/${repo}/statuses/${H}`, '-f', 'state=success', '-f', 'context=lab-hold', '-f', 'description=Lab: let it merge');
    await until('the merge', () => pr(f.prNumber).merged, 15, 10_000);
    log(`MERGED #${f.prNumber} after the fresh answer`);
    await summary(f, H);
  }
}

const cmd = process.argv[2];
if (cmd === 'setup') await setup();
else if (cmd === 'teardown') { await rulesetHold(false); log('lab-hold is not required any more'); }
else if (['a', 'b', 'c'].includes(cmd)) await scenario(cmd);
else { console.error('usage: carry-proof.mjs setup|a|b|c|teardown'); process.exit(2); }
