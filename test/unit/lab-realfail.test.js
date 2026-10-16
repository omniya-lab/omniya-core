import assert from "node:assert/strict";
import test from "node:test";

// Lab only. Always fails when run in CI: a real failure must stay red after the second try.
test("lab real failure", () => {
  if (process.env.GITHUB_RUN_ID) assert.fail("lab: this is a real failure");
});
