/**
 * Run a command; if it fails, run it ONE more time. A pass on the second try is a pass.
 *
 * Why. Some tests fail on a busy runner and pass on the next try (seen live:
 * test/e2e/word-flow.test.js:83, a 5 s wait, and test/e2e/menu-undo.test.js:31, a 'Then more.'
 * timing). Such a failure says nothing about the fix, so it must not reach the repair agent, a
 * label, or the owner. A real failure fails both tries and stays red, so no check is weaker.
 *
 * The first try's output stays in the log. When the second try passes, ONE plain line goes to the
 * run summary naming the test, and nobody is told. Nothing here needs a token or a permission.
 *
 * Usage:
 *   node scripts/ci/retry-once.mjs [--limit-min N] <command> [args...]
 *
 * A command that is killed by a signal or cannot start is not retried, with one exception: a try that
 * runs past `--limit-min N` is a HANG (the e2e suite can hang on a runner with no display session,
 * see docs/nemeth-v2/HANDOFF.md). It is stopped at N minutes and counts as a failure, so the second try
 * still fits inside the job's own timeout (two tries of N minutes must be shorter than it).
 *
 *   node scripts/ci/retry-once.mjs --limit-min 18 npm run test:e2e
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const KEEP = 200_000;

/**
 * The test that failed, in one plain name, from the output of a failed run: a file and line when
 * there is one, else the title of the first failing test, else nothing.
 * @param {string} output
 */
export function flakedTest(output) {
  const at = /\b(test\/[\w./-]+\.test\.m?js:\d+)/.exec(output);
  if (at) return at[1];
  const title = /^\W*not ok \d+ - (.+?)\s*$/m.exec(output);
  return title ? title[1] : '';
}

/** @returns {Promise<{code: number|null, output: string, hung?: boolean}>} */
function once(command, args, limitMs = 0) {
  return new Promise((resolve) => {
    // Its own process group, so that a hang can be stopped with everything the command started.
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: process.platform !== 'win32' });
    let output = '';
    let hung = false;
    const timer = limitMs > 0 ? setTimeout(() => {
      hung = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, limitMs) : null;
    const keep = (chunk, sink) => {
      sink.write(chunk);
      output = (output + chunk).slice(-KEEP);
    };
    child.stdout.on('data', (c) => keep(c, process.stdout));
    child.stderr.on('data', (c) => keep(c, process.stderr));
    child.on('error', (error) => resolve({ code: null, output: String(error.message) }));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: hung ? 124 : code, output, hung });
    });
  });
}

/**
 * @param {string[]} argv the command and its arguments
 * @param {{run?: typeof once, say?: (line: string) => void, summary?: (line: string) => void, label?: string}} [io]
 * @returns {Promise<number>} the exit code to use
 */
export async function retryOnce(argv, { run = once, say = console.log, summary = () => {}, label = '', limitMs = 0 } = {}) {
  const [command, ...args] = argv;
  if (!command) throw new Error('usage: retry-once.mjs <command> [args...]');
  const first = await run(command, args, limitMs);
  if (first.code === 0) return 0;
  // Killed, or never started: there was no test to be unlucky.
  if (first.code === null) return 1;
  const test = flakedTest(first.output);
  say(`\nFirst try ${first.hung ? 'hung and was stopped' : `failed (exit ${first.code})`}${test ? `, at ${test}` : ''}. Trying once more.\n`);
  const second = await run(command, args, limitMs);
  if (second.code === 0) {
    const line = `A test ${first.hung ? 'hung' : 'failed'} once and passed on the second try, so the change was left alone: ${test || `\`${argv.join(' ')}\``}${label ? ` (${label})` : ''}.`;
    say(`\n${line}\n`);
    summary(line);
    return 0;
  }
  say('\nThe second try failed too. This is a real failure.\n');
  return second.code ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const summary = (line) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  let argv = process.argv.slice(2);
  let limitMs = 0;
  if (argv[0] === '--limit-min') {
    limitMs = Number(argv[1]) * 60_000;
    if (!(limitMs > 0)) throw new Error('--limit-min needs a number of minutes');
    argv = argv.slice(2);
  }
  process.exitCode = await retryOnce(argv, { summary, label: process.env.GITHUB_JOB ?? '', limitMs });
}
