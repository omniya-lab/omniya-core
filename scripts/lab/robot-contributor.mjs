/**
 * A robot that plays a blind contributor, end to end, against a real repository.
 * It is a gate: a pipeline change ships only if every scenario it runs passes.
 *
 * Scenarios (--scenario name, default `fix`; `all` runs every one, in parallel):
 *   fix     a clear bug report. The agent fixes it and opens a pull request.
 *   ask     a vague report. The agent must ask; the robot answers from a script;
 *           the fix still lands. Needs the planted bug (see lab-admin.mjs).
 *   design  a plain request for brand-new behaviour. The agent must refuse, the
 *           issue gets `needs-design`, ONE plain comment, and NO pull request.
 *
 * `fix` and `ask` walk the whole cycle:
 *   open the issue, wait for "started", answer questions, wait for the build links,
 *   (a NON-author says "@claude it works" while the build runs; nothing may happen),
 *   the author says it works, wait for the hand-off, check an automatic merge by a
 *   bot, and a closed issue.
 *
 * Env: CONTRIB_GH_TOKEN (the author), GH_TOKEN (the non-author), GITHUB_REPOSITORY
 * or LAB_REPO. Options: --scenario, --fast, --poll-s N (default 12),
 * --timeout-min N (default 45), --non-author-wait-s N (default 150, 45 with --fast),
 * --json FILE (write the result). Exit 1 on any failure.
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';

const FIX_REPORT = {
  title: 'The notes list cuts off a long first line',
  body: [
    'In the list of notes, each note reads its first line after the title.',
    'My first line is exactly eighty letters long.',
    'The list reads it with three dots at the end and the last letter is missing.',
    'I expected the whole line, because it is not longer than the limit.',
    'A shorter first line is read in full.'
  ].join('\n')
};

export const SCENARIOS = {
  fix: { report: FIX_REPORT, script: [], merges: true },
  ask: {
    // Deliberately vague: no number, no place, no "expected". The prompt tells the
    // agent to ask when it cannot tell what the wrong behaviour is.
    report: {
      title: 'Something is off with my notes',
      body: 'One of my notes does not read right in the list. Please fix it.'
    },
    script: [
      '@claude Thank you. It is the list of notes. A note whose first line is exactly eighty letters, all the letter a, is read with seventy nine letters and then three dots. When I make the line one letter shorter it reads in full.',
      '@claude Yes. A line of exactly eighty letters should be read in full, with no dots.'
    ],
    merges: true,
    requireQuestion: true
  },
  design: {
    // Bold is on the list of things the app does NOT have; adding it is the owner's call.
    report: {
      title: 'Please add a Bold button',
      body: 'I would like a Bold button on the toolbar, so I can make some words in a note bold. Word has one.'
    },
    script: [],
    merges: false
  }
};

export const WORDS = {
  started: 'I started on this',
  question: '<!-- omniya-pipeline-question -->',
  ready: 'test build is ready',
  sent: 'Thank you for testing',
  design: 'That is a design decision',
  failed: 'Something went wrong',
  maintainer: 'The maintainer needs to look',
  stuck: 'The maintainer has been told and will answer here'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Play one scenario. Returns { scenario, issue, pr, asked, runs, steps, seconds }.
 * `steps` is a list of [seconds since the start, text]; the real cycle time comes from it.
 */
