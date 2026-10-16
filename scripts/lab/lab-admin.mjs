/**
 * Lab-only helpers that use the lab admin token. Nothing here may be ported to the
 * real repository: it switches rulesets off, which only a throwaway repo may do.
 *
 *   plantBug()     put the known bug back on lab `testing` (and its failing test)
 *   unplantBug()   undo it, if it is still there
 *   pushToTesting  push a branch or a ref to lab `testing`, around the rulesets
 *
 * The bug: `docSnippet` in src/domain/document.js uses `>=`, so a first line of
 * exactly 80 letters is cut. Real `testing` has the correct `>`. The robot's
 * scenarios need something to fix, so the lab plants it, and the plant commit is
 * never to be ported.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'https://api.github.com';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Run `fn` with the lab's rulesets switched off, and switch them back on after, even on error. */
export async function withRulesetsOff(repo, fn) {
  const sets = (await api('GET', `/repos/${repo}/rulesets`)).filter((r) => r.enforcement === 'active');
  for (const r of sets) await api('PUT', `/repos/${repo}/rulesets/${r.id}`, { enforcement: 'disabled' });
  try {
    return await fn();
  } finally {
    for (const r of sets) await api('PUT', `/repos/${repo}/rulesets/${r.id}`, { enforcement: 'active' });
  }
}

function clone(repo, ref) {
  const dir = mkdtempSync(join(tmpdir(), 'lab-'));
  const url = `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`;
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', url);
  git(dir, 'fetch', '-q', '--depth', '50', 'origin', ref);
  git(dir, 'checkout', '-q', '-B', 'work', 'FETCH_HEAD');
  git(dir, 'config', 'user.name', 'omniya-lab-agent');
  git(dir, 'config', 'user.email', 'lab-agent@users.noreply.github.com');
  return dir;
}

const TEST = `
test('the list preview keeps a first line that is exactly as long as the limit', () => {
  const line = 'a'.repeat(80);
  const doc = docWithTitle({ type: 'doc', content: [
    { type: 'paragraph' },
    { type: 'paragraph', content: [{ type: 'text', text: line }] }
  ] }, 'Long line');
  assert.equal(docSnippet(doc), line);
  assert.equal(docSnippet(doc, 79), \`\${'a'.repeat(78)}…\`);
});
`;

export const isPlanted = (dir) => readFileSync(join(dir, 'src/domain/document.js'), 'utf8').includes('text.length >= max');

/** @returns {Promise<string>} what happened */
export async function plantBug(repo, branch = 'testing') {
  const dir = clone(repo, branch);
  if (isPlanted(dir)) return 'already planted';
  const f = join(dir, 'src/domain/document.js');
  writeFileSync(f, readFileSync(f, 'utf8').replace('text.length > max', 'text.length >= max'));
  const t = join(dir, 'test/unit/model.test.js');
  if (!readFileSync(t, 'utf8').includes('exactly as long as the limit')) writeFileSync(t, readFileSync(t, 'utf8') + TEST);
  git(dir, 'commit', '-qam', 'Notes list: tidy the preview length check\n\nLab only: plants the bug the robot reports. Never port.');
  await withRulesetsOff(repo, async () => git(dir, 'push', '-q', 'origin', `work:${branch}`));
  return 'planted';
}

/** Revert the planted bug and its test with one commit. */
export async function unplantBug(repo, branch = 'testing') {
  const dir = clone(repo, branch);
  if (!isPlanted(dir)) return 'not planted';
  const f = join(dir, 'src/domain/document.js');
  writeFileSync(f, readFileSync(f, 'utf8').replace('text.length >= max', 'text.length > max'));
  git(dir, 'commit', '-qam', 'Lab: take the planted bug out again');
  await withRulesetsOff(repo, async () => git(dir, 'push', '-q', 'origin', `work:${branch}`));
  return 'unplanted';
}

/** Push a lab branch over `testing`. Used to apply a pipeline change to the lab's `testing`. */
export async function pushToTesting(repo, cwd, ref, { force = false } = {}) {
  await withRulesetsOff(repo, async () => git(cwd, 'push', '-q', ...(force ? ['-f'] : []), `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`, `${ref}:testing`));
}

if (process.argv[1]?.endsWith('lab-admin.mjs')) {
  const repo = process.env.LAB_REPO || process.env.GITHUB_REPOSITORY;
  const cmd = process.argv[2];
  if (cmd === 'plant') console.log(await plantBug(repo));
  else if (cmd === 'unplant') console.log(await unplantBug(repo));
  else { console.error('usage: lab-admin.mjs plant|unplant'); process.exit(2); }
}
