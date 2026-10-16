/**
 * Lab only. Make a fix pull request WITHOUT the agent, so the hand-off can be rehearsed on a
 * chosen set of files, and play the contributor's "it works".
 *
 *   node scripts/lab/fixture.mjs open   <name> <path=content>...   issue + branch + draft pull request
 *   node scripts/lab/fixture.mjs signoff <issue>                    wait for the build comment, say "it works", report the outcome
 *   node scripts/lab/fixture.mjs show   <issue>                     print the state of an issue and its pull request
 *
 * Needs GH_TOKEN (the bot account, admin), CONTRIB_GH_TOKEN (the plain contributor), LAB_REPO.
 * Contents may contain \n. A file written as `path=@delete` is removed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repo = process.env.LAB_REPO;
const gh = (token, ...args) => execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token } }).trim();
const BOT = process.env.GH_TOKEN;
const CONTRIB = process.env.CONTRIB_GH_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (token, path, ...rest) => JSON.parse(gh(token, 'api', path, ...rest) || 'null');

export async function open(name, files) {
  const issue = api(CONTRIB, `repos/${repo}/issues`, '-X', 'POST', '-f', `title=Fixture ${name}`, '-f', 'body=Fixture for the hand-off. I tested the build.');
  const n = issue.number;
  const dir = mkdtempSync(join(tmpdir(), 'fx-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('fetch', '-q', '--depth', '1', `https://x-access-token:${BOT}@github.com/${repo}.git`, 'testing');
  const branch = `claude/fix-${n}-${name}`;
  git('checkout', '-q', '-b', branch, 'FETCH_HEAD');
  git('config', 'user.name', 'omniya-lab-agent');
  git('config', 'user.email', 'lab-agent@users.noreply.github.com');
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === '@delete') { rmSync(full, { force: true }); continue; }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content.replace(/\\n/g, '\n'));
  }
  git('add', '-A');
  git('commit', '-qm', `Fixture ${name}`);
  git('push', '-q', `https://x-access-token:${BOT}@github.com/${repo}.git`, `${branch}:${branch}`);
  const pr = gh(BOT, 'pr', 'create', '--repo', repo, '--base', 'testing', '--head', branch, '--draft', '--title', `Fixture ${name}`, '--body', `Fixture.\n\nFixes #${n}`);
  return { issue: n, branch, pr };
}

const comments = (n) => api(BOT, `repos/${repo}/issues/${n}/comments?per_page=100`);
const state = (c) => /omniya-pipeline-state ([a-z-]+)/.exec(c.body)?.[1] ?? '';
const prOf = (n) => JSON.parse(gh(BOT, 'pr', 'list', '--repo', repo, '--state', 'all', '--search', `Fixes #${n} in:body`, '--json', 'number,state,mergedAt,headRefName,labels'))[0];

export async function signoff(n, { buildWaitMin = 60, outcomeWaitMin = 12 } = {}) {
  const t0 = Date.now();
  const log = (m) => console.log(`+${Math.round((Date.now() - t0) / 1000)}s #${n} ${m}`);
  let ready;
  while (!ready) {
    ready = comments(n).filter((c) => c.user.login === 'github-actions[bot]' && ['ready', 'revised'].includes(state(c))).at(-1);
    if (ready) break;
    if (Date.now() - t0 > buildWaitMin * 60_000) throw new Error('no build comment');
    await sleep(20_000);
  }
  log(`build comment ${ready.id}`);
  const said = api(CONTRIB, `repos/${repo}/issues/${n}/comments`, '-X', 'POST', '-f', 'body=it works');
  log('contributor said: it works');
  const t1 = Date.now();
  for (;;) {
    const pr = prOf(n);
    const after = comments(n).filter((c) => c.id > said.id && c.user.login === 'github-actions[bot]');
    if (pr?.mergedAt) { log(`MERGED pr #${pr.number}`); return { outcome: 'merged', pr, after, readyBody: ready.body }; }
    if (after.length) { log(`bot said (${state(after.at(-1))}): ${after.at(-1).body.replace(/\n/g, ' ').slice(0, 200)}`); return { outcome: state(after.at(-1)) || 'comment', pr, after, readyBody: ready.body }; }
    if (Date.now() - t1 > outcomeWaitMin * 60_000) return { outcome: 'silent', pr, after, readyBody: ready.body };
    await sleep(15_000);
  }
}

if (process.argv[1]?.endsWith('fixture.mjs')) {
  const [cmd, a, ...rest] = process.argv.slice(2);
  if (cmd === 'open') {
    const files = Object.fromEntries(rest.map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
    console.log(JSON.stringify(await open(a, files)));
  } else if (cmd === 'signoff') {
    const r = await signoff(Number(a));
    console.log(JSON.stringify({ outcome: r.outcome, pr: r.pr?.number }));
  } else if (cmd === 'show') {
    console.log(JSON.stringify({ pr: prOf(Number(a)), states: comments(Number(a)).map(state) }));
  } else { console.error('usage: fixture.mjs open|signoff|show'); process.exit(2); }
}
