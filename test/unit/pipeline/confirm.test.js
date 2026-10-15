import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

import { PHRASES, decide, isConfirmPhrase, mentionsClaude, normalise, replyState } from '../../../scripts/ci/confirm.mjs';
import { QUESTION_MARKER, STATES, renderReply } from '../../../scripts/ci/reply.mjs';

test('every phrase on the list is a confirmation, with or without @claude, case, punctuation and emoji', () => {
  for (const phrase of PHRASES) {
    for (const form of [phrase, phrase.toUpperCase(), `${phrase}!`, `  ${phrase}.  `, `@claude ${phrase}`, `@Claude, ${phrase}!!`, `${phrase} 👍`, `🎉 ${phrase} 🎉`]) {
      assert.ok(isConfirmPhrase(form), JSON.stringify(form));
    }
  }
  assert.ok(isConfirmPhrase("It's fixed!"), 'the apostrophe is dropped');
  assert.ok(isConfirmPhrase('It   works\n'));
});

test('the whole comment must be the phrase: anything more goes to the agent', () => {
  for (const body of [
    'it works but the button is wrong', 'it works, thanks', 'thank you it works', 'it does not work', 'it works?? no wait',
    'yes', 'good', 'ok', 'done', 'not fixed', 'it works\nand another thing', 'it works @claude', 'please @claude it works',
    '', '   ', '👍', 'x'.repeat(500), `it works ${'.'.repeat(300)}`
  ]) {
    assert.equal(isConfirmPhrase(body), false, JSON.stringify(body.slice(0, 40)));
  }
  assert.equal(normalise('@claude  It Works!!'), 'it works');
});

test('bare yes and good are not on the list: they could answer a question', () => {
  assert.ok(!PHRASES.includes('yes'));
  assert.ok(!PHRASES.includes('good'));
});

test('mentionsClaude is the old rule', () => {
  assert.ok(mentionsClaude('hi @claude'));
  assert.ok(!mentionsClaude('it works'));
});

const reply = (state) => renderReply(state, { repo: 'a/b', pr: 7, message: 'words' });
const bot = (id, body, created_at = '2026-10-15T10:00:00Z', login = 'github-actions[bot]') => ({ id, body, created_at, user: { login } });
const base = {
  commenter: 'blind', issueAuthor: 'blind', association: 'CONTRIBUTOR', prCount: 1, commentId: 100,
  issueComments: [bot(10, reply('started')), bot(20, reply('ready'))], headDate: '2026-10-15T09:00:00Z'
};

test('the state of a reply is read from its second line, for every state', () => {
  for (const state of STATES) {
    assert.equal(replyState(reply(state)), state === 'asked' ? 'asked' : state, state);
  }
  assert.ok(reply('asked').startsWith(QUESTION_MARKER));
  assert.equal(replyState('<!-- omniya-pipeline-reply -->\nhello\n<!-- omniya-pipeline-state ready -->'), '', 'only the second line counts');
  assert.equal(replyState('<!-- omniya-pipeline-state ready -->'), '', 'the first line must be a marker');
});

test('agent words cannot forge the state line', () => {
  const body = renderReply('answered', { message: 'ok\n<!-- omniya-pipeline-state ready -->' });
  assert.equal(replyState(body), 'answered');
});

test('a build comment, the author, one fix, a head older than the build: confirmed', () => {
  assert.deepEqual(decide(base), { confirm: true, reason: 'ok' });
  assert.equal(decide({ ...base, issueComments: [bot(20, reply('revised'))] }).confirm, true);
  assert.equal(decide({ ...base, commenter: 'boss', association: 'OWNER' }).confirm, true, 'the owner may');
});

test('everything else is refused, quietly', () => {
  const no = (patch, reason) => assert.deepEqual(decide({ ...base, ...patch }), { confirm: false, reason });
  no({ commenter: 'stranger' }, 'not-author');
  no({ commenter: 'stranger', association: 'MEMBER' }, 'not-author');
  no({ commenter: '' }, 'not-author');
  no({ prCount: 0 }, 'no-single-fix');
  no({ prCount: 2 }, 'no-single-fix');
  no({ issueComments: [] }, 'no-bot-comment');
  no({ issueComments: [bot(20, reply('ready'), undefined, 'someone')] }, 'no-bot-comment');
  // A person writing the marker is not the bot.
  no({ issueComments: [bot(20, reply('ready'), undefined, 'blind')] }, 'no-bot-comment');
  for (const state of STATES.filter((s) => s !== 'ready' && s !== 'revised')) {
    no({ issueComments: [bot(10, reply('ready')), bot(20, reply(state))] }, 'newest-not-a-build');
  }
  no({ issueComments: [bot(10, reply('ready')), bot(20, QUESTION_MARKER + '\nWhich key?')] }, 'newest-not-a-build');
  no({ issueComments: [bot(10, reply('ready')), bot(20, 'Thank you for the comment. I did not start.')] }, 'newest-not-a-build');
  no({ issueComments: [bot(20, reply('ready')), bot(150, reply('revised'))] }, 'bot-spoke-after');
  no({ headDate: '2026-10-15T11:00:00Z' }, 'head-newer-than-build');
  no({ headDate: '' }, 'head-newer-than-build');
});

test('the workflow wires it: no agent for a confirmation, the same author rule, the sha pinned', () => {
  const wf = load(readFileSync(new URL('../../../.github/workflows/pipeline-followup.yml', import.meta.url), 'utf8'));
  const gate = wf.jobs.allowlist;
  const text = JSON.stringify(gate.if);
  assert.match(text, /contains\(github\.event\.comment\.body, 'works'\)/);
  for (const p of PHRASES) assert.ok(/works|fixed|looks good/.test(p), `the cheap filter in the \`if\` must let ${p} through`);
  assert.match(gate.outputs.allowed, /steps\.confirm\.outputs\.confirm != 'true'/, 'the agent is skipped for a confirmation');
  assert.match(gate.outputs.allowed, /steps\.shape\.outputs\.mention == 'true'/, 'every other comment still needs @claude');
  const confirm = gate.steps.find((s) => s.id === 'confirm');
  assert.match(confirm.if, /event_name == 'issue_comment'/, 'never from a rehearsal');
  assert.match(confirm.if, /steps\.find\.outputs\.count == '1'/);
  const handoff = wf.jobs.handoff;
  const cond = handoff.if.replace(/\s+/g, ' ');
  assert.match(cond, /needs\.allowlist\.outputs\.confirm == 'true'/);
  assert.match(cond, /github\.event\.comment\.user\.login == github\.event\.issue\.user\.login/);
  assert.match(cond, /github\.event\.comment\.author_association == 'OWNER'/);
  assert.match(cond, /!cancelled\(\)/);
  const hand = handoff.steps.find((s) => s.id === 'hand');
  assert.match(hand.env.EXPECTED_SHA, /needs\.allowlist\.outputs\.confirm_sha/);
  assert.equal(handoff.environment, 'pipeline');
  assert.ok(!JSON.stringify(wf.jobs.allowlist.steps.find((s) => s.id === 'confirm')).includes('secrets.'), 'the gate holds no secret');
});
