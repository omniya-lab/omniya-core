/**
 * Merge a pipeline pull request. Most of them merge with nobody's word; a few
 * need the owner's "ship it"; the shipper itself needs the owner's bypass tick.
 *
 * Pull requests that change the automation fail the hand-off allowlist on
 * purpose, so they never merge by themselves. The `testing-tested` rule wants
 * the commit status `contributor-tested` from the App, and the only way past it
 * was the owner's bypass tick in the browser. The owner does not work in the
 * browser. The owner asked for a session to merge automation work as soon as it
 * is green, and to ask for a word only when a change touches secrets or
 * something that cannot be undone.
 *
 * THE THREE TIERS (decided here, from the files and from the changed lines):
 *   automatic  Nothing below applies. It merges when the checks are green.
 *   ship it    It touches a secret, a token, a permission, an environment, a
 *              release, a delete or a force, or a file that defines what "green"
 *              means or who may merge a contributor's fix. It merges only with
 *              the owner's words in `ownerSaid`. The words are written to the
 *              run summary. This script cannot prove the owner typed them, so
 *              this tier is a rule for the session, kept honest by the log. It
 *              is not a lock.
 *   bypass     It changes this shipper, its workflow or its tests. Refused
 *              here. Only the owner's own click in the browser merges it. That
 *              is the one lock a session cannot open, because a session could
 *              otherwise loosen the thing that decides what it may ship.
 *
 * THE PRODUCT LANE: a `product/<slug>` branch is judged by the same checks as below, then
 * by `product-lane.mjs`, which allows only `src/`, `test/` and `docs/` (never the corpus or
 * the pipeline's tests) and needs the owner's "ship it" naming the PR. Same lock, same merge.
 *
 * What makes the automatic tier safe to run without a person:
 *   - It runs from `testing` only (the environment `pipeline` allows no other
 *     ref), so a pull request cannot edit the workflow that ships it.
 *   - The workflow refuses any actor but the repository owner and the owner's
 *     session account. A contributor has write access and could start it.
 *   - Fail closed. The pull request must be open, into `testing`, from this
 *     repository, on a `pipeline/` branch, written by the owner or the session
 *     account, not a draft, and exactly MERGEABLE. Its head must be the commit
 *     the caller named, so a push after the caller looked cannot ride on it.
 *   - Every push to the branch was made by one of those two accounts. A
 *     contributor has write access and could push a commit onto a branch the
 *     session opened. Commits carry no GitHub login, so GitHub's push history is
 *     what names the pusher.
 *   - A check counts only when it is a job of the workflow file that defines it
 *     (`pr-checks.yml` for unit, nemeth and e2e, `pr-build.yml` for the two
 *     builds). A name alone is not enough: a new workflow can have a job called
 *     `unit` that always passes. Those two files are in the ship-it tier, so a
 *     pull request cannot quietly have rewritten them.
 *   - An ALLOW list, not a list of bad files. A list of bad files is never
 *     complete. Every file the pull request touches (and every name it moved
 *     from) must be plainly automation: `docs/`, `scripts/ci/`,
 *     `.github/prompts/`, `test/unit/pipeline/`, the pipeline-change skill, or a
 *     top-level workflow file. Anything else, such as `src/` or `package.json`,
 *     needs the owner's bypass tick.
 *   - The file list must be complete. GitHub stops listing at 3,000 files, and a
 *     protected file past that point would not be seen. A file whose change GitHub
 *     does not show (too large) counts as sensitive.
 *   - A pull request that deletes a test, or moves one out of `test/`, is refused.
 *   - Contributor fixes never come here. They keep their own hand-off.
 *
 * Usage (needs GH_TOKEN, MERGE_TOKEN, GITHUB_REPOSITORY, ALLOWED_AUTHORS;
 * OWNER_SAID is optional):
 *   node scripts/ci/ship-pipeline-pr.mjs <pull-request-number> <commit-sha>
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { gh as realGh, requireNumber, setOutputs } from './gh.mjs';
import { PRODUCT_PREFIX, decideProduct, readModes } from './product-lane.mjs';

export const BRANCH_PREFIX = 'pipeline/';

/** Which workflow file defines which required check. A check from any other file does not count. */
export const CHECKS_BY_WORKFLOW = {
  '.github/workflows/pr-checks.yml': ['unit', 'nemeth', 'e2e'],
  '.github/workflows/pr-build.yml': ['pack-mac', 'pack-win']
};

