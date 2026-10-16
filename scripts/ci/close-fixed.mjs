/**
 * Close the issue a merged fix was for.
 *
 * GitHub closes an issue from `Fixes #N` only on behalf of whoever merged, and the
 * pipeline's App has no write access to issues, so the issue stayed open after the
 * fix merged. This closes it, once, from a workflow that holds the built-in token.
 *
 * It acts only when ALL of these hold, read from the event and never from text a
 * contributor wrote: the pull request merged, into `testing`, from this
 * repository, on a `claude/fix-` branch, and `Fixes #<n>` is the last line of its
 * body. Anything else exits without doing anything.
 *
 * Usage (needs GH_TOKEN and GITHUB_REPOSITORY; the pull request comes in through env):
 *   MERGED=true BASE=testing HEAD_REF=claude/fix-1-x CROSS=false BODY=... node scripts/ci/close-fixed.mjs
 */

import { pathToFileURL } from 'node:url';

import { gh } from './gh.mjs';

const FIX_PREFIX = 'claude/fix-';

/** @returns {number|null} the issue to close, or null. */
export function issueToClose({ merged, base, headRef, cross, body }) {
  if (merged !== true || base !== 'testing' || cross !== false) return null;
  if (typeof headRef !== 'string' || !headRef.startsWith(FIX_PREFIX)) return null;
  const m = /(?:^|\n)[Ff]ixes #(\d+)[ \t\r\n]*$/.exec(String(body ?? ''));
  return m ? Number(m[1]) : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const e = process.env;
  const issue = issueToClose({
    merged: e.MERGED === 'true',
    base: e.BASE,
    headRef: e.HEAD_REF,
    cross: e.CROSS === 'false' ? false : true,
    body: e.BODY
  });
  if (!issue) {
    console.log('close-fixed: nothing to close');
  } else {
    gh(['api', '-X', 'PATCH', `repos/${e.GITHUB_REPOSITORY}/issues/${issue}`, '-f', 'state=closed', '-f', 'state_reason=completed']);
    console.log(`close-fixed: closed #${issue}`);
  }
}
