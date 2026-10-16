/**
 * The ONE comment the pipeline posts on an issue for each event.
 *
 * The contributor is blind and reads the issue aloud. A thread where three
 * comments say the same thing, one of them edited in place and one of them a
 * "notice" about the edit, is three times the listening and none of it new.
 *
 * It used to be that way because two writers shared the issue. The pipeline
 * wrote an edited status comment plus a notice, and the agent wrote its own
 * comment as well. Asking the agent to stay quiet did not hold. So the agent
 * no longer posts anything. It writes its words to a file, and this script
 * posts them, once, inside the one comment the event gets.
 *
 * Always a NEW comment, never an edit: GitHub sends no notification for an edit,
 * and a comment nobody hears is no reply. The download links live in the newest
 * `ready` or `revised` comment, and a revision says so.
 *
 * Every body starts with `MARKER`. Those comments tell the contributor to write
 * `@claude`, so the follow-up gate skips anything that carries `PIPELINE_PREFIX`,
 * whoever posts it. Two comments once posted by hand under the maintainer's name
 * each started an agent run.
 *
 * Words: short sentences, no file names, no check names, no logs. The links are
 * link text, not bare addresses, because a screen reader reads a long address
 * letter by letter.
 *
 * Usage (needs GH_TOKEN and GITHUB_REPOSITORY, and MESSAGE when the agent wrote one):
 *   node scripts/ci/reply.mjs <issue-number> <state> [<pull-request-number>]
 */

import { pathToFileURL } from 'node:url';

import { gh, requireNumber } from './gh.mjs';

export const PIPELINE_PREFIX = '<!-- omniya-pipeline-';
export const MARKER = `${PIPELINE_PREFIX}reply -->`;

/**
 * The first line of a question the agent asks the contributor. It carries the
 * pipeline prefix, so the follow-up gate never treats the question itself as a
 * run to start. Two things read it from GitHub: `listed-thread.mjs` keeps a bot
 * comment ONLY when it starts with this, so the answer can be read next to the
 * question, and the follow-up gate counts the comments that start with it, so the
 * agent cannot ask more than twice. Both read it from the comment as posted, and
 * only a workflow can post as the bot.
 */
export const QUESTION_MARKER = `${PIPELINE_PREFIX}question -->`;
export const AUTHOR = 'github-actions[bot]';

/**
 * The second line of every reply: which state it is. `confirm.mjs` reads it to
 * know that the newest thing the pipeline said was a build for the contributor
 * to try. Only the bot writes it (a person cannot post as `github-actions[bot]`),
 * and `cleanMessage` drops any line of agent text that carries the prefix.
 */
export const STATE_PREFIX = `${PIPELINE_PREFIX}state `;
export const stateLine = (state) => `${STATE_PREFIX}${state} -->`;

/** The agent's words are cut to this many characters. A reply is read aloud. */
export const MAX_MESSAGE = 2000;

const STUCK_TAIL = [
  'The maintainer has been told and will answer here.',
  'You do not need to do anything.'
];

const TRY_IT = [
  'Install it and try the thing that was wrong. Then write a comment here.',
  'If it is still wrong, start your comment with @claude and say what you found.',
  'If it works, write: it works'
];

/**
 * Per state: what the comment holds.
 *   message  'none'      the agent's words are not used
 *            'optional'  used when the agent wrote some
 *            'required'  used, or the state falls back to `fallback`
 *   marker   the first line, when it is not `MARKER`
 *   intro    fixed words that come before the links, after the agent's words
 *   lines    fixed words that always follow
 */
