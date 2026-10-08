import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

await mkdir('artifacts/app-data', { recursive: true });
const appData = await mkdtemp(resolve('artifacts/app-data/run-'));
const entry = fileURLToPath(new URL('./fixtures/electron-entry.mjs', import.meta.url));

export function spawnElectron(args, options) {
  return spawn(electron, [entry, appData, ...args], options);
}
