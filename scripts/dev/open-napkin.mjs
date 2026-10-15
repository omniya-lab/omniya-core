import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const input = process.argv[2];

if (!input) {
  console.error('Usage: npm run open:napkin -- /path/to/file.napkin.json');
  process.exit(1);
}

const napkinFile = path.resolve(process.cwd(), input);
try {
  await access(napkinFile);
} catch {
  console.error(`Napkin file does not exist: ${napkinFile}`);
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npm, ['start'], {
  cwd: projectRoot,
  env: { ...process.env, OMNIYA_NAPKIN_FILE: napkinFile },
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (code !== 0) process.exitCode = code ?? 1;
  if (signal) process.exitCode = 1;
});