const STATES_DEF = {
  started: {
    message: 'none',
    lines: [
      'I started on this. It usually takes about an hour.',
      'You do not need to do anything.',
      'I will write here again when there is a test build, or when I need something from you.'
    ]
  },
  ready: {
    message: 'optional',
    links: true,
    intro: ['A test build is ready. All the automatic checks passed.'],
    lines: [
      ...TRY_IT,
      'When I change the fix, the links stay the same.',
      'Both builds are unsigned, so your computer will ask you to confirm. Neither replaces the alpha app you already have.'
    ]
  },
  revised: {
    message: 'optional',
    links: true,
    intro: ['A new test build is ready. The links are the same as before, so download again from them.'],
    lines: [
      'Try it, then write here. If it is still wrong, start your comment with @claude and say what you found.',
      'If it works, write: it works'
    ]
  },
  // An answer, or a question the agent could not settle on its own (it could not
  // reproduce the fault and asks what the contributor saw). Either way the
  // conversation goes on, so the comment says how. With no words there is nothing
  // to go on from, and that is a failure of the pipeline, not a hand-off.
  answered: {
    message: 'required',
    fallback: 'failed',
    lines: ['Reply in a comment that starts with @claude.']
  },
  // The question IS the one comment. The agent writes it to `message.md`, and it
  // goes out under the question marker. With no question there is nothing to ask,
  // so it falls back to `stuck` and a person is told.
  asked: {
    marker: QUESTION_MARKER,
    message: 'required',
    fallback: 'failed',
    lines: [
      'Reply in a comment that starts with @claude.',
      'I will start as soon as you answer.'
    ]
  },
  design: {
    message: 'optional',
    defaultMessage: 'This looks like a request for something new, not a fault.',
    lines: [
      'That is a design decision, and a person makes it.',
      'The maintainer will answer here. You do not need to do anything.'
    ]
  },
  routed: {
    message: 'none',
    lines: [
      'Thank you. This kind of report is answered by a person, so I did not start a fix.',
      'The maintainer will answer here. You do not need to do anything.'
    ]
  },
  // The agent is blocked: a check will not go green, or a pull request will not
  // open. Its words say WHICH and why, and they are required. Silence is never
  // an acceptable reason to hand a thread to a person, so with no words this
  // becomes `failed`, which says that the pipeline went wrong and not that the
  // report could not be done.
  stuck: {
    message: 'required',
    fallback: 'failed',
    lines: STUCK_TAIL
  },
  maintainer: {
    message: 'none',
    lines: [
      'The maintainer needs to look at a technical problem with this fix.',
      'You do not need to do anything.',
      'The maintainer will write here when there is news.'
    ]
  },
  failed: {
    message: 'none',
    lines: [
      'Something went wrong on my side while I was working on this.',
      'Nothing is wrong with your report.',
      'The maintainer has been told and will look. You do not need to do anything.'
    ]
  },
  // The hand-off. `sent` is the fix that is set to merge by itself. The other two
  // are a fix a person has to look at first, and they say the truth about why.
  sent: {
    message: 'none',
    lines: [
      'Thank you for testing.',
      'It will merge by itself when the checks finish, and the test build will update.',
      'This issue closes when it merges.',
      'You do not need to do anything.'
    ]
  },
  // The fix is the same one the contributor tested. Only the app around it moved on, and the
  // branch was brought up to date. Their "it works" still holds, so it is sent on. Said once.
  carried: {
    message: 'none',
    lines: [
      'Thank you for testing.',
      'The app around your fix changed since you tried it, but your fix did not.',
      'Your answer still holds, so I sent it on. You do not need to test again.',
      'It will merge by itself when the checks finish, and the test build will update.',
      'This issue closes when it merges.',
      'You do not need to do anything.'
    ]
  },
  'sent-automation': {
    message: 'none',
    lines: [
      'Thank you for testing.',
      'It changes the automation itself, so the maintainer has to look at it first.',
      'This issue closes when the maintainer merges the fix.',
      'You do not need to do anything.'
    ]
  },
  'sent-owner': {
    message: 'none',
    lines: [
      'Thank you for testing.',
      'The maintainer has to look at it before it can merge.',
      'This issue closes when the maintainer merges the fix.',
      'You do not need to do anything.'
    ]
  },
  // The fix is fine, but newer code changed the same lines, so it cannot merge as it
  // is. That is not a person's job: the pipeline brings it up to date and sends a new
  // build. The contributor tested the old one, so they say it works again on the new one.
  behind: {
    message: 'none',
    lines: [
      'Thank you for testing.',
      'Newer changes in the app touched the same place, so your fix could not merge as it was.',
      'I am bringing it up to date now. I will write here when there is a new build.',
      'You will need to try that one and tell me if it still works.',
      'You do not need to do anything until then.'
    ]
  }
};

export const STATES = Object.keys(STATES_DEF);

