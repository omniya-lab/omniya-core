/**
 * Lab only. Put the OLD sign-off path on lab `testing` (the agent reads "@claude it works"),
 * so the robot can time it. Takes the files this change touches back from a commit.
 *
 *   node scripts/lab/baseline.mjs <branch-before-the-change>     put the old path on lab testing
 *
 * Plants the lab bug first if a merge fixed it. Put the new path back with `gate.mjs --branch`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { plantBug, pushToTesting } from './lab-admin.mjs';

const repo = process.env.LAB_REPO || process.env.GITHUB_REPOSITORY;
const before = process.argv[2];
if (!repo || !before) { console.error('usage: baseline.mjs <branch-before-the-change>'); process.exit(2); }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

console.log(await plantBug(repo));
const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
git(dir, 'init', '-q');
git(dir, 'remote', 'add', 'origin', `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`);
git(dir, 'fetch', '-q', 'origin', 'testing');
git(dir, 'checkout', '-q', '-B', 'base', 'FETCH_HEAD');
git(dir, 'config', 'user.name', 'omniya-lab-agent');
git(dir, 'config', 'user.email', 'lab-agent@users.noreply.github.com');
git(dir, 'fetch', '-q', resolve_here(), before);
git(dir, 'checkout', 'FETCH_HEAD', '--',
  '.github/workflows/pipeline-followup.yml', 'docs/contributor-pipeline.md',
  'scripts/ci/hand-off.mjs', 'scripts/ci/reply.mjs',
  'test/unit/pipeline/hand-off.test.js', 'test/unit/pipeline/reply.test.js',
  'test/unit/pipeline/keep-current.test.js', 'test/unit/pipeline/pipeline-doc.test.js');
git(dir, 'rm', '-q', '--ignore-unmatch', 'scripts/ci/confirm.mjs', 'test/unit/pipeline/confirm.test.js');
git(dir, 'commit', '-qm', 'Lab: the sign-off path as it was before the no-agent confirmation');
await pushToTesting(repo, dir, 'HEAD');
console.log('pushed', git(dir, 'rev-parse', '--short', 'HEAD'));

function resolve_here() { return process.cwd(); }
