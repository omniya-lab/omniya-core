#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(projectRoot, 'vendor', 'liblouis');
const outBin = path.join(outRoot, 'bin');
const outTables = path.join(outRoot, 'tables');
const noticePath = path.join(outRoot, 'NOTICE');
const windowsUrlFile = path.join(projectRoot, 'scripts', 'liblouis-windows-url.txt');
const FORBIDDEN_PREFIXES = ['/opt/homebrew', '/usr/local'];
const LICENSE_NAMES = new Set(['COPYING', 'LICENSE', 'NEWS']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result;
}

function tryRun(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options
  });
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(full);
      }
    }
  }
  return files;
}

function findFirst(files, predicate) {
  return files.find(predicate) ?? null;
}

function resetOutput() {
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outBin, { recursive: true });
  mkdirSync(outTables, { recursive: true });
}

function writeNotice(licenseFiles, fallbackUrl = '') {
  const parts = [];
  for (const file of licenseFiles) {
    if (!existsSync(file)) continue;
    parts.push(`===== ${path.basename(file)} =====\n${readFileSync(file, 'utf8').trim()}\n`);
  }
  if (parts.length === 0) {
    parts.push(
      'Liblouis is bundled as a separate helper (https://liblouis.io/).\n' +
      'Upstream: https://github.com/liblouis/liblouis\n' +
      (fallbackUrl ? `Download: ${fallbackUrl}\n` : '')
    );
  }
  writeFileSync(noticePath, `${parts.join('\n')}\n`);
}

