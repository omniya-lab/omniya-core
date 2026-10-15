/**
 * The two things every pipeline script does with GitHub: run `gh`, and hand a
 * value to the next step of the job.
 *
 * `gh` is run without a shell, so an argument that holds a comment body, a
 * branch name or a log is one argument and never a command. That is the whole
 * reason these scripts call `execFileSync` and not `execSync`.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/**
 * @param {string[]} args
 * @param {{ token?: string }} [options] a token for this one call, in place of GH_TOKEN
 * @returns {string} stdout
 */
export function gh(args, { token } = {}) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
}

/**
 * Write step outputs. Values must be one line: a multi-line value needs a
 * delimiter, and nothing here needs one.
 *
 * @param {Record<string, string | number | boolean>} outputs
 */
export function setOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => {
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error(`output ${key} must be one line`);
    return `${key}=${text}`;
  });
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

/** The digits-only rule every number that reaches a command line must pass. */
export function requireNumber(value, name) {
  if (!/^[0-9]+$/.test(String(value ?? ''))) throw new Error(`${name} must be digits, got: ${value}`);
  return String(value);
}
