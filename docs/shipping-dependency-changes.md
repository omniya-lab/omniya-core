# Shipping a dependency or config change

`package.json`, `package-lock.json` and `electron-builder.yml` ship on the owner's words, like the rest of the
ship-it zone, but only when automatic safety checks pass first. The reason is
`npm ci`: it runs in the agent job, which holds the pipeline's secrets. A new package with an install
script, or one fetched from a git address or a tarball, would run code beside those secrets on the next
agent run. The checks make those cases impossible, so "ship it" is safe to say without reading every line.

## How a session ships one

1. Push the change on a `pipeline/<slug>` branch that holds those files and nothing else. Open the pull request.
2. Run `pipeline-ship.yml` WITHOUT `owner_said`. It refuses, and prints the plain summary in the run
   summary: what was added, removed and updated, Electron on its own line, the audit result. Read that
   summary to the owner. Locally, `node scripts/ci/deps-gate.mjs local <base-ref> <head-ref>` prints the same.
3. When the owner says "ship it" about the pull request, run it again with `-f owner_said='ship it <N>'`.

## What must hold

The shared rules first: the author and every pusher are the owner or the session account, the pull request is
open, not a draft, not a fork, mergeable, into `testing`, its head is the commit named, checks are green on it,
and the words say "ship it" and name the pull request number. Then, in a job with no secret
(`deps` in `pipeline-ship.yml`), by parsing, never by a line scan:

- **Files.** Only these three, only edited. Any other file in the pull request, any other spelling of their
  names, a rename, a symlink, an executable bit: refused. `CLAUDE.md` and `README.md` are not included
  (`CLAUDE.md` steers the agent, so it belongs with the prompt, not here).
- **`package.json`.** Only `version`, `dependencies`, `devDependencies` and `optionalDependencies` may differ. A
  `scripts` change is code CI runs: it goes through the pipeline with a reading of the diff. Every changed
  version must be a plain semver range. Git, GitHub, file, link, URL, tarball and `npm:` specs are refused.
- **`package-lock.json`.** Every package comes from `https://registry.npmjs.org/`, at the exact address npm gives
  that name and version, with an integrity hash. An unchanged version keeps its hash. No package gains an
  install script unless it is on `scripts/ci/install-script-allowlist.json` (exact name, exact major). Then
  `npm ci --ignore-scripts` must pass on the new files, and `npm audit --omit=dev --audit-level=high` must show
  no new high or critical advisory against the base. An audit that cannot run fails closed.
- **`electron-builder.yml`.** Only the product name, the file list and three installer choices may differ. The update
  address, the app id, signing, hooks and installer scripts are refused.

Every other lane that touches these files needs the same pass. The product lane and the contributor hand-off
refuse them by zone as well.

## What it cannot do

It cannot tell a malicious but plain version of a listed package from a good one, and it cannot see a
package that turns hostile later. Package code that is not an install script still runs when a test or the app
imports it. A dependency that is new and unknown deserves a look at its name in the summary. Adding an entry to the install-script list is a change
to the lock: it needs the owner's "ship it" and the strictness check.