function collectLicenseFiles(searchRoots) {
  const found = [];
  const seen = new Set();
  for (const root of searchRoots) {
    if (!existsSync(root)) continue;
    for (const file of walkFiles(root)) {
      const name = path.basename(file);
      if (!LICENSE_NAMES.has(name) || seen.has(name)) continue;
      seen.add(name);
      found.push(file);
    }
    for (const name of LICENSE_NAMES) {
      const direct = path.join(root, name);
      if (existsSync(direct) && !seen.has(name)) {
        seen.add(name);
        found.push(direct);
      }
    }
  }
  return found.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function requireStagedHelperAndTables(helperName) {
  const helper = path.join(outBin, helperName);
  const table = path.join(outTables, 'en-ueb-g2.ctb');
  if (!existsSync(helper)) {
    fail(`Staged helper missing: ${helper}`);
  }
  if (!existsSync(table)) {
    fail(`Staged UEB table missing: ${table}`);
  }
  console.log(`Staged liblouis at ${outRoot}`);
}

function brewEnv() {
  return { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' };
}

function resolveHomebrewPrefix() {
  const env = brewEnv();
  let prefixResult = tryRun('brew', ['--prefix', 'liblouis'], { env });
  let prefix = prefixResult.status === 0 ? prefixResult.stdout.trim() : '';
  const helper = prefix ? path.join(prefix, 'bin', 'lou_translate') : '';
  if (prefix && existsSync(helper)) {
    return prefix;
  }

  console.error('liblouis is not installed via Homebrew. Running: brew install liblouis');
  const install = tryRun('brew', ['install', 'liblouis'], { env, stdio: 'inherit' });
  if (install.status !== 0) {
    fail(
      'Could not install liblouis with Homebrew. Install it yourself with: brew install liblouis'
    );
  }

  prefixResult = tryRun('brew', ['--prefix', 'liblouis'], { env });
  prefix = prefixResult.status === 0 ? prefixResult.stdout.trim() : '';
  if (!prefix || !existsSync(path.join(prefix, 'bin', 'lou_translate'))) {
    fail('brew install liblouis succeeded but lou_translate was not found under brew --prefix liblouis');
  }
  return prefix;
}

function otoolOutput(file) {
  return run('otool', ['-L', file]).stdout;
}

function rewriteInstallNames(file) {
  chmodSync(file, 0o755);
  if (file.endsWith('.dylib')) {
    run('install_name_tool', ['-id', `@executable_path/${path.basename(file)}`, file]);
  }

  const lines = otoolOutput(file).split('\n').slice(1);
  for (const line of lines) {
    const dep = line.trim().split(/\s+/)[0];
    if (!dep) continue;
    const needsRewrite = FORBIDDEN_PREFIXES.some((prefix) => dep.startsWith(prefix));
    if (!needsRewrite) continue;
    run('install_name_tool', ['-change', dep, `@executable_path/${path.basename(dep)}`, file]);
  }

  const codesign = tryRun('codesign', ['--sign', '-', '--force', '--timestamp=none', file]);
  if (codesign.status !== 0) {
    const detail = (codesign.stderr || codesign.stdout || '').trim();
    fail(`codesign failed for ${file}${detail ? `:\n${detail}` : ''}`);
  }
}

function assertNoHomebrewPaths(helperPath) {
  const output = otoolOutput(helperPath);
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (output.includes(prefix)) {
      fail(
        `Staged helper still references ${prefix}. otool -L output:\n${output}`
      );
    }
  }
}

function stageDarwin() {
  const prefix = resolveHomebrewPrefix();
  const helperSrc = path.join(prefix, 'bin', 'lou_translate');
  const libDir = path.join(prefix, 'lib');
  const tablesSrc = path.join(prefix, 'share', 'liblouis', 'tables');
  if (!existsSync(tablesSrc)) {
    fail(`liblouis tables not found at ${tablesSrc}`);
  }

  copyFileSync(helperSrc, path.join(outBin, 'lou_translate'));
  chmodSync(path.join(outBin, 'lou_translate'), 0o755);

  if (!existsSync(libDir)) {
    fail(`liblouis lib directory not found at ${libDir}`);
  }
  for (const name of readdirSync(libDir)) {
    if (!name.startsWith('liblouis') || !name.endsWith('.dylib')) continue;
    copyFileSync(path.join(libDir, name), path.join(outBin, name));
  }

  cpSync(tablesSrc, outTables, { recursive: true });
  writeNotice(collectLicenseFiles([prefix]));

  const helperDst = path.join(outBin, 'lou_translate');
  rewriteInstallNames(helperDst);
  for (const name of readdirSync(outBin)) {
    if (!name.endsWith('.dylib')) continue;
    rewriteInstallNames(path.join(outBin, name));
  }
  assertNoHomebrewPaths(helperDst);
}

async function downloadFile(url, dest) {
  const response = await fetch(url);
  if (!response.ok) {
    fail(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(dest, buffer);
}

function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    run('tar', ['-xf', zipPath, '-C', destDir]);
    return;
  }
  run('unzip', ['-q', zipPath, '-d', destDir]);
}

async function stageWin32() {
  if (!existsSync(windowsUrlFile)) {
    fail(`Missing Windows download URL file: ${windowsUrlFile}`);
  }
  const url = readFileSync(windowsUrlFile, 'utf8').trim().split(/\r?\n/)[0]?.trim();
  if (!url) {
    fail(`${windowsUrlFile} must contain a single pinned win64 zip URL`);
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'liblouis-win-'));
  try {
    const zipPath = path.join(workDir, 'liblouis-win64.zip');
    console.log(`Downloading ${url}`);
    await downloadFile(url, zipPath);
    const extractDir = path.join(workDir, 'extracted');
    extractZip(zipPath, extractDir);

    const files = walkFiles(extractDir);
    const helperSrc = findFirst(files, (file) => path.basename(file).toLowerCase() === 'lou_translate.exe');
    if (!helperSrc) {
      fail('Windows zip did not contain lou_translate.exe');
    }
    copyFileSync(helperSrc, path.join(outBin, 'lou_translate.exe'));

    const dlls = files.filter((file) => /^liblouis.*\.dll$/i.test(path.basename(file)));
    if (dlls.length === 0) {
      fail('Windows zip did not contain a liblouis DLL');
    }
    for (const dll of dlls) {
      copyFileSync(dll, path.join(outBin, path.basename(dll)));
    }

    const tableMarker = findFirst(files, (file) => path.basename(file) === 'en-ueb-g2.ctb');
    if (!tableMarker) {
      fail('Windows zip did not contain tables/en-ueb-g2.ctb');
    }
    cpSync(path.dirname(tableMarker), outTables, { recursive: true });
    writeNotice(collectLicenseFiles([extractDir, path.dirname(helperSrc)]), url);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

resetOutput();

if (process.platform === 'darwin') {
  await Promise.resolve(stageDarwin());
  requireStagedHelperAndTables('lou_translate');
} else if (process.platform === 'win32') {
  await stageWin32();
  requireStagedHelperAndTables('lou_translate.exe');
} else {
  fail(
    `Unsupported platform ${process.platform}. stage-liblouis.mjs supports darwin and win32 only.`
  );
}