/** The label the pipeline puts on the issue for a state. The agent labels nothing. */
export const LABELS = {
  // A person is NOT needed here: the contributor is, and the agent waits for them.
  asked: { name: 'needs-info', description: 'The agent asked the reporter a question and is waiting' },
  design: { name: 'needs-design', description: 'Not a bug: a design decision for the maintainer to answer' },
  stuck: { name: 'needs-owner', description: 'A person has to look at this' },
  failed: { name: 'needs-owner', description: 'A person has to look at this' }
};

/**
 * States that mean the pipeline is working again or the contributor is being
 * served. A `needs-owner` left by an earlier crash is stale by then, and the
 * owner's inbox must not list an issue that is moving. The states that still
 * need a person (stuck, failed, maintainer, the sent-* hand-offs) keep it.
 */
export const CLEARS_NEEDS_OWNER = ['started', 'ready', 'revised', 'asked', 'answered', 'sent', 'carried'];

/**
 * One pass of the cleaning rules. `cleanMessage` repeats it until nothing changes,
 * because a rule can build what an earlier rule removed: `@@claude` becomes
 * `@claude` when the first `@` is taken out, and `<!<b>-- omniya-pipeline-`
 * becomes the marker when the tag is taken out.
 */
function cleanOnce(text) {
  return text
    // Control and zero-width characters, which hide text from a reader and a filter alike.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
    // A reference-style link definition: `[1]: https://...`.
    .replace(/^[ \t]*\[[^\]\n]*\]:[ \t]*\S.*$/gm, '')
    // A markdown link or image keeps its words and loses its address.
    .replace(/!?\[([^\]\n]*)\]\([^\n]*?\)/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1')
    // HTML, including a comment. An unclosed tag is cut to the end of its line.
    .replace(/<[A-Za-z!/?][^>\n]*>?/g, '')
    // Any address with a scheme, and any `www.` address.
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g, '')
    .replace(/\bwww\.\S*/gi, '')
    // Every `@`. Agent words never need one, and a lone `@` next to another can
    // rebuild a mention.
    .replace(/@/g, '')
    .replace(/[ \t]+$/gm, '');
}

/**
 * The agent's words are text from a model that has read untrusted reports, and
 * they are posted in a public comment under the project's name. So:
 *
 *  - No link survives. The prompt says never to write one, and the only links a
 *    contributor should ever be sent are the two this script builds. A link in
 *    agent text would be a link a hostile report talked the agent into writing.
 *    A markdown link keeps its words. A bare address is removed.
 *  - No `@` survives. A mention notifies a stranger, and `@claude` is the word
 *    that starts a run. The fixed words are the only place either may appear.
 *  - No HTML survives, so nothing can hide, restyle or inject into the comment.
 *  - The rules run until nothing changes, and the marker check runs LAST. A line
 *    that carries the pipeline's marker prefix is dropped, so the words cannot
 *    dress up as a comment the gate trusts, however the prefix was assembled.
 *  - It is cut to size.
 *
 * @param {string|undefined} text
 */
export function cleanMessage(text) {
  let kept = String(text ?? '').replace(/\r/g, '');
  for (let i = 0; i < 20; i += 1) {
    const next = cleanOnce(kept);
    if (next === kept) break;
    kept = next;
  }
  kept = kept
    .split('\n')
    .filter((line) => !line.includes(PIPELINE_PREFIX) && !line.includes('<!--'))
    .join('\n')
    .trim();
  if (kept.length <= MAX_MESSAGE) return kept;
  return `${kept.slice(0, MAX_MESSAGE).replace(/\s+\S*$/, '')} ...`;
}

/**
 * The state that is actually posted. A state that needs the agent's words and
 * has none (`asked`, `answered`, `stuck`) is posted as `failed`, so a person is
 * told, and told the truth: the pipeline lost the words, the report is fine. The
 * label has to follow the state that was posted and not the one that was asked
 * for, or a forgotten `message.md` would put `needs-info` on an issue that is
 * waiting for nobody to answer.
 *
 * @param {string} state one of STATES
 * @param {string|undefined} message
 * @returns {string} one of STATES
 */
export function resolveState(state, message) {
  const def = STATES_DEF[state];
  if (!def) throw new Error(`unknown state: ${state}`);
  return def.message === 'required' && !cleanMessage(message) ? def.fallback : state;
}

