import test from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lab only. The first try in a job hangs forever; the second passes.
test("lab hang: hangs once per run", async () => {
  if (!process.env.GITHUB_RUN_ID) return;
  const marker = join(tmpdir(), `lab-hang-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  if (existsSync(marker)) return;
  writeFileSync(marker, "1");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
