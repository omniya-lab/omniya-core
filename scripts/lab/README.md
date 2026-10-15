# Lab tools

Lab only. None of this is ported to the real repository except, if wanted, the
robot and the gate as a tool a session runs. The lab has its own GitHub org, a
test contributor token and admin rights. The real repo has none of these.

Env: `GH_TOKEN` (lab admin), `CONTRIB_GH_TOKEN` (plain test contributor),
`LAB_REPO`.

## Robot contributor: `robot-contributor.mjs`

Plays a blind contributor with the contributor token.

| Scenario | What it proves |
|---|---|
| `fix` | A clear report. Agent fixes it, builds, "it works", auto-merge, issue closes. |
| `ask` | A vague report. The agent asks, the robot answers from a script, the fix still lands. A non-author "it works" does nothing. Fails if the agent did not ask. |
| `design` | A request for new behaviour. The agent refuses, label `needs-design`, one comment, no pull request, no branch. |

```
node scripts/lab/robot-contributor.mjs --scenario ask,design --fast --json out.json
```

Options: `--poll-s 12`, `--timeout-min 45`, `--non-author-wait-s 150`
(`45` with `--fast`), `--scenario fix|ask|design|all` (comma list; they run in
parallel). Exit 1 on any failure. `fix` and `ask` need the lab bug planted
(`lab-admin.mjs plant`).

The non-author "it works" is posted when the fix pull request first exists, so
the check overlaps the build and adds almost no time.

## Gate: `gate.mjs`

How a session ships a pipeline change:

1. Make the change on a branch (or make a diff: `git diff testing > change.diff`).
2. Run
   ```
   node scripts/lab/gate.mjs --branch my-branch --fast
   node scripts/lab/gate.mjs --diff change.diff --scenarios ask,design,fix
   ```
3. Read `gate-result.md`. It lists pass or fail per scenario with live run URLs.
4. Ship the change only if the exit code is 0 and the file says PASS. Put the
   file's text in the pull request.

The gate applies the change to lab `testing`, runs the pipeline unit tests (it
stops there if they fail), plants the bug, pushes to lab `testing` (rulesets
off for that push only), runs the scenarios, writes the result, and puts lab
`testing` back (use `--keep` to leave it).

Gate limits: it proves what the three scenarios cover. A change to something
they do not touch (a checks-failed repair, a merge conflict) needs its own
scenario or a hand-run of the workflow.

## `lab-admin.mjs`

`plant` and `unplant` put the known bug on lab `testing` and take it off. The
planted commit is never ported.