/**
 * BYPASS tier. Changing any of these changes who may merge what. Only the
 * owner's click in the browser merges them.
 */
export const BYPASS_FILES = [
  '.github/workflows/pipeline-ship.yml',
  'scripts/ci/ship-pipeline-pr.mjs',
  'test/unit/pipeline/ship-pipeline-pr.test.js',
  // The product zone. Changing it changes what a word can ship.
  'scripts/ci/product-lane.mjs',
  'test/unit/pipeline/product-lane.test.js'
];

/**
 * SHIP-IT tier, by file. Each decides what "green" means, who may merge a
 * contributor's fix, or what runs with a token. A bad edit here is not a bad
 * edit to one feature: it loosens the gates for every later change.
 */
export const SHIP_IT_FILES = [
  '.github/workflows/pr-checks.yml',
  '.github/workflows/pr-build.yml',
  '.github/workflows/testing-app.yml',
  'scripts/ci/gh.mjs',
  'scripts/ci/hand-off.mjs',
  'scripts/ci/allowlist.mjs',
  'test/unit/pipeline/pipeline-secrets.test.js',
  'test/unit/pipeline/hand-off.test.js'
];
// `package.json`, the lockfile, `.github/CODEOWNERS` and `.github/actions/` are not
// listed here on purpose. They are outside the allow list, so they need the owner's
// bypass tick: a changed dependency is a supply-chain change, and an action can run anything.

/**
 * SHIP-IT tier, by what a changed line says. Checked on the lines a pull request
 * adds AND the lines it removes, in workflows and in `scripts/`: removing a guard
 * is as sensitive as adding a risk. Docs, the agent prompt, the skill and tests
 * are not scanned, because they only talk about these things.
 */
export const SENSITIVE_LINES = [
  // Not `GH_TOKEN: ${{ github.token }}`: that is the built-in token, it appears in almost
  // every workflow, and it gives nothing the job's permissions do not already give.
  // `secrets.X`, `secrets['X']`, `toJSON(secrets)` and `secrets: inherit` all reach a secret.
  [/secrets\s*(\.|\[|:\s*inherit)|toJSON\(\s*secrets|_PRIVATE_KEY|MERGE_TOKEN|OAUTH_TOKEN|PERSONAL|create-github-app-token|github\.token\s*}}.*(MERGE|ADMIN)/i, 'a secret or a token'],
  // A write permission, or an App token scope. Narrowing to `read` is fine. Removing a
  // whole `permissions:` block is caught in `sensitiveIn`, because it widens to the default.
  [/\bpermission-[a-z-]+|(contents|statuses|actions|checks|pull-requests|issues|id-token|packages|workflows|deployments)\s*:\s*(write|admin)|write-all/, 'a permission'],
  [/\benvironment\s*:|vars\.PIPELINE/, 'an environment'],
  [/--admin|--force|--no-verify|push\s+(-f|--force)|\bgit\s+reset\s+--hard|\brm\s+-rf?\b/, 'a force or a hard delete'],
  [/\bgh\s+release\b|releases\/|softprops\/action-gh-release|npm\s+publish|--publish\b|electron-builder.*--publish/, 'a release or a publish'],
  [/\bgh\s+pr\s+merge\b|--auto\b.*--squash|\bgh\s+repo\b|\bgh\s+ruleset\b|\bgh\s+secret\b|\bgh\s+variable\b|rulesets|branches\/[^\s]*protection/, 'a merge, a ruleset or a setting'],
  [/(-X|--method)\s+(DELETE|PUT|PATCH)\b|\bgh\s+api\b.*\b(DELETE|PUT)\b|git\s+push\s+\S+\s+--delete|\bbranch\s+-D\b/, 'a delete or an overwrite through the API'],
  [/pull_request_target|\bworkflow_run\b|repository_dispatch/, 'a privileged trigger'],
  [/\bcurl\b|\bwget\b|\beval\b|\bbase64\b|\bnc\s+-|bash\s+<\(|\|\s*(ba)?sh\b/, 'downloaded or hidden code']
];

/**
 * The only places a shipped pull request may touch at all. Everything else needs
 * the owner's bypass tick.
 */
export const ALLOWED_PREFIXES = [
  'docs/',
  'scripts/ci/',
  '.github/prompts/',
  'test/unit/pipeline/',
  '.claude/skills/pipeline-change/'
];
// The pipeline's own workflows and the existing CI ones, by name. A workflow with any
// other name is not plainly automation, so it needs the owner's bypass tick. The ones
// that define "green" or publish builds are in the ship-it tier above, and every
// workflow is scanned line by line.
export const ALLOWED_WORKFLOW = /^\.github\/workflows\/(pipeline-[a-z0-9-]+|pr-[a-z0-9-]+|testing-app|screen-reader|diagnostics-windows)\.yml$/;
export const MAX_FILES = 3000;

/** One page of push history. A branch with more pushes than this is refused. */
export const MAX_PUSHES = 100;

// A `..` segment would let `docs/../src/main.js` start with an allowed prefix. Git
// cannot store such a path, but this must not depend on that.
export const isAllowed = (file) =>
  !file.split('/').includes('..') &&
  (ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)) || ALLOWED_WORKFLOW.test(file));

