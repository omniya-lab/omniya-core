import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load as loadYaml } from 'js-yaml';

const PATH = '.github/workflows/pr-build.yml';
const source = readFileSync(PATH, 'utf8');
const workflow = loadYaml(source);

const triggers = workflow.on ?? workflow[true];

test('a new push replaces the assets under the same tag', () => {
  // This workflow's own comment tells the contributor, in writing:
  //
  //   "If this pull request changes again, these links stay the same and the
  //    files behind them are replaced. Download again rather than looking for
  //    a new link."
  //
  // That sentence is the reason `pipeline-followup.yml` pushes to the pull
  // request's branch instead of opening a second one. So it is not a nicety --
  // it is the contract the follow-up loop is built on top of, and it holds only
  // if all four things below stay true together.
  //
  // The contributor is blind and is the only person with a braille display. A
  // link that silently stops being the current build costs her a test round she
  // cannot get back, and she has no way to tell a stale asset from a bad fix.

  // 1. A push to an open pull request rebuilds at all. Without `synchronize`
  //    the follow-up run pushes and nothing happens: the thread keeps the links
  //    it had, still pointing at the first build.
  assert.ok(
    (triggers?.pull_request?.types ?? []).includes('synchronize'),
    'a push to the branch must rebuild, or the follow-up loop hands back a stale build'
  );
  assert.deepEqual(triggers?.pull_request?.branches, ['testing']);

  // 2. The tag is derived from the pull request number, in every job. A tag
  //    carrying the commit sha would be a NEW release, with new links, on every
  //    round.
  // The release is written by the `publish` job only. The build jobs hold no write token and
  // hand their files over as artifacts (`zones.test.js` holds that).
  const publish = workflow.jobs?.publish;
  const comment = workflow.jobs?.comment;
  for (const [name, job] of [['publish', publish], ['comment', comment]]) {
    assert.ok(job, `expected a \`${name}\` job`);
    const runs = (job.steps ?? []).map((s) => s.run ?? '').join('\n');
    assert.match(
      runs,
      /pr-\$\{?(env:)?PR_NUMBER\}?/,
      `${name} must address the release by pull request number, not by commit`
    );
  }

  // And the tag is assigned from the number and nothing else. The sha appears
  // legitimately elsewhere in these jobs -- `--target "$HEAD_SHA"` points the
  // release at the commit it was built from -- so the check has to be on the
  // assignment, not on the word.
  for (const [name, job] of [['publish', publish]]) {
    const assignments = (job.steps ?? [])
      .flatMap((s) => (s.run ?? '').split('\n'))
      .filter((line) => /^\s*\$?(TAG|tag)\s*=/.test(line));
    assert.ok(assignments.length >= 1, `expected ${name} to assign a release tag`);
    for (const line of assignments) {
      assert.doesNotMatch(line, /HEAD_SHA/, `${name} must not tag by commit sha: every round would get new links`);
    }
  }

  // 3. The upload overwrites. Without `--clobber` the second round's upload
  //    fails on an asset that already exists, and the link keeps serving the
  //    first build with a green tick next to it.
  const uploads = [publish]
    .flatMap((job) => job.steps ?? [])
    .map((s) => s.run ?? '')
    .filter((run) => run.includes('gh release upload'));
  assert.ok(uploads.length >= 1, 'expected the upload in the publish job');
  assert.match(uploads[0], /builds\/\*\.zip builds\/\*\.exe/, 'both platforms are uploaded');
  for (const run of uploads) {
    assert.match(run, /--clobber/, 'an upload without --clobber leaves the previous build in place');
  }

  // 4. One comment, edited. A thread that grows a near-identical comment per
  //    round is noise to scroll past and worse to hear read aloud -- and by
  //    round four the newest link is twenty comments below the oldest.
  const commentRun = (comment.steps ?? []).map((s) => s.run ?? '').join('\n');
  assert.match(commentRun, /--edit-last/, 'the build comment must be edited in place');
  assert.match(commentRun, /--create-if-none/, 'and written the first time');
});

test('there is no manual build trigger, so every expression reads the pull request', () => {
  assert.equal(triggers?.workflow_dispatch, undefined);
  assert.doesNotMatch(source, /inputs\./);
});

test('one build at a time per pull request, and a newer push replaces an older one', () => {
  assert.match(workflow.concurrency?.group ?? '', /github\.event\.pull_request\.number/);
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});

test('the pipeline\'s own branches are built, and only their comment is skipped', () => {
  // The pull request is opened with the App's token, so this run starts and
  // `pipeline-verify.yml` waits for it. The links go on the ISSUE, by the verify
  // report, so the comment on the pull request is the one job left out.
  assert.equal(workflow.jobs['pack-mac'].if, undefined);
  assert.equal(workflow.jobs['pack-win'].if, undefined);
  assert.equal(workflow.jobs.comment.if, "${{ !startsWith(github.head_ref, 'claude/fix-') }}");
  assert.equal(workflow.jobs.publish.if, undefined, 'the release is made for a fix branch too');
  assert.deepEqual(workflow.jobs.comment.needs, ['publish']);
  // No `if:` may be put on the required checks. A skipped job satisfies a
  // required status check, which would let a red pull request merge.
  const checks = loadYaml(readFileSync('.github/workflows/pr-checks.yml', 'utf8'));
  for (const name of ['unit', 'nemeth', 'e2e']) assert.equal(checks.jobs[name].if, undefined, name);
});
