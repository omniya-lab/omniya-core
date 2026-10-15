#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(projectRoot, 'package.json');

export function computeTestingVersion(env) {
  const runNumber = env.GITHUB_RUN_NUMBER;
  const sha = env.GITHUB_SHA;
  if (!runNumber) {
    throw new Error('GITHUB_RUN_NUMBER is required to compute a testing build version');
  }
  if (!sha) {
    throw new Error('GITHUB_SHA is required to compute a testing build version');
  }
  return `0.1.0-alpha.${runNumber}+${sha.slice(0, 7)}`;
}

function main() {
  const version = computeTestingVersion(process.env);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  packageJson.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(`Set package.json version to ${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
