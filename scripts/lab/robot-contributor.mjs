/**
 * A robot that plays a blind contributor, end to end, against a real repository.
 * It is a gate: a pipeline change ships only if every scenario it runs passes.
 *
 * Scenarios (--scenario name, default `fix`; `all` runs every one, in parallel):
 *   fix     a clear bug report. The agent fixes it and opens a pull request.
 *   ask     a vague report. The agent must ask; the robot answers from a script;
 *           the fix still lands. Needs the planted bug (see lab-admin.mjs).
 *   works-but          the fix is built; the author writes "it works but ..." The words go to
 *                      the AGENT (a new bot reply, no hand-off, nothing merged).
 *   two-fixes          the fix is built; a SECOND open fix pull request claims the issue; the author's bare
 *                      "it works" must do nothing (the pipeline will not guess which fix).
 *   stranger-confirm   the fix is built; a non-author writes a bare "it works". Nothing happens.
 *   answer-to-question the agent asks a question; a bare "it works" in answer to it must NOT
 *                      hand off (no comment, no run, no pull request). Then the fix still lands.
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
 * or LAB_REPO. Options: --signoff bare|at-claude, --scenario, --fast, --poll-s N (default 12),
 * --timeout-min N (default 45), --non-author-wait-s N (default 150, 45 with --fast),
 * --expect-agent (the old code: do not require the agent job to be skipped), --json FILE (write the result). --signoff at-claude writes the old "@claude it works". Exit 1 on any failure.
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
  'two-fixes': { report: FIX_REPORT, script: [], merges: false, variant: 'two-fixes' },
  'works-but': { report: FIX_REPORT, script: [], merges: false, variant: 'works-but' },
  'stranger-confirm': { report: FIX_REPORT, script: [], merges: false, variant: 'stranger' },
  'answer-to-question': {
    report: {
      title: 'Something is off with my notes',
      body: 'One of my notes does not read right in the list. Please fix it.'
    },
    script: [
      '@claude Thank you. It is the list of notes. A note whose first line is exactly eighty letters, all the letter a, is read with seventy nine letters and then three dots. When I make the line one letter shorter it reads in full.',
      '@claude Yes. A line of exactly eighty letters should be read in full, with no dots.'
    ],
    merges: true,
    requireQuestion: true,
    bareAtQuestion: true
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
  timeoutMin = 45, pollS = 12, nonAuthorWaitS = 150, signoff = 'bare', expectAgent = false, log = console.log
} = {}) {
  const sc = SCENARIOS[scenario];
  // What the contributor writes to say it works. `bare` is the new path (no agent);
  // `at-claude` is the old one, kept so the same robot can time both.
  const SAY = signoff === 'at-claude' ? '@claude it works' : 'it works';
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
  const waitFor = async (what, find, tick) => {
    while (Date.now() < deadline) {
      const comments = await botComments(issueNumber);
      const hit = find(comments);
      if (hit) return hit;
      const bad = gaveUp(comments);
      if (bad) throw fail(`the bot gave up while waiting for ${what}: ${bad.body.replace(/\s+/g, ' ').slice(0, 200)}`);
      await noteRuns();
      if (tick) await tick();
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

    if (!sc.merges && !sc.variant) return await designChecks();
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
    let before = 0;
    // As soon as the fix pull request exists, a second person says it works. The checks and
    // the build run while that comment sits, so the check adds no wall time.
    const earlyNonAuthor = async () => {
      if (nonAuthorAt) return;
      pr = await findPr();
      if (!pr) return;
      before = (await botComments(n)).length;
      await call(other, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: SAY });
      nonAuthorAt = Date.now();
      step(`  fix pull request #${pr.number}: ${pr.html_url}; a non-author said "${SAY}"`);
    };
    for (;;) {
      const hit = await waitFor('a question or the build links', (cs) => {
        const q = cs.filter((c) => c.body.startsWith(WORDS.question));
        const ready = cs.find((c) => c.body.includes(WORDS.ready));
        if (ready) return { ready };
        if (q.length > seenQuestions) return { question: q[q.length - 1], count: q.length };
        return null;
      }, earlyNonAuthor);
      if (hit.ready) { linksComment = hit.ready; break; }
      if (answers >= 4) throw fail('the agent asked more than 4 questions');
      seenQuestions = hit.count;
      if (sc.bareAtQuestion && answers === 0) await bareAnswerChecks(hit.question);
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
    await earlyNonAuthor();
    if (!pr) throw fail(`no claude/fix-* pull request says "Fixes #${n}"`);
    step(`5 waiting up to ${nonAuthorWaitS} s since the non-author comment to see nothing happen`);
    await waitQuietAfter(nonAuthorAt, nonAuthorWaitS);
    const after = await botComments(n);
    const now = await call(author, 'GET', `/repos/${repo}/pulls/${pr.number}`);
    const status = await call(author, 'GET', `/repos/${repo}/commits/${now.head.sha}/status`);
    if (now.merged) throw fail('a non-author "it works" merged the fix');
    if (now.auto_merge) throw fail('a non-author "it works" turned on auto-merge');
    if (after.slice(before).some((c) => c.body.includes(WORDS.sent))) throw fail('a non-author "it works" got the hand-off comment');
    if (status.statuses.some((s) => s.context === 'contributor-tested' && s.state === 'success')) throw fail('a non-author "it works" set contributor-tested');
    step('5 ok: no merge, no auto-merge, no hand-off, no contributor-tested');

    if (sc.variant === 'stranger') {
      step('5 ok: a stranger cannot confirm. Closing the rehearsal.');
      await cleanUp(pr);
      return result({ issue: n, pr: pr.number });
    }
    if (sc.variant === 'works-but') return await worksButChecks(pr);
    if (sc.variant === 'two-fixes') return await twoFixesChecks(pr);

    await call(author, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: SAY });
    const saidAt = Date.now();
    step(`6 the author said "${SAY}"`);
    await waitFor('the hand-off comment', (cs) => cs.find((c) => c.body.includes(WORDS.sent)));
    const handoffS = Math.round((Date.now() - saidAt) / 1000);
    step(`6 the hand-off comment arrived ${handoffS} s after the sign-off`);

    while (Date.now() < deadline) {
      const p = await call(author, 'GET', `/repos/${repo}/pulls/${pr.number}`);
      const i = await call(author, 'GET', `/repos/${repo}/issues/${n}`);
      if (p.merged && p.base.ref === base && i.state === 'closed') {
        // Auto-merge merges as the App that turned it on. A person who merged it by hand proves nothing.
        if (!/\[bot\]$/.test(p.merged_by?.login ?? '')) throw fail(`merged by ${p.merged_by?.login}, not by auto-merge`);
        const mergedS = Math.round((Date.now() - saidAt) / 1000);
        step(`7 merged into ${base} (${p.merge_commit_sha}) and issue #${n} closed, ${mergedS} s after the sign-off`);
        await noteRuns();
        const agentJob = await signoffAgentJob(saidAt);
        if (!expectAgent && agentJob.agent !== 'skipped') throw fail(`the sign-off run did not skip the agent job: ${JSON.stringify(agentJob)}`);
        step(`7 sign-off run ${agentJob.url}: agent job ${agentJob.agent}, handoff job ${agentJob.handoff}`);
        return result({ issue: n, pr: pr.number, asked: answers, signoff: SAY, handoffS, mergedS, agentJob });
      }
      if (p.state === 'closed' && !p.merged) throw fail('the pull request was closed without merging');
      await noteRuns();
      await sleep(pollS * 1000);
    }
    throw fail('timed out waiting for the merge and the closed issue');
  }

  // The pipeline-followup run the sign-off started: was the agent job skipped, and did hand-off run?
  async function signoffAgentJob(saidAt) {
    const since = new Date(saidAt - 3000).toISOString();
    for (let i = 0; i < 6; i++) {
      const all = await noteRuns();
      const mine = all.filter((w) => w.name === 'pipeline-followup' && w.event === 'issue_comment' && w.created_at >= since && w.status === 'completed');
      for (const w of mine) {
        const jobs = (await call(author, 'GET', `/repos/${repo}/actions/runs/${w.id}/jobs?per_page=100`)).jobs;
        const by = (name) => jobs.find((j) => j.name === name)?.conclusion ?? 'absent';
        if (by('handoff') === 'success') return { url: w.html_url, agent: by('agent'), handoff: by('handoff'), jobs: jobs.map((j) => `${j.name}:${j.conclusion}`) };
      }
      await sleep(5000);
    }
    throw fail('could not find the completed sign-off run with a successful handoff job');
  }

  // A second open fix claims the same issue. The pipeline must not guess: a bare "it works" does nothing.
  async function twoFixesChecks(pr) {
    const head = (await call(other, 'GET', `/repos/${repo}/git/ref/heads/${base}`)).object.sha;
    const branch = `claude/fix-${n}-second`;
    await call(other, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
    await call(other, 'PUT', `/repos/${repo}/contents/lab-second-fix-${n}.txt`, { message: 'Lab: a second fix for the same issue', content: Buffer.from('second\n').toString('base64'), branch });
    const second = await call(other, 'POST', `/repos/${repo}/pulls`, { title: `Lab: second fix for #${n}`, head: branch, base, body: `A second fix, only to count.\n\nFixes #${n}` });
    step(`6 a second open fix claims the issue: #${second.number}`);
    const before = (await botComments(n)).length;
    const saidAt = Date.now();
    await call(author, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: SAY });
    step(`6 the author said "${SAY}" with two open fixes`);
    await waitQuietAfter(saidAt, nonAuthorWaitS);
    const now = await call(author, 'GET', `/repos/${repo}/pulls/${pr.number}`);
    const status = await call(author, 'GET', `/repos/${repo}/commits/${now.head.sha}/status`);
    const after = await botComments(n);
    const failure = now.merged || now.auto_merge ? 'a merge was turned on'
      : status.statuses.some((s) => s.context === 'contributor-tested' && s.state === 'success') ? 'contributor-tested was set'
      : after.slice(before).some((c) => c.body.includes(WORDS.sent)) ? 'the hand-off comment was posted' : '';
    await call(other, 'PATCH', `/repos/${repo}/pulls/${second.number}`, { state: 'closed' }).catch(() => {});
    await call(other, 'DELETE', `/repos/${repo}/git/refs/heads/${branch}`).catch(() => {});
    if (failure) throw fail(`with two open fixes a bare "it works" had an effect: ${failure}`);
    step('6 ok: two open fixes, a bare "it works" did nothing (no merge, no status, no comment)');
    await cleanUp(pr);
    return result({ issue: n, pr: pr.number });
  }

  async function cleanUp(pr) {
    if (pr) await call(other, 'PATCH', `/repos/${repo}/pulls/${pr.number}`, { state: 'closed' }).catch(() => {});
    await call(author, 'PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed' }).catch(() => {});
  }

  // "it works but ...": more than the bare phrase, so the AGENT reads it. A new reply must
  // come, it must not be the hand-off, and nothing may be set to merge.
  async function worksButChecks(pr) {
    const before = (await botComments(n)).length;
    const BUT = 'it works but the three dots are still read out when the line is eighty one letters long';
    // Without @claude this is not a bare confirmation and never started an agent: nothing happens.
    const quietFrom = Date.now();
    await call(author, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: BUT });
    step('6 the author said "it works but ..." with no @claude');
    await waitQuietAfter(quietFrom, 90);
    if ((await botComments(n)).length !== before) throw fail('"it works but ..." with no @claude got a reply');
    const quiet = await call(author, 'GET', `/repos/${repo}/pulls/${pr.number}`);
    if (quiet.merged || quiet.auto_merge) throw fail('"it works but ..." with no @claude turned on a merge');
    step('6 ok: with no @claude, nothing happened');
    await call(author, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: `@claude ${BUT}` });
    step('6 the author said "@claude it works but ..."');
    const wait = Date.now();
    const reply = await waitFor('a reply to "it works but"', (cs) => (cs.length > before ? cs[cs.length - 1] : null));
    // Must not be the hand-off, and the commit must not be set to merge.
    if (/omniya-pipeline-state sent/.test(reply.body)) throw fail('"it works but ..." was handed off as a confirmation');
    const now = await call(author, 'GET', `/repos/${repo}/pulls/${pr.number}`);
    const status = await call(author, 'GET', `/repos/${repo}/commits/${now.head.sha}/status`);
    if (now.merged || now.auto_merge) throw fail('"it works but ..." turned on a merge');
    if (status.statuses.some((s) => s.context === 'contributor-tested' && s.state === 'success')) throw fail('"it works but ..." set contributor-tested');
    // An agent run must have read it: the agent job lives in a pipeline-followup run that took a while.
    const all = await noteRuns();
    const mine = all.filter((w) => w.event === 'issue_comment' && w.created_at >= new Date(wait - 5000).toISOString());
    step(`6 ok: the reply came after ${Math.round((Date.now() - wait) / 1000)} s and is not a hand-off: ${reply.body.replace(/\s+/g, ' ').slice(0, 140)}`);
    if (!mine.length) throw fail('no pipeline-followup run seen for the "it works but" comment');
    await cleanUp(pr);
    return result({ issue: n, pr: pr.number });
  }

  // A bare "it works" in reply to a bot QUESTION. No pull request exists yet, and the newest
  // bot comment is a question. Nothing may happen: no comment, no pull request.
  async function bareAnswerChecks(question) {
    const before = (await botComments(n)).length;
    const sinceIso = new Date().toISOString();
    await call(author, 'POST', `/repos/${repo}/issues/${n}/comments`, { body: 'it works' });
    step('  the author answered the question with a bare "it works"');
    await sleep(Math.max(pollS * 1000, 45_000));
    const all = await noteRuns();
    const after = await botComments(n);
    if (after.length !== before) throw fail(`a bare "it works" answering a question got a reply: ${after.at(-1).body.replace(/\s+/g, ' ').slice(0, 120)}`);
    if (await findPr()) throw fail('a bare "it works" answering a question opened a fix');
    const agentRuns = all.filter((w) => w.event === 'issue_comment' && w.created_at >= sinceIso && w.conclusion && w.conclusion !== 'success' && w.conclusion !== 'skipped');
    if (agentRuns.length) throw fail('the bare "it works" run did not end cleanly');
    step('  ok: a bare "it works" in answer to a question did nothing');
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
    nonAuthorWaitS: Number(opt('--non-author-wait-s', fast ? 45 : 150)),
    signoff: opt('--signoff', 'bare'),
    expectAgent: args.includes('--expect-agent')
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
