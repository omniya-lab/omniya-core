/**
 * Write the two data files that cannot read a repository variable:
 * `.github/CODEOWNERS` and the owner line of `.github/contributors.yml`.
 *
 * Workflows read OWNER_LOGIN and BOT_LOGIN as repository variables, with today's
 * values as defaults. These two files are plain data, so a twin repo runs this
 * once. With no variables set it writes nothing new: the defaults are the
 * real repo's own values.
 *
 *   OWNER_LOGIN=someone node scripts/ci/render-identity.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const DEFAULT_OWNER = 'ParkingSoman';

export function renderCodeowners(text, owner) {
  return text.replace(/^\* @\S+[ \t]*$/m, `* @${owner}`);
}

export function renderContributors(text, owner) {
  return text.replace(new RegExp(`^  - ${DEFAULT_OWNER}[ \\t]*$`, 'm'), `  - ${owner}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const owner = process.env.OWNER_LOGIN || DEFAULT_OWNER;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    console.error(`not a GitHub login: ${owner}`);
    process.exit(1);
  }
  const files = [
    ['.github/CODEOWNERS', renderCodeowners],
    ['.github/contributors.yml', renderContributors]
  ];
  let changed = 0;
  for (const [path, render] of files) {
    const before = readFileSync(path, 'utf8');
    const after = render(before, owner);
    if (after !== before) {
      changed += 1;
      if (!process.argv.includes('--check')) writeFileSync(path, after);
      console.log(`${path}: owner is now ${owner}`);
    }
  }
  if (process.argv.includes('--check')) process.exit(changed ? 1 : 0);
}
