import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = (await readdir(new URL('../test/', import.meta.url))).filter(path => path.endsWith('.test.mjs')).sort();
let interrupted = 0;
function interrupt(code) {
  if (interrupted) return;
  interrupted = code;
  console.error('Cancellation requested; waiting for the active tests to finish.');
}
process.on('SIGINT', () => interrupt(130));
process.on('SIGTERM', () => interrupt(143));
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2),
  ...tests.map(path => `test/${path}`)], { cwd: root, detached: true, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = interrupted || (code === null ? 1 : code); });