export const isBypass = (file) => BYPASS_FILES.includes(file);

// The pipeline-change skill is the session's own rulebook for when it may ship. A change to
// it is a change to the approval rules themselves, so it needs the owner's word, always.
export const SHIP_IT_PREFIXES = ['.claude/'];

export const isShipIt = (file) =>
  SHIP_IT_FILES.includes(file) || SHIP_IT_PREFIXES.some((prefix) => file.startsWith(prefix));

/**
 * Code, and the agent's prompt, are scanned line by line. The prompt steers an agent
 * that holds a token and writes code, so a line in it can matter as much as a line in
 * a workflow. Docs, the skill and tests only talk about these things, so they are not.
 */
const isScanned = (file) =>
  file.startsWith('.github/workflows/') || file.startsWith('scripts/') || file.startsWith('.github/prompts/');

/**
 * What a changed file says that needs the owner's word.
 * @param {{filename: string, patch?: string|null, status?: string}} file
 * @returns {string[]} plain reasons, empty when nothing is sensitive
 */
export function sensitiveIn(file) {
  const extra = new Set();
  // A file moved from a place that is not scanned into one that is. A pure move shows no
  // changed line, so a note in docs could become a script with nothing to read.
  if (file.previous_filename && isScanned(file.filename) && !isScanned(file.previous_filename)) {
    extra.add('a file moved into the code');
  }
  // A test that loses more lines than it gains is how a check gets made to pass. The
  // contributor hand-off treats it the same way.
  if (file.filename.startsWith('test/') && typeof file.patch !== 'string' && file.status !== 'removed' && !(file.status === 'renamed' && file.changes === 0)) {
    // Too big for GitHub to show. A test that cannot be read cannot be seen to keep its assertions.
    extra.add('a test change that GitHub does not show');
  }
  if (file.filename.startsWith('test/') && typeof file.patch === 'string') {
    const lines = file.patch.split('\n');
    // GitHub's patch has no file header, so every line that starts with + or - is a change.
    const added = lines.filter((l) => l.startsWith('+')).length;
    const removed = lines.filter((l) => l.startsWith('-')).length;
    if (removed > added) extra.add('a test that loses more lines than it gains');
  }
  if (!isScanned(file.filename)) return [...extra];
  if (typeof file.patch !== 'string') {
    // GitHub leaves out the change of a very large or binary file. It cannot be read, so it cannot be trusted.
    // Only a pure move (GitHub counts zero changed lines) has nothing to show. A removed
    // guard, or a renamed file with edits, whose change is not shown, cannot be read.
    return file.status === 'renamed' && file.changes === 0
      ? [...extra]
      : [...extra, `a change to ${file.filename} that GitHub does not show`];
  }
  // No file header in GitHub's patch, so a line that starts with `+++` or `---` is a change like any other.
  const changed = file.patch.split('\n').filter((line) => line.startsWith('+') || line.startsWith('-'));
  const found = new Set(extra);
  for (const [pattern, why] of SENSITIVE_LINES) {
    if (changed.some((line) => pattern.test(line))) found.add(why);
  }
  // Taking a `permissions:` block away makes the job fall back to the wider default.
  if (changed.some((line) => /^-\s*permissions\s*:/.test(line))) found.add('a permission');
  return [...found];
}

/**
 * @param {Array<{id:number, path:string, created_at:string, conclusion:string|null}>} runs workflow runs on the commit
 * @param {(id: number) => Array<{name:string, conclusion:string|null}>} jobsOf the jobs of one run
 * @returns {string[]} required check names that are not green
 */
export function notGreen(runs, jobsOf) {
  const missing = [];
  for (const [path, names] of Object.entries(CHECKS_BY_WORKFLOW)) {
    const newest = runs
      .filter((run) => run.path === path)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    const jobs = newest && newest.conclusion === 'success' ? jobsOf(newest.id) : [];
    for (const name of names) {
      if (!jobs.some((job) => job.name === name && job.conclusion === 'success')) missing.push(name);
    }
  }
  return missing;
}