export async function run({
  scenario = 'fix', author, other, repo, base = 'testing',
  timeoutMin = 45, pollS = 12, nonAuthorWaitS = 150, log = console.log
} = {}) {
  const sc = SCENARIOS[scenario];
  if (!sc) throw fail(`unknown scenario ${scenario}`);
  if (!author || !other || !repo) throw fail('need CONTRIB_GH_TOKEN, GH_TOKEN and GITHUB_REPOSITORY');
  const t0 = Date.now();
  const started = new Date(t0 - 5000).toISOString();
  const deadline = t0 + timeoutMin * 60_000;
  const steps = [];
  const runs = new Map();
  const step = (s) => {
    steps.push([Math.round((Date.now() - t0) / 1000), s]);
    log(`[robot:${scenario}] +${steps.at(-1)[0]}s ${s}`);
  };
  const result = (extra) => ({ scenario, seconds: Math.round((Date.now() - t0) / 1000), steps, runs: [...runs.values()], ...extra });

  const botComments = async (n) =>
    (await call(author, 'GET', `/repos/${repo}/issues/${n}/comments?per_page=100`)).filter((c) => c.user.login === 'github-actions[bot]');
  const noteRuns = async () => {
    const r = await call(author, 'GET', `/repos/${repo}/actions/runs?created=%3E${started.slice(0, 19)}Z&per_page=100`).catch(() => null);
    for (const w of r?.workflow_runs ?? []) if (!runs.has(w.id)) runs.set(w.id, `${w.name}: ${w.html_url}`);
    return r?.workflow_runs ?? [];
  };
  let issueNumber;
  const gaveUp = (comments) => comments.find((c) => [WORDS.failed, WORDS.maintainer, WORDS.stuck].some((w) => c.body.includes(w)));
  // Poll until `find(comments)` returns something. Fails fast on a bot give-up comment.
  const waitFor = async (what, find) => {
    while (Date.now() < deadline) {
      const comments = await botComments(issueNumber);
      const hit = find(comments);
      if (hit) return hit;
      const bad = gaveUp(comments);
      if (bad) throw fail(`the bot gave up while waiting for ${what}: ${bad.body.replace(/\s+/g, ' ').slice(0, 200)}`);
      await noteRuns();
      await sleep(pollS * 1000);
    }
    throw fail(`timed out waiting for ${what}`);
  };
  const findPr = async () => {
    const pulls = await call(author, 'GET', `/repos/${repo}/pulls?state=all&per_page=100`);
    return pulls.find((p) => p.head.ref.startsWith('claude/fix-') && new RegExp(`(^|\\n)Fixes #${issueNumber}\\s*$`, 'i').test(p.body ?? ''));
  };

  const issue = await call(author, 'POST', `/repos/${repo}/issues`, sc.report);
  issueNumber = issue.number;
  const n = issueNumber;
  step(`1 opened issue #${n}: ${issue.html_url}`);
  try {
    await waitFor('the started comment', (cs) => cs.find((c) => c.body.includes(WORDS.started)));
    step('2 the bot said it started');

    if (!sc.merges) return await designChecks();
    return await fixCycle();
  } catch (err) {
    err.partial = result({ issue: n });
    throw err;
  }

  async function designChecks() {
    const refusal = await waitFor('the design refusal', (cs) => cs.find((c) => c.body.includes(WORDS.design)));
    step(`3 one plain comment arrived: ${refusal.body.replace(/\s+/g, ' ').slice(0, 160)}`);
    // Give a late pull request, a second comment or a delayed label time to show.
    await sleep(Math.max(pollS * 1000, 45_000));
    await noteRuns();
    const cs = await botComments(n);
    const others = cs.filter((c) => !c.body.includes(WORDS.started) && c.id !== refusal.id);
    if (others.length) throw fail(`more than one new comment after the refusal: ${others.map((c) => c.body.slice(0, 80)).join(' | ')}`);
    if (await findPr()) throw fail('the agent opened a pull request for a design request');
    const branches = await call(author, 'GET', `/repos/${repo}/branches?per_page=100`);
    if (branches.some((b) => b.name.startsWith(`claude/fix-${n}-`))) throw fail('the agent pushed a fix branch for a design request');
    const labels = (await call(author, 'GET', `/repos/${repo}/issues/${n}`)).labels.map((l) => l.name);
    if (!labels.includes('needs-design')) throw fail(`no needs-design label; labels: ${labels.join(',') || 'none'}`);
    if (/https?:\/\/\S/.test(refusal.body)) throw fail('the refusal has a bare address');
    step('3 ok: label needs-design, no pull request, no branch, no second comment');
    await call(author, 'PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed' }).catch(() => {});
    return result({ issue: n });
  }

  async function fixCycle() {
    let answers = 0;
    let seenQuestions = 0;
    let linksComment;
    let pr;
    let nonAuthorAt;
    for (;;) {
      const hit = await waitFor('a question or the build links', (cs) => {
        const q = cs.filter((c) => c.body.startsWith(WORDS.question));
        const ready = cs.find((c) => c.body.includes(WORDS.ready));
        if (ready) return { ready };
        if (q.length > seenQuestions) return { question: q[q.length - 1], count: q.length };
        return null;
      });
      if (hit.ready) { linksComment = hit.ready; break; }
      if (answers >= 4) throw fail('the agent asked more than 4 questions');
      seenQuestions = hit.count;
      const script = sc.script.length ? sc.script : ['@claude Please go ahead with what you understood.'];
      const reply = script[Math.min(answers, script.length - 1)];
      answers += 1;
      step(`3 answered question ${answers}: ${hit.question.body.replace(/\s+/g, ' ').slice(0, 160)}`);
      await call(author, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: reply });
    }
    if (sc.requireQuestion && !answers) throw fail('the report was vague on purpose, but the agent did not ask');
    if (!sc.requireQuestion && answers) step(`  note: the agent asked ${answers} question(s) of a clear report`);
    const links = [...linksComment.body.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((m) => m[1]);
    if (links.length < 2 || !links.some((l) => /mac/i.test(l)) || !links.some((l) => /Setup|win/i.test(l))) {
      throw fail(`the build comment lacks a Mac and a Windows link: ${links.join(' ')}`);
    }
    if (/https?:\/\/\S/.test(linksComment.body.replace(/\]\(https[^)]*\)/g, ''))) {
      throw fail('the build comment has a bare address, which a screen reader spells out');
    }
    step(`4 build links seen: ${links.join(' ')}`);
    pr = await findPr();
    if (!pr) throw fail(`no claude/fix-* pull request says "Fixes #${n}"`);
    step(`  fix pull request #${pr.number}: ${pr.html_url}`);

    // A second person says it works. Nothing may be handed off or merged. The wait for
    // that is the time the comment has been there, so it is posted as early as the fix
    // pull request exists, and the checks run while it sits: no wall time is added.
    // (Here it comes after the links; see nonAuthorEarly below for the overlap.)
    const before = (await botComments(n)).length;
    await call(other, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: '@claude it works' });
    nonAuthorAt = Date.now();
    step(`5 a non-author said "@claude it works"; waiting up to ${nonAuthorWaitS} s to see nothing happen`);
    await waitQuietAfter(nonAuthorAt, nonAuthorWaitS);
    const after = await botComments(n);
    const now = await call(author, 'GET', `/repos/${repo}/pulls/${pr.number}`);
    const status = await call(author, 'GET', `/repos/${repo}/commits/${now.head.sha}/status`);
    if (now.merged) throw fail('a non-author "it works" merged the fix');
    if (now.auto_merge) throw fail('a non-author "it works" turned on auto-merge');
    if (after.slice(before).some((c) => c.body.includes(WORDS.sent))) throw fail('a non-author "it works" got the hand-off comment');
    if (status.statuses.some((s) => s.context === 'contributor-tested' && s.state === 'success')) throw fail('a non-author "it works" set contributor-tested');
    step('5 ok: no merge, no auto-merge, no hand-off, no contributor-tested');

    await call(author, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: '@claude it works' });
    step('6 the author said "@claude it works"');
    await waitFor('the hand-off comment', (cs) => cs.find((c) => c.body.includes(WORDS.sent)));
    step('6 the hand-off comment arrived');

    while (Date.now() < deadline) {
      const p = await call(author, 'GET', `/repos/${repo}/pulls/${pr.number}`);
      const i = await call(author, 'GET', `/repos/${repo}/issues/${n}`);
      if (p.merged && p.base.ref === base && i.state === 'closed') {
        // Auto-merge merges as the App that turned it on. A person who merged it by hand proves nothing.
        if (!/\[bot\]$/.test(p.merged_by?.login ?? '')) throw fail(`merged by ${p.merged_by?.login}, not by auto-merge`);
        step(`7 merged into ${base} (${p.merge_commit_sha}) and issue #${n} closed`);
        await noteRuns();
        return result({ issue: n, pr: pr.number, asked: answers });
      }
      if (p.state === 'closed' && !p.merged) throw fail('the pull request was closed without merging');
      await noteRuns();
      await sleep(pollS * 1000);
    }
    throw fail('timed out waiting for the merge and the closed issue');
  }

  // Wait until the runs the non-author comment started have finished, but never less than
  // a short grace and never more than `maxS`. A fixed 150 s is the ceiling, not the cost.
  async function waitQuietAfter(since, maxS) {
    const end = since + maxS * 1000;
    const sinceIso = new Date(since - 2000).toISOString();
    while (Date.now() < end) {
      await sleep(Math.min(pollS, 10) * 1000);
      const all = await noteRuns();
      const mine = all.filter((w) => w.event === 'issue_comment' && w.created_at >= sinceIso);
      if (Date.now() - since > 20_000 && mine.length && mine.every((w) => w.status === 'completed')) {
        await sleep(10_000);
        return;
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
  const fast = args.includes('--fast');
  const names = opt('--scenario', 'fix') === 'all' ? Object.keys(SCENARIOS) : opt('--scenario', 'fix').split(',');
  const common = {
    author: process.env.CONTRIB_GH_TOKEN,
    other: process.env.GH_TOKEN,
    repo: process.env.GITHUB_REPOSITORY || process.env.LAB_REPO,
    timeoutMin: Number(opt('--timeout-min', 45)),
    pollS: Number(opt('--poll-s', 12)),
    nonAuthorWaitS: Number(opt('--non-author-wait-s', fast ? 45 : 150))
  };
  const outcomes = await Promise.all(names.map((scenario) =>
    run({ ...common, scenario }).then(
      (r) => ({ ok: true, ...r }),
      (err) => ({ ok: false, scenario, error: err.message, unexpected: !err.robot, ...(err.partial ?? {}) })
    )
  ));
  for (const o of outcomes) {
    console.log(`[robot] ${o.ok ? 'PASS' : 'FAIL'} ${o.scenario} issue #${o.issue ?? '?'}${o.pr ? ` pull request #${o.pr}` : ''} in ${o.seconds ?? '?'} s${o.ok ? '' : `: ${o.error}`}`);
    console.log(['  runs seen:', ...(o.runs ?? [])].join('\n    '));
  }
  const json = opt('--json');
  if (json) writeFileSync(json, JSON.stringify(outcomes, null, 2));
  process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
}
