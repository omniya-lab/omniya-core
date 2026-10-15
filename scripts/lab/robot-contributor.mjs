/**
 * A robot that plays a blind contributor, end to end, against a real repository.
 *
 * It is a gate: a pipeline change ships only if this exits 0.
 *
 * Steps (each prints one line; any failure prints FAIL and exits 1):
 *   1. open an issue in plain words, as the test contributor
 *   2. wait for the bot's "started" comment
 *   3. answer any question the agent asks, from the prepared script (SCRIPT)
 *   4. wait for the comment with the test-build links
 *   5. a NON-author says "@claude it works": nothing may merge or be handed off
 *   6. the author says "@claude it works": wait for the hand-off comment
 *   7. the fix pull request merged into the base branch, and the issue closed
 *
 * Env: CONTRIB_GH_TOKEN (the author), GH_TOKEN (the second commenter),
 *      GITHUB_REPOSITORY or LAB_REPO. Options: --title, --body, --timeout-min.
 * Everything it posts is plain text. It never uses a token for anything else.
 *
 * Usage: node scripts/lab/robot-contributor.mjs [--keep-going]
 */

import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY || process.env.LAB_REPO;

export const REPORT = {
  title: 'The notes list cuts off a long first line',
  body: [
    'In the list of notes, each note reads its first line after the title.',
    'My first line is exactly eighty letters long.',
    'The list reads it with three dots at the end and the last letter is missing.',
    'I expected the whole line, because it is not longer than the limit.',
    'A shorter first line is read in full.'
  ].join('\n')
};

/** What the contributor says if the agent asks. Used in order, then repeated. */
export const SCRIPT = [
  '@claude Thank you. The first line is exactly eighty letters, all the letter a. The note list reads seventy nine letters and then three dots. When I make the line one letter shorter it reads in full.',
  '@claude Yes, that is what I mean. A line of exactly eighty letters should be read in full, with no dots.'
];