/**
 * @param {object} input
 * @param {object} input.pr
 * @param {string} input.sha
 * @param {string[]} input.allowedAuthors
 * @param {string[]} input.missing check names that are not green
 * @param {string[]} [input.pushers] login of every push to the branch
 * @param {number} [input.pushCount]
 * @param {Array<{filename: string, previous_filename?: string|null, status?: string, patch?: string|null}>} [input.files]
 * @param {string} [input.ownerSaid] the owner's own words, when a "ship it" was given
 * @returns {{ship: true, tier: 'automatic'|'ship-it', why: string[]} | {ship: false, reason: string}}
 */
export function decide({ pr, sha, allowedAuthors, missing, pushers = [], pushCount = 0, files = [], ownerSaid = '', modes = null }) {
  if (pr.state !== 'OPEN') return { ship: false, reason: 'the pull request is not open' };
  if (pr.baseRefName !== 'testing') return { ship: false, reason: 'it does not go into testing' };
  if (pr.isCrossRepository !== false) return { ship: false, reason: 'it comes from a fork' };
  const product = String(pr.headRefName).startsWith(PRODUCT_PREFIX);
  if (!product && !String(pr.headRefName).startsWith(BRANCH_PREFIX)) {
    return { ship: false, reason: `the branch starts with neither ${BRANCH_PREFIX} nor ${PRODUCT_PREFIX}` };
  }
  if (!allowedAuthors.includes(pr.author?.login)) {
    return { ship: false, reason: "its author is not the owner or the owner's session account" };
  }
  if (pr.isDraft) return { ship: false, reason: 'it is a draft' };
  if (String(pr.mergeable).toUpperCase() !== 'MERGEABLE') return { ship: false, reason: 'GitHub does not say it can merge cleanly' };
  if (pr.headRefOid !== sha) return { ship: false, reason: 'the branch moved after the caller looked' };
  if (pushCount >= MAX_PUSHES) return { ship: false, reason: 'too many pushes to check who made them' };
  const stranger = pushers.find((login) => !allowedAuthors.includes(login));
  if (stranger !== undefined || pushers.length === 0) {
    return { ship: false, reason: 'someone other than the owner or the session account pushed to the branch' };
  }
  if (pr.changedFiles !== files.length || files.length >= MAX_FILES) {
    return { ship: false, reason: 'the list of changed files is not complete, so a protected file could be hidden' };
  }

  // The product lane: the same checks above, then its own file rule (`product-lane.mjs`).
  if (product) {
    return decideProduct({ files, modes, missing, number: pr.number, ownerSaid, says: /\bship\s*it\b/i.test(String(ownerSaid)) });
  }

  const names = files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean);

  const lock = names.filter(isBypass);
  if (lock.length > 0) {
    return { ship: false, reason: `it changes the shipper (${lock.join(', ')}), so it needs the owner's bypass tick in the browser` };
  }
  const outside = names.filter((name) => !isAllowed(name));
  if (outside.length > 0) {
    return { ship: false, reason: `it changes more than the automation (${outside.slice(0, 3).join(', ')}), so it needs the owner's bypass tick in the browser` };
  }
  const lostTest = files.find(
    (f) =>
      (f.status === 'removed' && f.filename.startsWith('test/')) ||
      (f.previous_filename?.startsWith('test/') && !f.filename.startsWith('test/'))
  );
  if (lostTest) {
    return { ship: false, reason: `it deletes or moves a test (${lostTest.previous_filename ?? lostTest.filename}), so it needs the owner's bypass tick in the browser` };
  }
  if (missing.length > 0) return { ship: false, reason: `not green on that commit: ${missing.join(', ')}` };

  const why = [
    ...names.filter(isShipIt).map((name) => `it changes ${name}, which decides what green means or who may merge`),
    ...files.flatMap((file) => sensitiveIn(file).map((what) => `${file.filename} touches ${what}`))
  ];
  if (why.length === 0) return { ship: true, tier: 'automatic', why: [] };
  // The words must say it. Any three characters would pass "no way", "not yet" or "wait".
  if (!/\bship\s*it\b/i.test(String(ownerSaid))) {
    return { ship: false, reason: `it needs the owner's "ship it": ${[...new Set(why)].join('; ')}` };
  }
  return { ship: true, tier: 'ship-it', why: [...new Set(why)] };
}

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * @param {{pr: string|number, sha: string, repo: string, allowedAuthors: string[], mergeToken: string, ownerSaid?: string}} args
 * @param {(args: string[], opts?: {token?: string}) => string} [gh]
 * @param {(ms: number) => void} [sleep]
 */
