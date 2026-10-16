import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Lab only. Fails the first time it runs in a CI job, passes the next: a deterministic flake.
test("lab flake: fails once per run", () => {
  if (!process.env.GITHUB_RUN_ID) return;
  const marker = join(tmpdir(), `lab-flake-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  if (existsSync(marker)) return;
  writeFileSync(marker, "1");
  assert.fail("lab flake: the first try always fails");
});
