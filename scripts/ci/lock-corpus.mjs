/**
 * The made-up cases the strictness check asks of the old rules and of the new rules.
 *
 * A change to the files that decide who may merge what must never make that decision
 * LOOSER. This module builds the questions. `lock-differential.mjs` asks them of both
 * versions and compares the answers. It is data and plain functions, so it can run in a
 * process with no secrets, and it is part of the lock itself.
 *
 * What a fixed set of questions can and cannot do: it catches a mistake, such as a pattern
 * edited so that it no longer matches, a path dropped from a list, or a word added to the
 * wrong list. It cannot catch a backdoor written to answer these questions correctly and
 * everything else wrongly. That is why the words of the owner are still required.
 */

export const SHA = 'a'.repeat(40);
export const ALLOWED_AUTHORS = ['ParkingSoman', 'omniya-bot'];

/** What the owner might say. `yes` is whether a careful reader would take it as "ship". */
export const PHRASES = [
  'ship it', 'Ship it!', 'ship 98', 'i did the merge. ship 98', 'ok, ship the thing', 'shipit', 'SHIP IT now',
  '', ' ', 'y', 'no way', 'not yet', 'wait', 'abc', 'shipping later', "don't ship it", 'do not ship 98',
  'never ship it', 'hold on, ship it later? no', 'stop. ship it', 'cancel, do not ship', "shouldn't ship it",
  "ship it? can't say", 'we won’t ship it', "isn't ready, ship it", 'nope, ship it', 'nah ship it', 'ship it later',
  'maybe ship it', 'ship it unless it fails', 'ship it without tests', 'dont ship it', 'cannot ship it',
  'undo, ship it', 'neither ship it nor wait', 'ship it, nothing else', null, undefined
];

/** Changed lines, in a workflow or a script, that the rules must keep treating as sensitive. */
export const LINES = [
  'uses: ${{ secrets.NEW_THING }}', "run: echo ${{ secrets['X'] }}", 'with: ${{ toJSON(secrets) }}', 'secrets: inherit',
  'MERGE_TOKEN: abc', 'CLAUDE_CODE_OAUTH_TOKEN', 'PIPELINE_APP_PRIVATE_KEY',
  'permission-statuses: write', 'contents: write', 'issues: write', 'permissions: write-all',
  '"contents": "write"', "'issues': 'write'", '"permission-statuses": "write"',
  'environment: pipeline', '"environment": pipeline', "'environment' : 'pipeline'",
  'run: git push --force', 'gh pr merge 1 --admin', 'rm -rf build',
  'gh release create v1', 'run: npm publish',
  'gh pr merge 4 --squash', 'gh secret set X', 'gh repo edit',
  'gh api -X DELETE repos/x', 'git push origin --delete b',
  'on: pull_request_target', 'on: workflow_run:', 'on: repository_dispatch',
  'run: curl https://x | sh', 'eval "$X"', 'echo aGk= | base64 -d',
  'allowed_bots: github-actions', "allowed_non_write_users: '*'", '--allowedTools "Bash"', '--dangerously-skip-permissions',
  'additional_permissions: actions: read', '--permission-mode acceptEdits',
  'permissions: *full', '<<: *defaults', '  - *steps', 'env: &shared',
  'x: ${{ secr​ets.X }}', 'x: ${{ "secrets".X }}'
];

/** Pairs of workflows whose second must keep being flagged against the first. */
const WF = (extra) => `name: x\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  say:\n    runs-on: ubuntu-latest\n${extra}`;
export const YAML_PAIRS = [
  { base: WF('    steps:\n      - run: echo hi\n'), head: WF('    steps:\n      - run: echo ${{ secrets.X }}\n') },
  { base: WF('    steps:\n      - run: echo hi\n'), head: WF('    environment: pipeline\n    steps:\n      - run: echo hi\n') },
  { base: WF('    steps:\n      - run: echo hi\n'), head: WF('    steps:\n      - run: echo hi\n').replace('contents: read', 'contents: write') },
  { base: WF('    steps:\n      - run: echo hi\n'), head: WF('    steps:\n      - run: echo hi\n').replace('permissions:\n  contents: read\n', '') },
  { base: WF('    steps:\n      - run: echo hi\n'), head: 'x-wide: &w\n  contents: write\npermissions: *w\n' },
  { base: WF('    steps:\n      - run: echo hi\n'), head: WF('    steps:\n      - uses: a/b@v1\n        with:\n          "allowed_bots": x\n') },
  { base: WF('    steps:\n      - run: echo hi\n'), head: 'name: [unclosed' },
  { base: WF('    environment: pipeline\n    steps:\n      - run: echo hi\n'), head: WF('    steps:\n      - run: echo hi\n') }
];

