import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

for (const dir of ['src', 'scripts', 'test']) {
  for (const name of readdirSync(dir).filter((name) => /\.(mjs|cjs)$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
