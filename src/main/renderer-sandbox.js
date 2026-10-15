/**
 * Whether the window's renderer runs in Chromium's own sandbox.
 *
 * Always yes, with one test-only exception. A session that runs the app inside an
 * outer macOS sandbox (`sandbox-exec`) cannot also start Chromium's sandbox:
 * macOS refuses a second, tighter profile ("sandbox initialization failed:
 * Operation not permitted"), and the renderer never starts. That run sets
 * OMNIYA_NO_RENDERER_SANDBOX=1 and the outer sandbox does the confinement instead.
 *
 * The switch only counts when OMNIYA_TEST_USER_DATA_DIR is also set. A normal run
 * has no test data folder, so a stray variable in someone's shell cannot turn the
 * renderer sandbox off for a person's real notes.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function rendererSandboxEnabled(env = process.env) {
  const isolatedTestRun = Boolean(env.OMNIYA_TEST_USER_DATA_DIR);
  return !(isolatedTestRun && env.OMNIYA_NO_RENDERER_SANDBOX === '1');
}
