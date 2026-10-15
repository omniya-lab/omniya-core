import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PATH = 'docs/contributor-pipeline.md';
const doc = readFileSync(PATH, 'utf8');

test('every workflow file is listed with the branch it lives on', () => {
  // A new workflow that never reaches this table is one nobody knows exists.
  // `testing` is the default branch, so every row names it.
  const workflows = readdirSync('.github/workflows').filter((f) => f.endsWith('.yml'));
  assert.ok(workflows.length >= 5, 'expected the pipeline workflows to exist');

  for (const file of workflows) {
    const row = doc
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes(`.github/workflows/${file}`));
    assert.ok(row, `docs/contributor-pipeline.md has no row for ${file}`);
    assert.match(row, /\|\s*`testing`\s*\|/, `the row for ${file} must name the branch it lives on`);
  }
});

test('the contributor is told the two phrases that drive the loop, and not to close the issue', () => {
  // The whole loop rests on things the contributor has to know, and none is
  // discoverable from the GitHub interface. `@claude` in a comment starts another
  // round. `@claude it works` sends the fix to the maintainer. Closing the issue
  // does neither, and a contributor who closes it believes they shipped.
  //
  // A pipeline whose controls are only in the maintainer's half of this page is
  // a pipeline the contributor cannot drive.
  const [contributorHalf] = doc.split('## If you maintain this repository');

  assert.match(contributorHalf, /@claude/, 'the contributor half must name the word that starts a round');
  assert.match(contributorHalf, /write: it works/, 'and the phrase that says it is done');
  assert.match(contributorHalf, /Do not close the issue/);
  assert.doesNotMatch(contributorHalf, /[Cc]losing the issue is what merges/, 'closing no longer merges anything');
  // And that the links do not change, because the alternative is her hunting for
  // a new comment that will never be posted.
  assert.match(contributorHalf, /same links|links already in the/i);
  // The contributor never needs the pull request, so the half they hear does not send them there.
  assert.doesNotMatch(contributorHalf, /pull request|branch|workflow/i);
});

test('the maintainer is told what merges by itself, and that testing is the default branch', () => {
  const maintainerHalf = doc.split('## If you maintain this repository')[1] ?? '';

  assert.match(maintainerHalf, /merges by itself only when the contributor says it works/);
  assert.match(maintainerHalf, /contributor-tested/);
  assert.match(maintainerHalf, /needs-owner/);
  assert.match(maintainerHalf, /testing-tested/);
  assert.match(maintainerHalf, /uses no `--admin`|no `--admin`/);
  assert.match(maintainerHalf, /PIPELINE_APP_ID/);
  assert.match(maintainerHalf, /PIPELINE_APP_PRIVATE_KEY/);
  assert.match(maintainerHalf, /environment `pipeline`/);
  assert.match(maintainerHalf, /no repository-level\s+copy/);
  // GitHub closes an issue from `Fixes` for the default branch, which is `testing`.
  assert.match(maintainerHalf, /`testing` is the default branch/);
  // The split between a default branch and a working branch is gone.
  assert.doesNotMatch(maintainerHalf, /stub|pipeline-on-main|pipeline-close-issue/);
  // The label that sent every fix to the maintainer is retired.
  assert.doesNotMatch(doc, /ready-for-maintainer/);
});

test('every file the page names exists', () => {
  // A rule that points at a file that was renamed is a rule nobody can follow.
  const named = new Set(doc.match(/`((?:\.github|\.claude|scripts|docs|src|test)\/[\w./-]+[\w])`/g)?.map((m) => m.slice(1, -1)));
  assert.ok(named.size >= 12, 'expected the page to name its files');
  for (const path of named) {
    assert.ok(existsSync(path), `docs/contributor-pipeline.md names ${path}, which does not exist`);
  }
});

test('the page lists every pipeline workflow, and says how to rehearse one', () => {
  const pipeline = readdirSync('.github/workflows').filter((f) => /^pipeline-.*\.yml$/.test(f));
  assert.ok(pipeline.length >= 5);
  for (const file of pipeline) assert.ok(doc.includes(`.github/workflows/${file}`), `${file} is not listed`);
  assert.match(doc, /\.claude\/skills\/pipeline-change\/SKILL\.md/);
});

test('every label the page names is set by a form, a workflow or a script', () => {
  const [, labels = ''] = doc.split('### Labels');
  const table = labels.split('###')[0];
  const names = [...table.matchAll(/`([a-z][a-z-]+)`/g)].map((m) => m[1]).filter((n) => !n.endsWith('.mjs'));
  const sources = ['.github/workflows', '.github/ISSUE_TEMPLATE', 'scripts/ci']
    .flatMap((dir) => readdirSync(dir).map((f) => readFileSync(`${dir}/${f}`, 'utf8')))
    .join('\n');
  assert.ok(names.length >= 8, 'expected the label table to name its labels');
  for (const name of names) assert.ok(sources.includes(name), `label ${name} is named but nothing sets it`);
});

test('the page stays short and says nothing is planned that is not built', () => {
  assert.ok(doc.split('\n').length <= 200, 'this page is meant to be read aloud: keep it short');
  assert.doesNotMatch(doc, /Planned, not live/);
});

test('the agent\'s instructions are kept outside the workflow, and the page says why', () => {
  assert.ok(existsSync('.github/prompts/agent.md'));
  assert.match(doc, /21,000/);
  assert.match(doc, /origin\/testing/);
});
