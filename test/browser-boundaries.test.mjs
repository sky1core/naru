import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import electron from 'electron';

test('renderer boundaries preserve attachments, drafts and link identities', { timeout: 100000 }, async t => {
  await mkdir('artifacts/boundary-runs', { recursive: true });
  const root = await mkdtemp(resolve('artifacts/boundary-runs/run-'));
  const child = spawn(electron, [resolve('test/fixtures/browser-boundaries.mjs'), root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  await writeFile(join(root, 'stdout.txt'), stdout);
  await writeFile(join(root, 'stderr.txt'), stderr);
  assert.equal(code, 0, stderr);
  assert.equal(stderr.includes('PRIVATE_QUERY_SAMPLE'), false, stderr);
  assert.match(stderr, /Page navigation failed \(ERR_EMPTY_RESPONSE\)/);
  const results = JSON.parse(await readFile(join(root, 'results.json'), 'utf8'));
  assert.equal(results.length, 66);
  for (const result of results) await t.test(result.name, () => assert.equal(result.passed, true, JSON.stringify(result)));
});
