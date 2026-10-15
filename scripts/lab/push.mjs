/**
 * Put a local branch on lab `testing` (rulesets off for that push only), without
 * running scenarios. For hand-run rehearsals that the gate's three scenarios do not cover.
 *   node scripts/lab/push.mjs <branch>
 * Lab only.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { pushToTesting } from './lab-admin.mjs';

const branch = process.argv[2];
const repo = process.env.LAB_REPO;
if (!branch || !repo) { console.error('usage: push.mjs <branch>'); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), 'push-'));
const sh = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
sh('init', '-q');
sh('fetch', '-q', resolve('.'), branch);
sh('checkout', '-q', '-B', 'push', 'FETCH_HEAD');
await pushToTesting(repo, dir, 'HEAD', { force: true });
console.log(`lab testing is now ${sh('rev-parse', '--short', 'HEAD')}`);