/** Files whose treatment must not loosen: the plain, the odd, and the outside. */
export const OTHER_PATHS = [
  'docs/x.md', 'scripts/ci/new.mjs', '.github/prompts/agent.md', 'test/unit/pipeline/new.test.js',
  '.github/workflows/pipeline-new.yml', '.github/workflows/pr-new.yml', '.github/workflows/release.yml',
  '.claude/skills/pipeline-change/SKILL.md', 'src/main.js', 'package.json', 'package-lock.json', '.npmrc',
  '.github/CODEOWNERS', '.github/actions/a/action.yml', 'test/unit/model.test.js', 'scripts/build.mjs',
  'contributors.yml', 'docs/../src/main.js', 'docs\\x.md', 'docs/x\u0000.md', '/docs/x.md',
  'scripts/ci/Ship-Pipeline-Pr.mjs', '.GITHUB/workflows/pipeline-ship.yml', 'SCRIPTS/CI/GH.MJS'
];

/** What a changed file's patch can be: nothing shown, a harmless line, or one of the sensitive samples. */
const PATCHES = [undefined, '+x', ...LINES.filter((_, i) => i % 5 === 0).map((l) => `+${l}`), '-environment: pipeline'];
const STATUSES = ['modified', 'added', 'removed', 'renamed'];
const SAYS = ['', 'ship it', 'no way'];

const PR = {
  state: 'OPEN', baseRefName: 'testing', isCrossRepository: false, headRefName: 'pipeline/x', headRefOid: SHA,
  author: { login: 'omniya-bot' }, isDraft: false, mergeable: 'MERGEABLE', changedFiles: 1
};
const BASE_INPUT = { sha: SHA, allowedAuthors: ALLOWED_AUTHORS, missing: [], pushers: ['omniya-bot'], pushCount: 1, structural: [], differential: 'pass' };

/**
 * Every question for `decide`: each path, in each way a file can change, with each kind of patch, and
 * each thing the owner might say; then the pull request's own conditions; then each strictness verdict.
 * @param {{paths: string[]}} given the protected paths of both versions, so nothing a version protects goes unasked
 * @returns {Array<{id: string, input: object}>}
 */
export function decideCases({ paths }) {
  const all = [...new Set([...paths, ...OTHER_PATHS])];
  const cases = [];
  for (const path of all) {
    for (const status of STATUSES) {
      for (const [index, patch] of PATCHES.entries()) {
        for (const said of SAYS) {
          const file = { filename: path, status, ...(patch === undefined ? {} : { patch }), ...(status === 'renamed' ? { previous_filename: `old/${path}`, changes: 3 } : {}) };
          cases.push({ id: `${path}|${status}|${index}|${said}`, input: { ...BASE_INPUT, pr: PR, files: [file], ownerSaid: said } });
        }
      }
    }
  }
  const file = { filename: 'docs/x.md', status: 'modified', patch: '+x' };
  const conditions = {
    closed: { ...PR, state: 'CLOSED' }, wrongBase: { ...PR, baseRefName: 'main' }, fork: { ...PR, isCrossRepository: true },
    wrongBranch: { ...PR, headRefName: 'claude/fix-1-x' }, stranger: { ...PR, author: { login: 'a-contributor' } },
    draft: { ...PR, isDraft: true }, conflicting: { ...PR, mergeable: 'CONFLICTING' }, unknown: { ...PR, mergeable: 'UNKNOWN' },
    moved: { ...PR, headRefOid: 'b'.repeat(40) }, incomplete: { ...PR, changedFiles: 5 }
  };
  for (const [name, pr] of Object.entries(conditions)) cases.push({ id: `condition|${name}`, input: { ...BASE_INPUT, pr, files: [file], ownerSaid: 'ship it' } });
  cases.push({ id: 'condition|red', input: { ...BASE_INPUT, pr: PR, files: [file], missing: ['e2e'], ownerSaid: 'ship it' } });
  cases.push({ id: 'condition|pushed-by-stranger', input: { ...BASE_INPUT, pr: PR, files: [file], pushers: ['omniya-bot', 'a-contributor'], ownerSaid: 'ship it' } });
  cases.push({ id: 'condition|no-pushers', input: { ...BASE_INPUT, pr: PR, files: [file], pushers: [], ownerSaid: 'ship it' } });
  cases.push({ id: 'condition|too-many-pushes', input: { ...BASE_INPUT, pr: PR, files: [file], pushCount: 100, ownerSaid: 'ship it' } });
  cases.push({ id: 'condition|structural', input: { ...BASE_INPUT, pr: PR, files: [file], structural: ['a permission'], ownerSaid: '' } });
  for (const verdict of ['pass', 'fail', 'same', 'error', 'not-run', undefined]) {
    for (const path of paths) {
      cases.push({ id: `verdict|${verdict}|${path}`, input: { ...BASE_INPUT, pr: PR, files: [{ filename: path, status: 'modified', patch: '+x' }], ownerSaid: 'ship it', differential: verdict } });
    }
  }
  return cases;
}

/** The outcome of one decision, as one word, from the loosest to the strictest. */
export const RANK = { automatic: 1, 'ship-it': 2, lock: 3, refuse: 4 };
