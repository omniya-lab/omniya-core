# Shipping a change to the app

A session that changed the app pushes it as `product/<slug>` (not `claude/...`: the
agent names its contributor branches `claude/...`, and a contributor's words steer
it, so that name proves nothing about who wrote the branch). When you say "ship it"
about the pull request, the session runs the same `pipeline-ship.yml` with
`-f owner_said='ship it: PR <N>'`. It merges when ALL of these hold, and says one
sentence naming the first thing that fails when not:

- The branch is `product/<slug>`, in this repository, into `testing`, not a draft, mergeable.
  The author is you or the session account, and only you two pushed.
- The checks are green on the exact head commit, and the head did not move.
- Every file is inside the zone: `src/**`, `test/**`, `docs/**`. Never `test/corpus/**`
  or `test/unit/pipeline/**`, and nothing else: no `package.json`, lockfile,
  `electron-builder.yml`, `scripts/**`, `.github/**`, `.claude/**`, no dotfile.
  A rename is judged by its old path too. A path with `..`, a backslash, a space, a
  trailing dot, a non-ASCII letter or the wrong case is refused.
- No symlink, no executable bit, no submodule, before or after. No test is deleted or
  moved, and none loses more lines than it gains. The file list is whole.
- Your words say "ship it" and name the pull request number.

It is the same lock and the same squash merge as for the automation. The zone and its
test are in the lock tier (`scripts/ci/product-lane.mjs`), so a product pull request cannot
widen the zone. A contributor's fix (`claude/fix-*`) is never shipped this way.
