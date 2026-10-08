import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = `naru-test-${randomUUID()}`;
const output = join(root, 'artifacts', 'isolated-runs', name);
let created = false, started = false, artifactsReady = false, interrupted = 0;

function docker(args, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, detached: true,
      stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) return resolve();
      const error = new Error(`docker ${args[0]} failed (${signal === null ? code : signal}).`);
      error.exitCode = Number.isInteger(code) && code > 0 ? code : 1;
      reject(error);
    });
  });
}

function interrupt(signal) {
  if (interrupted) return;
  interrupted = signal === 'SIGINT' ? 130 : 143;
  console.error('Cancellation requested; waiting for the active container command to finish.');
}

function checkInterrupted() {
  if (interrupted) throw new Error('Test run interrupted.');
}

process.on('SIGINT', () => interrupt('SIGINT'));
process.on('SIGTERM', () => interrupt('SIGTERM'));

try {
  console.log(`Running tests in an isolated Docker container with Xvfb: ${name}`);
  await docker(['create', '--init', '--name', name, '--cap-add=SYS_ADMIN', '--shm-size=512m',
    '--workdir=/work', 'node:22.15.0-bookworm-slim', 'sleep', 'infinity'], true);
  created = true;
  checkInterrupted();
  await docker(['start', name], true);
  started = true;
  checkInterrupted();
  await docker(['exec', name, 'mkdir', '-p', '/work/artifacts'], true);
  artifactsReady = true;
  for (const path of ['package.json', 'package-lock.json', 'src', 'scripts', 'test']) {
    checkInterrupted();
    await docker(['cp', join(root, path), `${name}:/work/${path}`], true);
  }
  checkInterrupted();
  await docker(['exec', name, 'sh', 'scripts/test-container.sh']);
  const tests = (await readdir(join(root, 'test'))).filter(path => path.endsWith('.test.mjs')).sort();
  checkInterrupted();
  await docker(['exec', '--user', 'node', name, 'xvfb-run', '-a', 'node', '--test', '--test-concurrency=1',
    ...process.argv.slice(2), ...tests.map(path => `test/${path}`)]);
} catch (error) {
  console.error(error.message);
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
} finally {
  if (created) {
    try {
      if (started) await docker(['stop', '--timeout=-1', name], true);
      try {
        if (artifactsReady) {
          await mkdir(output, { recursive: true });
          await docker(['cp', `${name}:/work/artifacts/.`, output], true);
          console.log(`Test artifacts: ${output}`);
        }
      } finally {
        await docker(['rm', name], true);
      }
    } catch (error) {
      console.error(`Test cleanup failed for ${name}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (interrupted) process.exitCode = interrupted;
}
