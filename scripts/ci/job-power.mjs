/**
 * Which jobs of a workflow hold power, and what they may run. Read as YAML, never by
 * a pattern over the text of the file.
 *
 * A job holds POWER when it can write to the repository or reach a secret:
 *   - a `permissions` value of `write` (its own, or the workflow's, or none at all:
 *     a job with no permissions at all gets the repository default, which is write)
 *   - an `environment` (the secrets live there)
 *   - any secret other than the built-in token, or a step that makes an App token
 *
 * A job with power may run ONLY `gh`, `git` and a file under `scripts/ci/`, besides plain
 * shell tools. So nothing in the AUTOMATIC zone (the app, its tests, the scripts that build it)
 * can ever execute in a job that has power: `npm`, `npx`, `node some-other-file`, a local
 * action, `bash file`, PowerShell and the like are not on the list. The list is of command
 * names that may stand where a command stands. Anything not on it is a violation.
 *
 * The shell is read by splitting a `run` script into commands. It is deliberately simple and
 * deliberately strict: it cannot be fooled into allowing a command, only into refusing one.
 */

import { load } from 'js-yaml';

/** Names that run no repository file: tools of the runner image and shell builtins. */
export const PLAIN_TOOLS = new Set([
  'echo', 'printf', 'set', 'export', 'test', '[', '[[', 'cat', 'head', 'tail', 'tr', 'sed', 'cut', 'wc',
  'sort', 'uniq', 'grep', 'sleep', 'date', 'mkdir', 'rm', 'cp', 'mv', 'jq', 'od', 'basename', 'dirname',
  'true', 'false', 'exit', 'cd', 'read', 'local', 'return', 'tee', 'unset', 'trap', ':', 'break', 'continue'
]);

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'esac', '{', '}', '!', 'while', 'until']);

/** A repository file this lane may run: `scripts/ci/<name>.mjs`, also from the trusted copy of `testing`. */
export const CI_SCRIPT = /^"?(?:\$RUNNER_TEMP\/trusted\/|\$T\/)?scripts\/ci\/[a-z0-9-]+\.mjs"?$/;

/**
 * Walk a script once: drop quoted text, comments and heredoc bodies, and set aside every
 * `$( ... )` and back-tick body, wherever it sits, as a script of its own.
 * @returns {{code: string, inner: string[]}}
 */
function scan(script) {
  const text = String(script).replace(/\\\r?\n/g, ' ');
  let code = '';
  const inner = [];
  const heredocs = [];
  let i = 0;
  const closing = (from, open, close) => {
    let depth = 0;
    for (let j = from; j < text.length; j += 1) {
      if (text[j] === '\\') j += 1;
      else if (text[j] === open) depth += 1;
      else if (text[j] === close) {
        depth -= 1;
        if (depth === 0) return j;
      }
    }
    return text.length - 1;
  };
  const substitution = () => {
    if (text.startsWith('$(', i)) {
      const end = closing(i + 1, '(', ')');
      inner.push(text.slice(i + 2, end));
      i = end + 1;
      return true;
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      inner.push(text.slice(i + 1, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end + 1;
      return true;
    }
    return false;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      i = end < 0 ? text.length : end + 1;
      code += 'Q';
    } else if (c === '"') {
      // The text stays, so a path in quotes can be read; its spaces and operators are hidden from the splitter.
      i += 1;
      let quoted = '';
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          quoted += '\u0001';
          i += 2;
        } else if (!substitution()) {
          quoted += /[\s;&|()<>]/.test(text[i]) ? '\u0001' : text[i];
          i += 1;
        } else {
          quoted += 'X';
        }
      }
      i += 1;
      code += `"${quoted}"`;
    } else if (c === '\\') {
      i += 2;
      code += 'Q';
    } else if (c === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (substitution()) {
      code += 'X';
    } else if (text.startsWith('<<', i) && text[i + 2] !== '<') {
      const doc = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(i));
      if (doc) {
        heredocs.push(doc[2]);
        i += doc[0].length;
      } else {
        code += c;
        i += 1;
      }
    } else if (c === '\n' && heredocs.length) {
      i += 1;
      for (const delimiter of heredocs.splice(0)) {
        for (;;) {
          const eol = text.indexOf('\n', i);
          const line = text.slice(i, eol < 0 ? text.length : eol);
          i = eol < 0 ? text.length : eol + 1;
          if (line.trim() === delimiter || i >= text.length) break;
        }
      }
      code += '\n';
    } else {
      code += c;
      i += 1;
    }
  }
  return { code, inner };
}

