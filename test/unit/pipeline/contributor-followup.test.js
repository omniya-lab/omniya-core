import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load as loadYaml } from 'js-yaml';

const PATH = '.github/workflows/pipeline-followup.yml';
const source = readFileSync(PATH, 'utf8');
const workflow = loadYaml(source);

// The file explains its own rules in comments, so a comment can say the exact
// string a "this must not appear" assertion is looking for. Searching `code`
// rather than `source` is what keeps the assertion about the workflow instead
// of about the prose around it.
const code = source
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

// `on:` parses as the boolean true in YAML 1.1, because `on` is one of its
// reserved truthy words. Reach the trigger by whichever key survived rather
// than asserting one and getting a confusing undefined.
const triggers = workflow.on ?? workflow[true];

const AGENT = './.github/workflows/pipeline-agent.yml';
const VERIFY = './.github/workflows/pipeline-verify.yml';

const allowlistJob = workflow.jobs?.allowlist;

test('only a @claude comment on an ISSUE starts a run', () => {
  // Three filters, and each is load-bearing for a different reason. This test is
  // what notices when a later edit drops one of them.
  assert.deepEqual(triggers?.issue_comment?.types, ['created']);

  assert.equal(triggers?.workflow_call, undefined, 'it holds its own trigger and is not called');
  // The first job's `if` is the cheap filter: a comment that cannot cost anything
  // skips every job behind it.
  for (const condition of [allowlistJob?.if ?? '']) {
    // `issue.pull_request` exists only when the comment is on a pull request. The
    // contributor writes on the issue, so this is the NEGATION of the old rule:
    // a comment on a pull request is the maintainer's conversation.
    assert.match(condition, /!github\.event\.issue\.pull_request/, 'a comment on a pull request must not start a run');
    // `@claude` is what makes a comment cost anything.
    assert.match(condition, /contains\(\s*github\.event\.comment\.body\s*,\s*'@claude'\s*\)/, 'only a comment naming @claude may spend a run');
    // The status comment and the agent's own comments are by a bot, and one of
    // them quotes `@claude`.
    assert.match(condition, /github\.event\.comment\.user\.type\s*!=\s*'Bot'/, 'a bot comment must not start a run');
  }
});

test('the allowlist gate runs before anything is installed', () => {
  assert.ok(allowlistJob, 'expected an `allowlist` job');

  // The decision about whether to spend somebody's subscription quota must not
  // wait on an install that can fail, be slow, or be tampered with.
  const runs = (allowlistJob.steps ?? []).map((s) => s.run ?? '').join('\n');
  const uses = (allowlistJob.steps ?? []).map((s) => s.uses ?? '').join('\n');
  assert.doesNotMatch(runs, /npm ci|npm install|brew install/, 'the gate must not wait on an install');
  assert.doesNotMatch(uses, /setup-node/, 'the gate must not wait on a toolchain');
  assert.match(runs, /scripts\/ci\/allowlist\.mjs/, 'the gate must be the allowlist script');
  assert.equal(allowlistJob.steps.find((s) => s.id === 'check').env.COMMENT_AUTHOR, '${{ steps.issue.outputs.author }}');
  // The `issue` step is where the author comes from: the comment's author, or on a rehearsal the issue's.
  assert.equal(allowlistJob.steps.find((s) => s.id === 'issue').env.EVENT_AUTHOR, '${{ github.event.comment.user.login }}');

  // And the expensive job must actually wait on it. A `needs` without the `if`,
  // or an `if` without the `needs`, both read as gated and are not.
  const agent = workflow.jobs.agent;
  assert.ok([].concat(agent.needs).includes('allowlist'), 'the agent job must need the allowlist job');
  assert.match(agent.if, /needs\.allowlist\.outputs\.allowed\s*==\s*'true'/, 'and run only when the gate said true');
});

