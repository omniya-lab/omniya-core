/**
 * Lab only. Dry report of the carry-over against the REAL repository: anonymous reads, no token, nothing written.
 *   node scripts/lab/carry-dry-real.mjs <path of a clone of the real repo> [pr numbers...]
 * The clone must have fetched the fix branches (a plain clone does). Never ported.
 */
import { execFileSync } from 'node:child_process';

import { carryAll, makeGit } from '../ci/carry-over.mjs';
import { anonGh, stats } from './anon-gh.mjs';

const [dir, ...only] = process.argv.slice(2);
execFileSync('git', ['fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { cwd: dir });
const results = [];
for (const pr of only.length ? only : ['']) {
  results.push(...carryAll({
    repo: 'ParkingSoman/omniya-core', git: makeGit(dir), testing: 'origin/testing',
    logins: ['github-actions[bot]', 'omniya-pipeline[bot]'], mergeToken: '', dry: true, only: pr, ignoreLabels: true
  }, anonGh));
}
console.log(JSON.stringify(results, null, 1));
console.error(`network calls ${stats.network}, from cache ${stats.cached}`);