/**
 * @param {string} state one of STATES
 * @param {{repo?: string, pr?: string|number, message?: string}} [where] `repo` and `pr` are needed for the states with links
 * @returns {string}
 */
export function renderReply(state, { repo, pr, message } = {}) {
  const posted = resolveState(state, message);
  const def = STATES_DEF[posted];
  const words = cleanMessage(message);

  const parts = [];
  if (def.message !== 'none') {
    const lead = words || def.defaultMessage;
    if (lead) parts.push(lead);
  }
  if (def.intro) parts.push(def.intro.join('\n'));
  if (def.links) {
    const n = requireNumber(pr, 'pull request number');
    if (!repo) throw new Error(`repo is required for the ${state} state`);
    const base = `https://github.com/${repo}/releases/download/pr-${n}`;
    parts.push([
      `- [Download for Mac, Apple Silicon](${base}/Omniya-Core-mac-arm64.zip)`,
      `- [Download for Windows](${base}/Omniya-Core-Setup-x64.exe)`
    ].join('\n'));
  }
  if (def.lines.length > 0) parts.push(def.lines.join('\n'));
  return `${def.marker ?? MARKER}\n${stateLine(posted)}\n${parts.join('\n\n')}\n`;
}

/**
 * Is this comment body exactly the reply for `state`, in today's wording OR in the wording
 * from before the hidden state line existed (the same text, with no second line)?
 *
 * Comments written on Oct 14 and earlier have no state line, and contributors are still
 * reading them: "The maintainer needs to look at a technical problem". A check that only knew
 * today's form read them as "not waiting", and stayed silent when the fix went green. The
 * old form must match EXACTLY, word for word, so a person's own comment can never pass for it.
 * Only for states that take no words or links (`maintainer`).
 *
 * @param {string|undefined} body
 * @param {string} state one of STATES
 * @returns {boolean}
 */
export function isReplyOfState(body, state) {
  const current = renderReply(state).trim();
  const lines = current.split('\n');
  const legacy = [lines[0], ...lines.slice(2)].join('\n').trim();
  const text = String(body ?? '').trim();
  return text === current || text === legacy;
}

/**
 * The replies after which the contributor is waiting on a PERSON: the maintainer was called in
 * (`maintainer`), or the hand-off sent a fix the pipeline may not merge on its own
 * (`sent-automation`, `sent-owner`). When that person's part is done and the fix is green,
 * the contributor must be told, whichever of the three they were last told.
 */
export const WAITING_STATES = ['maintainer', 'sent-automation', 'sent-owner'];

/** Is this comment body one of the WAITING_STATES replies, in today's wording or the old one? */
export const isWaitingOnPerson = (body) => WAITING_STATES.some((state) => isReplyOfState(body, state));

/**
 * Post the reply, and label the issue if the state calls for it. Exactly one
 * comment per call. `run` is `gh` unless a test hands in a stand-in.
 *
 * @param {{issue: string|number, state: string, repo: string, pr?: string|number, message?: string}} args
 * @param {(args: string[]) => string} [run]
 */
export function postReply({ issue, state, repo, pr, message }, run = gh) {
  const number = requireNumber(issue, 'issue number');
  const body = renderReply(state, { repo, pr, message });
  run(['api', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]);
  const posted = resolveState(state, message);
  const label = LABELS[posted];
  if (label) {
    run(['label', 'create', label.name, '--repo', repo, '--force', '--description', label.description]);
    run(['issue', 'edit', number, '--repo', repo, '--add-label', label.name]);
  }
  if (CLEARS_NEEDS_OWNER.includes(posted)) {
    try {
      run(['issue', 'edit', number, '--repo', repo, '--remove-label', 'needs-owner']);
    } catch {
      // The label was not there. The comment is already posted.
    }
  }
  return { posted: 1, labelled: label?.name };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [issue, state, pr] = process.argv.slice(2);
  const result = postReply({
    issue,
    state,
    pr,
    repo: process.env.GITHUB_REPOSITORY,
    message: process.env.MESSAGE
  });
  console.log(`reply ${state}: posted ${result.posted} comment${result.labelled ? `, labelled ${result.labelled}` : ''}`);
}