/**
 * @param {string} script a `run` value
 * @returns {string[][]} each command as its words, the first being the command name
 */
export function commandsOf(script) {
  const { code, inner } = scan(script);
  const commands = [];
  const functions = new Set([...code.matchAll(/(?:^|[\n;{])\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)/g)].map((m) => m[1]));
  const flat = code.replace(/(^|\n|;;|\sin)\s*[^\s()=]+\)\s+/g, '$1 ').replace(/\)\s*\{/g, ' ');
  for (const part of flat.split(/\n|;|&&|\|\||\||\(|\)|(?<![<>])&(?!>)/)) {
    let words = part.trim().split(/\s+/).filter(Boolean);
    for (;;) {
      // A `case` header can carry the first command after its first label: `case "$X" in npm ci ;;`.
      if (words[0] === 'case') words = words.slice(words.indexOf('in') + 1);
      else if (words.length && (KEYWORDS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words = words.slice(1);
      else if (words.length && /^[0-9]*[<>]/.test(words[0])) words = words.slice(/^[0-9]*[<>]+&?[0-9-]*$/.test(words[0]) ? 2 : 1);
      else break;
    }
    if (words.length === 0) continue;
    // Loop and case headers hold words, not commands: `for x in a b`, `case "$X" in`.
    if (words.length === 0 || words[0] === 'for' || words[0] === 'in' || words[0] === 'function') continue;
    if (functions.has(words[0])) continue;
    commands.push(words);
  }
  for (const body of inner) commands.push(...commandsOf(body));
  return commands;
}

/** @returns {string|null} why this command may not run in a job that has power */
export function whyNotAllowed(words) {
  const [name, ...args] = words;
  if (name === 'gh' || name === 'git') return null;
  if (name === 'node') {
    return args.length > 0 && CI_SCRIPT.test(args[0]) ? null : `node runs ${args[0] ?? 'nothing'}, which is not a file under scripts/ci/`;
  }
  if (PLAIN_TOOLS.has(name)) return null;
  return `${name} is not gh, git or a file under scripts/ci/`;
}

const isWrite = (permissions) => permissions === 'write-all' || (permissions && typeof permissions === 'object' && Object.values(permissions).includes('write'));

/**
 * @param {object} workflow a parsed workflow
 * @param {string} name the job key
 * @returns {string[]} the reasons this job holds power, empty when it holds none
 */
export function powerOf(workflow, name) {
  const job = workflow.jobs[name];
  const reasons = [];
  const effective = job.permissions ?? workflow.permissions;
  if (effective === undefined) reasons.push('no permissions are stated, so it gets the repository default');
  else if (isWrite(effective)) reasons.push('it can write');
  if (job.environment !== undefined) reasons.push('it reads an environment, which holds secrets');
  const text = JSON.stringify(job);
  const secrets = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).filter((s) => s !== 'GITHUB_TOKEN');
  if (secrets.length) reasons.push(`it reads ${[...new Set(secrets)].join(', ')}`);
  if (/create-github-app-token/.test(text)) reasons.push('it makes an App token');
  return reasons;
}

/**
 * Every way a job with power breaks the rule.
 * @returns {string[]}
 */
export function violationsOf(workflow, name) {
  const job = workflow.jobs[name];
  if (powerOf(workflow, name).length === 0) return [];
  const out = [];
  for (const [index, step] of (job.steps ?? []).entries()) {
    const where = `step ${index + 1}${step.name ? ` (${step.name})` : ''}`;
    if (typeof step.uses === 'string' && step.uses.startsWith('./')) out.push(`${where}: runs a local action, which is a file of the repository`);
    if (typeof step.run === 'string') {
      const shell = step.shell ?? job.defaults?.run?.shell ?? 'bash';
      if (!/^bash\b/.test(shell)) out.push(`${where}: the shell is ${shell}, which this check cannot read`);
      else for (const words of commandsOf(step.run)) {
        const why = whyNotAllowed(words);
        if (why) out.push(`${where}: ${why}`);
      }
    }
  }
  return out;
}

/** @returns {Array<{job: string, power: string[], violations: string[]}>} one row per job */
export function readWorkflow(text) {
  const workflow = load(String(text));
  return Object.keys(workflow.jobs ?? {}).map((job) => ({ job, power: powerOf(workflow, job), violations: violationsOf(workflow, job) }));
}