export const WORDS = {
  started: 'I started on this',
  question: '<!-- omniya-pipeline-question -->',
  ready: 'test build is ready',
  sent: 'Thank you for testing',
  failed: 'Something went wrong',
  maintainer: 'The maintainer needs to look',
  stuck: 'The maintainer has been told and will answer here'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seenRuns = new Map();

async function call(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function fail(message) {
  const err = new Error(message);
  err.robot = true;
  return err;
}

export async function run({ author, other, repo, base = 'testing', timeoutMin = 45, log = console.log } = {}) {
  if (!author || !other || !repo) throw fail('need CONTRIB_GH_TOKEN, GH_TOKEN and GITHUB_REPOSITORY');
  const started = new Date(Date.now() - 5000).toISOString();
  const deadline = Date.now() + timeoutMin * 60_000;
  const step = (s) => log(`[robot] ${s}`);

  const botComments = async (n) =>
    (await call(author, 'GET', `/repos/${repo}/issues/${n}/comments?per_page=100`)).filter(
      (c) => c.user.login === 'github-actions[bot]'
    );
  const noteRuns = async () => {
    const r = await call(author, 'GET', `/repos/${repo}/actions/runs?created=%3E${started.slice(0, 19)}Z&per_page=50`).catch(() => null);
    for (const w of r?.workflow_runs ?? []) {
      if (!seenRuns.has(w.id)) {
        seenRuns.set(w.id, w.html_url);
      }
    }
  };
  // Poll until `find(comments)` returns something. Fails fast on a bad bot word.
  const waitFor = async (n, what, find, ignore = 0) => {
    while (Date.now() < deadline) {
      const comments = await botComments(n);
      const bad = comments.find((c) => [WORDS.failed, WORDS.maintainer, WORDS.stuck].some((w) => c.body.includes(w)));
      if (bad) throw fail(`the bot gave up while waiting for ${what}: ${bad.body.replace(/\s+/g, ' ').slice(0, 200)}`);
      const hit = find(comments);
      if (hit) return hit;
      await noteRuns();
      await sleep(15_000);
    }
    throw fail(`timed out waiting for ${what}`);
  };

  const issue = await call(author, 'POST', `/repos/${repo}/issues`, REPORT);
  const n = issue.number;
  step(`1 opened issue #${n}: ${issue.html_url}`);

  await waitFor(n, 'the started comment', (cs) => cs.find((c) => c.body.includes(WORDS.started)));
  step('2 the bot said it started');

  // Rounds: answer a question, or stop when the links arrive.
  let answers = 0;
  let seenQuestions = 0;
  let linksComment;
  for (;;) {
    const hit = await waitFor(n, 'a question or the build links', (cs) => {
      const q = cs.filter((c) => c.body.startsWith(WORDS.question));
      const ready = cs.find((c) => c.body.includes(WORDS.ready));
      if (ready) return { ready };
      if (q.length > seenQuestions) return { question: q[q.length - 1], count: q.length };
      return null;
    });
    if (hit.ready) { linksComment = hit.ready; break; }
    if (answers >= 4) throw fail('the agent asked more than 4 questions');
    seenQuestions = hit.count;
    const reply = SCRIPT[Math.min(answers, SCRIPT.length - 1)];
    answers += 1;
    step(`3 answered question ${answers}: ${hit.question.body.replace(/\s+/g, ' ').slice(0, 160)}`);
    await call(author, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: reply });
  }
  const links = [...linksComment.body.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((m) => m[1]);
  if (links.length < 2 || !links.some((l) => /mac/i.test(l)) || !links.some((l) => /Setup|win/i.test(l))) {
    throw fail(`the build comment lacks a Mac and a Windows link: ${links.join(' ')}`);
  }
  if (/https?:\/\/\S/.test(linksComment.body.replace(/\]\(https[^)]*\)/g, ''))) {
    throw fail('the build comment has a bare address, which a screen reader spells out');
  }
  step(`4 build links seen: ${links.join(' ')}`);

  const pulls = await call(author, 'GET', `/repos/${repo}/pulls?state=all&per_page=100`);
  const pr = pulls.find((p) => p.head.ref.startsWith('claude/fix-') && new RegExp(`(^|\\n)Fixes #${n}\\s*$`, 'i').test(p.body ?? ''));
  if (!pr) throw fail(`no claude/fix-* pull request says "Fixes #${n}"`);
  step(`  fix pull request #${pr.number}: ${pr.html_url}`);

  // A second person says it works. Nothing may be handed off or merged.
  const before = (await botComments(n)).length;
  await call(other, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: '@claude it works' });
  step('5 a non-author said "@claude it works"; waiting 150 s to see nothing happen');
  await sleep(150_000);
  await noteRuns();
  const after = await botComments(n);
  const now = await call(author, 'GET', `/repos/${repo}/pulls/${pr.number}`);
  const status = await call(author, 'GET', `/repos/${repo}/commits/${now.head.sha}/status`);
  if (now.merged) throw fail('a non-author "it works" merged the fix');
  if (now.auto_merge) throw fail('a non-author "it works" turned on auto-merge');
  if (after.slice(before).some((c) => c.body.includes(WORDS.sent))) throw fail('a non-author "it works" got the hand-off comment');
  if (status.statuses.some((s) => s.context === 'contributor-tested' && s.state === 'success')) throw fail('a non-author "it works" set contributor-tested');
  step('5 ok: no merge, no auto-merge, no hand-off, no contributor-tested');

  // The author says it works.
  await call(author, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: '@claude it works' });
  step('6 the author said "@claude it works"');
  await waitFor(n, 'the hand-off comment', (cs) => cs.find((c) => c.body.includes(WORDS.sent)));
  step('6 the hand-off comment arrived');

  while (Date.now() < deadline) {
    const p = await call(author, 'GET', `/repos/${repo}/pulls/${pr.number}`);
    const i = await call(author, 'GET', `/repos/${repo}/issues/${n}`);
    if (p.merged && p.base.ref === base && i.state === 'closed') {
      // Auto-merge merges as the App that turned it on. A person who merged it by hand proves nothing.
      if (!/\[bot\]$/.test(p.merged_by?.login ?? '')) throw fail(`merged by ${p.merged_by?.login}, not by auto-merge`);
      step(`7 merged into ${base} (${p.merge_commit_sha}) and issue #${n} closed`);
      await noteRuns();
      return { issue: n, pr: pr.number, runs: [...seenRuns.values()] };
    }
    if (p.state === 'closed' && !p.merged) throw fail('the pull request was closed without merging');
    await noteRuns();
    await sleep(20_000);
  }
  throw fail('timed out waiting for the merge and the closed issue');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const t = args.indexOf('--timeout-min');
  try {
    const out = await run({
      author: process.env.CONTRIB_GH_TOKEN,
      other: process.env.GH_TOKEN,
      repo: REPO,
      timeoutMin: t >= 0 ? Number(args[t + 1]) : 45
    });
    console.log(`[robot] PASS issue #${out.issue}, pull request #${out.pr}`);
    console.log(['[robot] runs seen:', ...out.runs].join('\n  '));
  } catch (err) {
    console.log(`[robot] FAIL ${err.robot ? '' : '(unexpected) '}${err.message}`);
    console.log(['[robot] runs seen:', ...seenRuns.values()].join('\n  '));
    process.exit(1);
  }
}
