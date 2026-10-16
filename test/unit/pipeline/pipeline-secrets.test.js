import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { dump, load as loadYaml } from 'js-yaml';

const DIR = '.github/workflows/';
const SECRETS = ['CLAUDE_CODE_OAUTH_TOKEN', 'PIPELINE_APP_PRIVATE_KEY'];
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const parsed = files.map((f) => ({ f, text: readFileSync(DIR + f, 'utf8'), wf: loadYaml(readFileSync(DIR + f, 'utf8')) }));
const jobsOf = ({ wf }) => Object.entries(wf.jobs ?? {});
const mentions = (job) => SECRETS.filter((s) => dump(job).includes(`secrets.${s}`));

const isMention = (v) => SECRETS.some((s) => String(v).includes(`secrets.${s}`));
const realUse = (job) => isMention(JSON.stringify({ with: job.with, env: job.env, steps: job.steps }));

test('a job that really uses a pipeline secret declares environment `pipeline`', () => {
  let seen = 0;
  for (const p of parsed) {
    for (const [name, job] of jobsOf(p)) {
      if (!realUse(job)) continue;
      seen += 1;
      assert.equal(job.environment, 'pipeline', `${p.f} job ${name} uses a pipeline secret`);
      assert.equal(job.uses, undefined, `${p.f} job ${name}: a job that calls a workflow cannot hold an environment`);
    }
  }
  assert.ok(seen >= 2, 'the agent job and the hand-off job use them');
});

test('a calling job passes the two secrets by name only, never inherit', () => {
  for (const p of parsed) {
    for (const [name, job] of jobsOf(p)) {
      if (!job.uses) continue;
      assert.notEqual(job.secrets, 'inherit', `${p.f} job ${name} inherits secrets`);
      for (const [k, v] of Object.entries(job.secrets ?? {})) {
        if (SECRETS.includes(k) || isMention(v)) assert.equal(v, `\${{ secrets.${k} }}`, `${p.f} job ${name} passes ${k} by another name or expression`);
      }
      if (/pipeline-(agent|verify)\.yml$/.test(job.uses)) {
        for (const s of SECRETS) assert.equal(job.secrets?.[s], `\${{ secrets.${s} }}`, `${p.f} job ${name} must pass ${s}`);
      }
    }
  }
});

test('workflow_call declares both secrets as not required', () => {
  for (const f of ['pipeline-agent.yml', 'pipeline-verify.yml']) {
    const on = parsed.find((p) => p.f === f).wf;
    const declared = (on.on ?? on[true]).workflow_call.secrets ?? {};
    for (const s of SECRETS) assert.equal(declared[s]?.required, false, `${f} must declare ${s} with required: false`);
  }
  for (const p of parsed) {
    if (['pipeline-agent.yml', 'pipeline-verify.yml'].includes(p.f)) continue;
    const on = p.wf.on ?? p.wf[true] ?? {};
    for (const s of SECRETS) assert.equal(on.workflow_call?.secrets?.[s], undefined, `${p.f} declares ${s}`);
  }
});

test('no other workflow mentions the two secrets', () => {
  // `pipeline-ship.yml` is the owner-approved path (2026-10-14) for merging a
  // `pipeline/` pull request after "ship it" in chat. It runs no agent and uses
  // only the App key, in the locked environment, from `testing`.
  const pipeline = new Set([
    'pipeline-fix.yml',
    'pipeline-followup.yml',
    'pipeline-verify.yml',
    'pipeline-agent.yml',
    'pipeline-ship.yml',
    // Asks the App for contents and pull requests only (never statuses), and passes the
    // two secrets by name to `pipeline-verify.yml`, which is the only place a repair runs.
    'pipeline-keep-current.yml',
    // Posts the merge-box status after the owner's own approval. It runs no agent, asks the App for
    // `statuses: write` only, and never checks out the pull request. See `pipeline-ready.yml`.
    'pipeline-ready.yml',
    // Carries a contributor's "it works" over a branch update. Runs no agent and checks out `testing`; the
    // fix branches are read by git as data. See `pipeline-carry.yml` and `scripts/ci/carry-over.mjs`.
    'pipeline-carry.yml'
  ]);
  for (const p of parsed) {
    if (pipeline.has(p.f)) continue;
    assert.equal(SECRETS.some((s) => p.text.includes(s)), false, `${p.f} mentions a pipeline secret`);
  }
});

test('only the hand-off job asks the App for commit statuses', () => {
  for (const p of parsed) {
    for (const [name, job] of jobsOf(p)) {
      const hit = dump(job).includes('permission-statuses');
      // The contributor hand-off, the owner's "ship it" for a pipeline pull request, and the status that
      // follows the owner's own approval in the merge box (`pipeline-ready.yml`, which runs no agent).
      const allowed =
        (p.f === 'pipeline-followup.yml' && name === 'handoff') ||
        (p.f === 'pipeline-ship.yml' && name === 'ship') ||
        (p.f === 'pipeline-ready.yml' && name === 'ready') ||
        // The same hand-off, run again for a head the contributor's approval carries to (`carry-over.mjs`).
        (p.f === 'pipeline-carry.yml' && name === 'carry');
      assert.equal(hit, allowed, `${p.f}:${name}`);
    }
  }
});
