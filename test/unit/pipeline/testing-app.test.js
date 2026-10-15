import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load as loadYaml } from 'js-yaml';

const workflow = loadYaml(readFileSync('.github/workflows/testing-app.yml', 'utf8'));
const publish = workflow.jobs.publish.steps.find((s) => s.name?.startsWith('Publish'))?.run ?? '';

test('one job moves the tag, through the API, and it fails when the tag cannot be moved', () => {
  // Measured on the run for the merge of #29. `pack-mac` and `pack-win` both force-pushed the
  // same `testing-app` tag to the same commit at the same time. Git refused the one that lost
  // ("cannot lock ref"), and the Mac zip was never published. Now the publish job is the only
  // one that touches the tag, and it has no checkout, so it moves the tag with the API.
  assert.match(publish, /gh api --method PATCH "repos\/\$GH_REPO\/git\/refs\/tags\/testing-app" -f sha="\$GITHUB_SHA" -F force=true/);
  assert.match(publish, /\|\| gh api --method POST "repos\/\$GH_REPO\/git\/refs" -f ref=refs\/tags\/testing-app/, 'a tag that is not there yet is created');
  assert.doesNotMatch(publish, /git push|git tag/, 'no checkout, so no git');
  for (const job of ['pack-mac', 'pack-win']) {
    const text = JSON.stringify(workflow.jobs[job]);
    assert.doesNotMatch(text, /testing-app"|git push|gh release/, `${job} publishes nothing`);
  }
});

test('the upload comes after the tag, so a stuck tag still stops a half-published release', () => {
  assert.ok(publish.indexOf('refs/tags/testing-app') < publish.indexOf('gh release upload'));
  const upload = publish.slice(publish.indexOf('gh release upload'));
  for (const asset of ['builds/*.zip', 'builds/version.json', 'builds/*.exe', 'builds/*.exe.blockmap', 'builds/alpha.yml', '--clobber']) {
    assert.ok(upload.includes(asset), `the upload names ${asset}`);
  }
});

test('the alpha still gets the same files as before, from artifacts', () => {
  const upload = (job) => workflow.jobs[job].steps.find((s) => s.uses?.startsWith('actions/upload-artifact'));
  assert.deepEqual(upload('pack-mac').with.path.trim().split('\n'), ['dist/*.zip', 'dist/version.json']);
  assert.deepEqual(upload('pack-win').with.path.trim().split('\n'), ['dist/*.exe', 'dist/*.exe.blockmap', 'dist/alpha.yml']);
  assert.equal(upload('pack-win').with['if-no-files-found'], 'error');
});