test('exactly one open fix is continued, and no fix is answered in words', () => {
  // The gate finds the fix for this issue with the one shared helper.
  const find = allowlistJob.steps.find((s) => s.id === 'find');
  assert.match(find.if, /^steps\.check\.outputs\.allowed == 'true'/, 'no lookup for a person the gate refused');
  assert.match(find.if, /steps\.access\.outputs\.access != 'false'/, 'nor for one the agent action would refuse');
    assert.match(find.run, /find-fix-pr\.mjs/);
  assert.doesNotMatch(code, /isCrossRepository/, 'the strict rule lives in the helper, not in a fourth copy');

  assert.match(workflow.jobs.agent.if, /needs\.allowlist\.outputs\.count\s*==\s*'1'/, 'two candidates are not guessed between');

  // Silence is the failure this repository has had once already.
  const nofix = workflow.jobs.nofix;
  assert.match(nofix.if, /count\s*!=\s*'1'/);
  assert.match(nofix.if, /resume\s*!=\s*'true'/, 'a comment that answers a question is not "no fix found"');
  assert.ok(nofix.steps.some((s) => /gh issue comment/.test(s.run ?? '')), 'the contributor is told');
  assert.doesNotMatch(JSON.stringify(nofix.steps), /claude-code-action/, 'saying so costs no quota');
});

test('an answer to the agent\'s question starts the fix, once, and only when a question is open', () => {
  // The label is the memory. The pipeline sets `needs-info` when the agent asks
  // and takes it off here, before the agent starts, so a second comment while the
  // run is going is not taken for another answer.
  const resume = allowlistJob.steps.find((s) => s.id === 'resume');
  assert.match(resume.if, /count == '0'/, 'with a fix open, a comment is a revision, not an answer');
  assert.match(resume.run, /needs-info/);
  assert.match(resume.run, /omniya-pipeline-question/);
  // The design lock. A label can be added by anybody with write access, so it
  // is not enough on its own, and a `needs-design` issue never resumes for a
  // contributor. The owner's own comment is the one thing that lifts it.
  assert.match(resume.run, /\*,needs-design,\*\) ;;/, 'needs-design is checked before needs-info, and does nothing');
  assert.match(resume.run, /\[ "\$\{asked:-0\}" -ge 1 \] && resume=true/, 'a real question from the agent must exist');
  assert.ok(resume.run.indexOf('needs-design') < resume.run.indexOf('*,needs-info,*'));
  assert.equal(workflow.jobs['resume-start'].steps.at(-1).run.includes('--remove-label needs-info'), true);
  assert.match(workflow.jobs['resume-start'].if, /resume == 'true'/);
  assert.match(workflow.jobs['resume-start'].if, /access != 'false'/);

  const job = workflow.jobs.resume;
  assert.equal(job.uses, AGENT);
  assert.equal(job.with.mode, 'fix');
  assert.equal(job.with.question_round, '${{ needs.allowlist.outputs.question_round }}');
  assert.deepEqual(job.secrets, { CLAUDE_CODE_OAUTH_TOKEN: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}", PIPELINE_APP_PRIVATE_KEY: "${{ secrets.PIPELINE_APP_PRIVATE_KEY }}" }, "secrets are passed by name");
  assert.equal(job.permissions?.actions, undefined, 'the agent never holds `actions`');

  // The agent can open the pull request this time, so the same checks follow.
  assert.equal(workflow.jobs['resume-verify'].if, "needs.resume.outputs.result == 'opened'");
  assert.equal(workflow.jobs['resume-verify'].with.pr_number, '${{ needs.resume.outputs.pr }}');

  // And every other ending is told, with the same script the first round uses.
  const outcome = workflow.jobs['resume-outcome'];
  assert.match(outcome.steps.at(-1).run, /fix-outcome\.mjs/);
  assert.match(outcome.if.replace(/\s+/g, ' '), /needs\.resume\.outputs\.result == 'asked'/);
  assert.match(outcome.if.replace(/\s+/g, ' '), /needs\.resume\.outputs\.result == 'blocked'/);
  assert.doesNotMatch(outcome.if, /stopped/);
});

