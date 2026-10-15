import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AUTHOR, renderReply } from '../../../scripts/ci/reply.mjs';
import { decide, tellRescued } from '../../../scripts/ci/tell-rescued.mjs';

const bot = { login: AUTHOR };
const waiting = { user: bot, body: renderReply('maintainer').trim() };
const gaveBuild = { user: bot, body: renderReply('ready', { repo: 'a/b', pr: 7 }) };
const green = { 'pr-checks': 'success', 'pr-build': 'success' };
const stuck = { labels: ['needs-owner'], body: 'x\n\nFixes #73\n' };

test('says "ready" when a person fixed a red fix the contributor never got a build for', () => {
  const out = decide({ pr: stuck, comments: [waiting], runs: green });
  assert.equal(out.say, 'ready');
});

test('says "revised" when the contributor already had a build', () => {
  const out = decide({ pr: stuck, comments: [gaveBuild, waiting], runs: green });
  assert.equal(out.say, 'revised');
});

test('says nothing while a check or the build is not green', () => {
  assert.equal(decide({ pr: stuck, comments: [waiting], runs: { ...green, 'pr-build': '' } }).say, null);
  assert.equal(decide({ pr: stuck, comments: [waiting], runs: { ...green, 'pr-checks': 'failure' } }).say, null);
});

test('says nothing when the pull request is not waiting on a person', () => {
  assert.equal(decide({ pr: { ...stuck, labels: [] }, comments: [waiting], runs: green }).say, null);
});

test('says nothing when a newer pipeline comment already moved the contributor on', () => {
  // The ordinary green path, or a second run of this script: the newest comment
  // from the pipeline is a build, not the maintainer reply. Saying it again would
  // break "each thing once".
  const newer = { user: bot, body: renderReply('revised', { repo: 'a/b', pr: 7 }) };
  assert.equal(decide({ pr: stuck, comments: [waiting, newer], runs: green }).say, null);
  assert.equal(decide({ pr: stuck, comments: [], runs: green }).say, null);
});

test('a comment from a person does not count as a pipeline comment', () => {
  const person = { user: { login: 'someone' }, body: '@claude please look again' };
  assert.equal(decide({ pr: stuck, comments: [waiting, person], runs: green }).say, 'ready');
});

function fakeGh({ labels = ['needs-owner'], comments = [waiting], runs = ['success', 'success'], head = 'abc' } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'pr' && b === 'list') {
      return JSON.stringify([
        {
          number: 84,
          body: 'Text\n\nFixes #73\n',
          headRefName: 'claude/fix-73-enth-speech',
          headRefOid: head,
          isCrossRepository: false,
          labels: labels.map((name) => ({ name }))
        }
      ]);
    }
    if (a === 'api' && args[1].endsWith('/comments') && !args.includes('-f')) return JSON.stringify([comments]);
    if (a === 'run') {
      const workflow = args[args.indexOf('--workflow') + 1];
      const conclusion = runs[workflow === 'pr-checks' ? 0 : 1];
      return JSON.stringify([{ headSha: head, status: conclusion ? 'completed' : 'in_progress', conclusion }]);
    }
    return '';
  };
  return { run, calls };
}

test('posts one comment on the issue and takes the label off', () => {
  const { run, calls } = fakeGh();
  const out = tellRescued({ branch: 'claude/fix-73-enth-speech', repo: 'a/b' }, run);
  assert.equal(out.said, 'ready');
  const posts = calls.filter((c) => c[0] === 'api' && c.includes('-f'));
  assert.equal(posts.length, 1);
  assert.match(posts[0][1], /issues\/73\/comments/);
  assert.match(posts[0].join(' '), /releases\/download\/pr-84\/Omniya-Core-Setup-x64\.exe/);
  assert.ok(calls.some((c) => c[0] === 'issue' && c[1] === 'edit' && c.includes('--remove-label') && c.includes('needs-owner')));
});

test('does nothing while the build is still running', () => {
  const { run, calls } = fakeGh({ runs: ['success', ''] });
  const out = tellRescued({ branch: 'claude/fix-73-enth-speech', repo: 'a/b' }, run);
  assert.equal(out.said, null);
  assert.equal(calls.filter((c) => c.includes('-f')).length, 0);
});

test('refuses a branch that is not a fix branch', () => {
  assert.throws(() => tellRescued({ branch: 'testing', repo: 'a/b' }, () => '[]'), /not a claude\/fix-/);
});

test('the workflow runs one at a time per branch and never checks out the branch it reacts to', () => {
  const yml = readFileSync('.github/workflows/pipeline-rescued.yml', 'utf8');
  assert.match(yml, /workflow_run:/);
  assert.match(yml, /concurrency:[\s\S]*cancel-in-progress: false/);
  assert.match(yml, /ref: testing/);
  const refs = [...yml.matchAll(/^\s*ref:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(refs, ['testing'], 'the only checkout is `testing`, never the branch it reacts to');
  assert.doesNotMatch(yml, /CLAUDE_CODE_OAUTH_TOKEN/, 'no agent, no secret');
});

test('a person copying the pipeline marker cannot start or block a post', () => {
  const stranger = { login: 'someone' };
  // A copy of the maintainer reply from a person is not the contributor's wait.
  assert.equal(decide({ pr: stuck, comments: [{ user: stranger, body: waiting.body }], runs: green }).say, null);
  // A fake marker comment after the real wait does not hide it.
  const fake = { user: stranger, body: renderReply('revised', { repo: 'a/b', pr: 7 }) };
  assert.equal(decide({ pr: stuck, comments: [waiting, fake], runs: green }).say, 'ready');
  // A fake "you got a build" comment does not turn ready into revised.
  assert.equal(decide({ pr: stuck, comments: [{ ...gaveBuild, user: stranger }, waiting], runs: green }).say, 'ready');
});