export function ship({ pr, sha, repo, allowedAuthors, mergeToken, ownerSaid = '' }, gh = realGh, sleep = wait) {
  const number = requireNumber(pr, 'pull request number');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`sha must be 40 hex characters, got: ${sha}`);
  if (!mergeToken) throw new Error('MERGE_TOKEN is not set. Refusing to ship without it.');

  const view = JSON.parse(
    gh([
      'pr', 'view', number, '--repo', repo, '--json',
      'number,state,baseRefName,isCrossRepository,headRefName,headRefOid,author,isDraft,mergeable,changedFiles'
    ])
  );
  // Runs are found by commit, and each is tied to the workflow FILE it came from.
  const runs = JSON.parse(
    gh([
      'api', '--method', 'GET', `repos/${repo}/actions/runs`, '-f', `head_sha=${sha}`, '-f', 'per_page=100',
      '--jq', '[.workflow_runs[] | {id, path, created_at, conclusion}]'
    ])
  );
  const jobsOf = (id) =>
    JSON.parse(
      gh([
        'api', '--method', 'GET', `repos/${repo}/actions/runs/${requireNumber(id, 'run id')}/jobs`, '-f', 'per_page=100',
        '--jq', '[.jobs[] | {name, conclusion}]'
      ])
    );

  const pushes = JSON.parse(
    // The branch name goes in as a parameter, never into the URL text. A branch
    // name may hold `&`, and `&actor=omniya-bot` would filter a stranger's pushes out.
    gh([
      'api', '--method', 'GET', `repos/${repo}/activity`,
      '-f', `ref=refs/heads/${view.headRefName}`, '-f', `per_page=${MAX_PUSHES}`,
      '--jq', '[.[] | {a: .actor.login}]'
    ])
  );
  const files = gh(['api', `repos/${repo}/pulls/${number}/files`, '--paginate', '--jq', '.[] | {filename, previous_filename, status, patch, changes, additions, deletions}'])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const decision = decide({
    pr: view,
    sha,
    allowedAuthors,
    missing: notGreen(runs, jobsOf),
    pushers: pushes.map((push) => push.a),
    pushCount: pushes.length,
    files,
    ownerSaid,
    modes: view.headRefName.startsWith(PRODUCT_PREFIX) ? readModes({ repo, sha, gh }) : null
  });
  if (!decision.ship) return { shipped: false, reason: decision.reason };

  // The lock, posted as the App: a branch workflow cannot post as the App.
  gh([
    'api', `repos/${repo}/statuses/${sha}`,
    '-f', 'state=success', '-f', 'context=contributor-tested', '-f', `description=Shipped from chat (${decision.tier})`
  ], { token: mergeToken });

  let last = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      gh(['pr', 'merge', number, '--repo', repo, '--squash', '--match-head-commit', sha], { token: mergeToken });
      return { shipped: true, reason: 'merged', tier: decision.tier, why: decision.why };
    } catch (error) {
      last = String(error.stderr ?? error.message ?? error);
      sleep(5000);
    }
  }
  throw new Error(`could not merge #${number}: ${last}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [pr, sha] = process.argv.slice(2);
  const ownerSaid = process.env.OWNER_SAID ?? '';
  const result = ship({
    pr,
    sha: sha ?? '',
    repo: process.env.GITHUB_REPOSITORY,
    allowedAuthors: (process.env.ALLOWED_AUTHORS ?? '').split(',').filter(Boolean),
    mergeToken: process.env.MERGE_TOKEN,
    ownerSaid
  });
  setOutputs({ shipped: result.shipped });
  // The log of who allowed what. For the ship-it tier, the owner's own words.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = result.shipped
      ? [`Shipped #${pr} (${result.tier}).`, ...(result.why ?? []).map((w) => `- ${w}`), ...(result.tier !== 'automatic' ? [`The owner said: ${JSON.stringify(ownerSaid)}`] : [])]
      : [`Did not ship #${pr}: ${result.reason}`];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
  console.log(result.shipped ? `shipped #${pr} (${result.tier})` : `did not ship #${pr}: ${result.reason}`);
  if (!result.shipped) process.exitCode = 1;
}