test('the owner\'s comment is the go-ahead for a design idea, and nobody else\'s is', () => {
  // Issue #73: the owner wrote "start a fix" on a design idea and the pipeline
  // answered "could not find exactly one fix in progress". The owner had no way to say yes.
  const owner = allowlistJob.steps.find((s) => s.id === 'owner');
  assert.ok(owner, 'expected a step that reads who wrote the comment');
  // GitHub fills this in from the repository. Nobody can type it into a comment.
  assert.equal(owner.env.ASSOCIATION, '${{ github.event.comment.author_association || steps.issue.outputs.association }}');
  // The approval belongs to THIS comment, by id. A comment a contributor adds
  // while the run waits in the queue must not inherit it.
  assert.equal(owner.env.COMMENT_ID, '${{ github.event.comment.id }}');
  assert.match(owner.run, /comment_id=\$COMMENT_ID/);
  assert.equal(allowlistJob.outputs.owner_comment_id, '${{ steps.owner.outputs.comment_id }}');
  // And for the text as the owner wrote it: an edit afterwards voids the approval.
  assert.equal(owner.env.COMMENT_AT, '${{ github.event.comment.updated_at }}');
  assert.equal(allowlistJob.outputs.owner_comment_updated_at, '${{ steps.owner.outputs.comment_updated_at }}');
  assert.match(owner.run, /\[ "\$ASSOCIATION" = "OWNER" \]/);
  assert.doesNotMatch(owner.run, /\$\{\{/, 'nothing from the comment text reaches the command');
  assert.equal(allowlistJob.outputs.owner, '${{ steps.owner.outputs.owner }}');

  // With no fix open, the owner resumes whatever the labels say. A contributor still cannot.
  const resume = allowlistJob.steps.find((s) => s.id === 'resume');
  assert.equal(resume.env.IS_OWNER, '${{ steps.owner.outputs.owner }}');
  assert.match(resume.run, /\[ "\$IS_OWNER" = "true" \]/);
  assert.ok(resume.run.indexOf('IS_OWNER') < resume.run.indexOf('*,needs-design,*'), 'the owner is decided before the labels');
  assert.match(resume.if, /count == '0'/, 'with a fix open, the comment is a revision');

  // The label that locked the issue comes off with the one that said "waiting".
  const start = workflow.jobs['resume-start'].steps.at(-1).run;
  assert.match(start, /--remove-label needs-design/);
  assert.match(start, /--remove-label needs-info/);
  assert.match(start, /\|\| true/, 'a label that is not there must not fail the start');

  // Both agent calls are told, so it does not answer `needs-design` to a decision already made.
  for (const name of ['agent', 'resume']) {
    assert.equal(workflow.jobs[name].with.owner_comment_id, '${{ needs.allowlist.outputs.owner_comment_id }}', name);
    assert.equal(workflow.jobs[name].with.owner_comment_updated_at, '${{ needs.allowlist.outputs.owner_comment_updated_at }}', name);
    assert.equal(workflow.jobs[name].with.owner_go_ahead, undefined, 'a flag with no comment attached is the race this closes');
  }
});

test('a listed contributor who cannot write is told, and the job is red', () => {
  const noaccess = workflow.jobs.noaccess;
  assert.match(noaccess.if, /access == 'false'/);
  assert.match(noaccess.steps[0].run, /exit 1/);
  assert.match(workflow.jobs.agent.if, /access != 'false'/);
  assert.match(allowlistJob.steps.find((s) => s.id === 'access').env.ACTOR, /github\.actor/);
  assert.match(allowlistJob.steps.find((s) => s.id === 'access').env.ACTOR, /workflow_dispatch[^|]*steps\.issue\.outputs\.author/, 'a rehearsal checks the issue author, not whoever pressed the button');
});

test('a follow-up run is bounded, and shares the fix workflow group', () => {
  // One run per issue. A second comment queues behind the first instead of
  // racing it. And it is the SAME group as `pipeline-fix.yml`, so a comment that
  // arrives during a fix or a repair waits for it: they push to one branch.
  const group = workflow.concurrency?.group ?? '';
  assert.match(group, /github\.event\.issue\.number/);
  assert.match(group, /^contributor-issue-/);
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false, 'a killed run can leave half a revision on the branch');

  // The agent's own limits (timeout, turns, subscription token) are in the shared
  // file and tested there.
  assert.equal(workflow.jobs.agent.uses, AGENT);
  assert.equal(workflow.jobs.agent.with.mode, 'comment');
  assert.deepEqual(workflow.jobs.agent.secrets, { CLAUDE_CODE_OAUTH_TOKEN: "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}", PIPELINE_APP_PRIVATE_KEY: "${{ secrets.PIPELINE_APP_PRIVATE_KEY }}" }, "secrets are passed by name");
});

test('the loop cannot feed itself', () => {
  // This file pushes, which rebuilds, which writes to the issue. The status
  // comment and the agent's comments are by `github-actions[bot]`, and the
  // status comment quotes `@claude`.
  assert.match(allowlistJob.if, /github\.event\.comment\.user\.type\s*!=\s*'Bot'/);
  // `isAllowed` in the allowlist script refuses `*[bot]` too, a step later.
  // And nothing else starts this workflow. A `pull_request` trigger would fire
  // on the push this file makes.
  assert.equal(triggers?.pull_request, undefined);
  assert.equal(triggers?.push, undefined);
  assert.equal(triggers?.issues, undefined);
});

test('no untrusted comment text reaches a run step', () => {
  // Comment bodies, issue titles and issue bodies are written by whoever typed
  // them. Only the NUMBER is safe, because GitHub guarantees it is an integer.
  // The comment body appears in the `if:` conditions, which are not a shell.
  const unsafe = /\$\{\{\s*github\.event\.(comment\.body|issue\.(title|body))\b/;
  assert.doesNotMatch(source, unsafe, 'the agent reads the thread itself; it is never pasted in');
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      assert.doesNotMatch(step.run, /\$\{\{\s*github\.event\./, `run step must take event data through env, not inline: ${step.run}`);
    }
  }
});

test('a revision is checked and rebuilt, and an answer is not', () => {
  // A push made with the bot's token starts no `pull_request` run, so without
  // this job a revision would never be checked or rebuilt and the contributor's
  // links would keep serving the old build.
  const verify = workflow.jobs.verify;
  assert.equal(verify.uses, VERIFY);
  assert.equal(verify.if, "needs.agent.outputs.result == 'revised'", 'rebuilding on a question spends two packaging jobs on a reply');
  // No "I am changing the fix" comment. The contributor's own comment started the
  // round, and the one reply they hear is the new build, which says it is the
  // same links.
  assert.equal(verify.with.reply_state, 'revised');
  assert.equal(verify.with.message, '${{ needs.agent.outputs.message }}');
  assert.equal(verify.with.status_before, undefined);
  assert.equal(verify.with.pr_number, '${{ needs.agent.outputs.pr }}');
  assert.equal(verify.with.branch, '${{ needs.agent.outputs.branch }}');
  // The one allowed command starts the update that brings a conflicting fix up to date
  // (`bring-up-to-date`, a job with no secret). Nothing here starts checks by hand.
  assert.doesNotMatch(source, /gh workflow run(?! pipeline-keep-current\.yml)/, 'verify starts the checks');
});

test('an answer, a design refusal and a block each get one comment, with the agent words inside', () => {
  const reply = workflow.jobs.reply;
  assert.ok(reply, 'expected a `reply` job');
  const condition = reply.if.replace(/\s+/g, ' ');
  for (const word of ['answered', 'needs-design', 'blocked']) {
    assert.match(condition, new RegExp(`needs\\.agent\\.outputs\\.result == '${word}'`), word);
  }
  assert.doesNotMatch(condition, /stopped/);
  assert.doesNotMatch(condition, /'revised'|'approved'/, 'a revision is announced by the build, and approval by the hand-off');
  const step = reply.steps.find((s) => /reply\.mjs/.test(s.run ?? ''));
  assert.equal(step.env.MESSAGE, '${{ needs.agent.outputs.message }}');
  assert.doesNotMatch(step.run, /\$\{\{/, 'agent text must never be written into a run line');
  assert.match(step.run, /STATE=design/);
  assert.match(step.run, /blocked\) STATE=stuck/);
  assert.doesNotMatch(step.run, /gh issue|gh label/, 'the script labels the issue, once');
  assert.equal(reply.steps[0].with?.ref, undefined, 'the default checkout is `testing`');
  assert.doesNotMatch(JSON.stringify(reply.steps), /claude-code-action/, 'saying so costs no quota');
});

test('the kind is read from the labels, and a routed report is read as a bug by the agent', () => {
  const step = workflow.jobs.allowlist.steps.find((s) => s.id === 'kind');
  assert.ok(step, 'expected a step that reads the kind');
  assert.match(step.run, /issue-kind\.mjs/);
  assert.match(step.run, /\|\| echo "kind=bug" >> "\$GITHUB_OUTPUT"/, 'an unreadable label must not fail the gate');
  assert.equal(workflow.jobs.allowlist.permissions.issues, 'read');
  assert.equal(workflow.jobs.agent.with.kind, "${{ needs.allowlist.outputs.kind == 'nemeth' && 'nemeth' || 'bug' }}");
});

test('"it works" runs the hand-off: the status and the merge both use the App token', () => {
  const handoff = workflow.jobs.handoff;
  const condition = handoff.if.replace(/\s+/g, ' ');
  assert.match(condition, /needs\.agent\.outputs\.result == 'approved'/);
  assert.match(condition, /github\.event_name == 'issue_comment'/, 'a rehearsal never reaches the hand-off');
  assert.match(condition, /github\.event\.comment\.user\.login == github\.event\.issue\.user\.login/, 'only the issue author can say it works');
  assert.match(condition, /github\.event\.comment\.author_association == 'OWNER'/, 'or the owner');
  const run = handoff.steps.map((s) => s.run ?? '').join('\n');
  assert.match(run, /scripts\/ci\/hand-off\.mjs "\$ISSUE" "\$PR"/);
  const checkout = handoff.steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout'));
  assert.equal(checkout.with?.ref, undefined, 'the default checkout is `testing`');
  assert.doesNotMatch(code, /gh pr merge|--admin|--auto/, 'the merge is in hand-off.mjs, behind its decision, and nowhere in the workflow');
  assert.equal(handoff.permissions?.actions, undefined);
  assert.equal(handoff.permissions?.statuses, undefined, 'the built-in token no longer posts the status');
  assert.equal(handoff.environment, 'pipeline');
  assert.equal(handoff.permissions?.checks, 'read');
  assert.equal(handoff.permissions?.['pull-requests'], 'write');
  assert.equal(handoff.permissions?.issues, 'write');
  assert.equal(handoff.permissions?.contents, 'read');
  const app = handoff.steps.find((s) => s.id === 'app');
  assert.match(app.uses, /^actions\/create-github-app-token@[0-9a-f]{40}$/);
  assert.match(app.with['app-id'], /vars\.PIPELINE_APP_ID/);
  assert.match(app.with['private-key'], /secrets\.PIPELINE_APP_PRIVATE_KEY/);
  assert.equal(app.with['permission-contents'], 'write');
  assert.equal(app.with['permission-pull-requests'], 'write');
  assert.equal(app.with['permission-issues'], 'read');
  assert.equal(app.with['permission-statuses'], 'write', 'the App posts contributor-tested');
  assert.equal(app.with['permission-workflows'], undefined, 'the App never gets Workflows');
  const hand = handoff.steps.find((s) => (s.run ?? '').includes('hand-off.mjs'));
  assert.equal(hand.env.GH_TOKEN, '${{ github.token }}', 'the built-in token still does the comments and labels');
  assert.equal(hand.env.MERGE_TOKEN, '${{ steps.app.outputs.token }}');
});

test('the agent cannot start, cancel or re-run workflows', () => {
  assert.equal(workflow.permissions?.actions, undefined, 'not at workflow level');
  assert.equal(workflow.jobs.agent.permissions?.actions, undefined, 'not in the job that runs the agent');
  assert.deepEqual(workflow.jobs.agent.permissions, { contents: 'write', 'pull-requests': 'write', issues: 'read' });
  assert.doesNotMatch(
    JSON.stringify([workflow.jobs.verify, workflow.jobs.handoff].map((j) => j.steps ?? [])),
    /claude-code-action/,
    'a job that can start workflows must not run an agent'
  );
});

test('a crashed agent run is told, without rewriting the comment that holds the links', () => {
  // Without this the contributor wrote `@claude` and heard nothing at all.
  const failed = workflow.jobs.failed;
  assert.ok(failed, 'expected a `failed` job');
  assert.match(failed.if, /!cancelled\(\)/, 'a status function, or the failed agent job would skip this one too');
  assert.match(failed.if, /needs\.agent\.result == 'failure'/);
  const run = failed.steps.map((s) => s.run ?? '').join('\n');
  assert.match(run, /gh issue comment/);
  assert.match(run, /needs-owner/);
  // The earlier links still work, and an earlier comment still holds them.
  assert.doesNotMatch(run, /status-comment\.mjs|reply\.mjs/);
  assert.match(run, /earlier download links still work/);
  assert.doesNotMatch(JSON.stringify(failed.steps), /claude-code-action/, 'saying so costs no quota');
});

test("the pipeline's own comments never start a run, even when a person posts them", () => {
  // Measured on issue #22. The status comment and the notice both say `@claude`.
  // They were posted by hand under the maintainer's name, which is a person and
  // not a Bot, so the bot filter let them through and each started an agent run.
  assert.match(
    allowlistJob.if,
    /!contains\(\s*github\.event\.comment\.body\s*,\s*'<!-- omniya-pipeline-'\s*\)/,
    'the gate must skip a comment carrying a pipeline marker'
  );
});

test('a session can rehearse a contributor comment by hand, and every check still applies', () => {
  // `workflow_dispatch` acts as if the issue's AUTHOR had written `comment_body`.
  const dispatch = triggers?.workflow_dispatch;
  assert.ok(dispatch, 'expected a hand-started trigger');
  assert.deepEqual(Object.keys(dispatch.inputs), ['issue_number', 'comment_body']);
  assert.equal(dispatch.inputs.issue_number.required, true);
  assert.equal(dispatch.inputs.comment_body.required, true);
  assert.equal(dispatch.inputs.comment_body.type, 'string');
  // Same rules as a real comment: it must name @claude, and must not be the pipeline's own text.
  const condition = allowlistJob.if.replace(/\s+/g, ' ');
  assert.match(condition, /workflow_dispatch' && \(github\.actor == \(vars\.OWNER_LOGIN \|\| github\.repository_owner\) \|\| github\.actor == \(vars\.BOT_LOGIN \|\| 'omniya-bot'\)\) && contains\(inputs\.comment_body, '@claude'\) && !contains\(inputs\.comment_body, '<!-- omniya-pipeline-'\)/, 'only the owner or the owner\'s bot can start a rehearsal');
  assert.match(condition, /issue_comment' && !github\.event\.issue\.pull_request/, 'a real comment keeps all of its filters');
  // The author is read from GitHub, the number must be digits, and the body never reaches a command line.
  const issue = allowlistJob.steps.find((s) => s.id === 'issue');
  assert.match(issue.run, /issue_number must be digits/);
  assert.match(issue.run, /pull_request == null/, 'a pull request number is refused');
  assert.match(issue.run, /rehearsal/, 'a rehearsal runs only on an issue labelled rehearsal');
  assert.match(issue.run, /was not opened by the owner/, 'a label alone is not enough: anyone with write access can add one');
  // A rehearsal must never reach the hand-off, which can enable a merge.
  assert.match(workflow.jobs.handoff.if.replace(/\s+/g, ' '), /github\.event_name == 'issue_comment'/);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      assert.doesNotMatch(step.run ?? '', /inputs\.comment_body/, 'the body is never interpolated into a run line');
    }
  }
  // The allowlist and the access check are the same steps, now fed the issue author.
  assert.equal(allowlistJob.steps.find((s) => s.id === 'check').env.COMMENT_AUTHOR, '${{ steps.issue.outputs.author }}');
  assert.equal(workflow.concurrency.group, 'contributor-issue-${{ github.event.issue.number || inputs.issue_number }}');
});
