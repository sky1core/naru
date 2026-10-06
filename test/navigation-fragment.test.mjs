import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import electron from 'electron';
import { Browser } from '../src/browser.mjs';

test('review navigation requires a full document load after an in-page event', async () => {
  const url = 'https://example.com/project#saved';
  const contents = new EventEmitter();
  Object.assign(contents, {
    debugger: { attach() {} }, session: { webRequest: { onErrorOccurred() {}, onCompleted() {} } },
    isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => url, getTitle: () => 'Project',
    async executeJavaScriptInIsolatedWorld() {
      contents.emit('did-start-navigation', {}, url, true, true);
      contents.emit('did-navigate-in-page', {}, url, true);
      contents.emit('did-finish-load');
      return { navigating: true };
    },
  });
  const browser = new Browser({ webContents: contents });
  let settled = false;
  const navigation = browser.navigateReview(url, { documentId: browser.documentId, url, inputHistory: '[]' }, undefined, Date.now() + 5000);
  navigation.finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const acceptedInPage = settled;
  contents.emit('did-start-navigation', {}, url, false, true);
  contents.emit('did-finish-load');
  const result = await navigation;
  assert.equal(acceptedInPage, false);
  assert.equal(result.url, url);
  assert.equal(contents.listenerCount('did-start-navigation'), 1);
  assert.equal(contents.listenerCount('did-finish-load'), 1);
  assert.equal(contents.listenerCount('did-fail-load'), 0);
  assert.equal(contents.listenerCount('will-prevent-unload'), 0);
});

test('protected project navigation loads new documents for saved fragments and queries', { timeout: 45000 }, async t => {
  await mkdir('artifacts/navigation-runs', { recursive: true });
  const root = await mkdtemp(resolve('artifacts/navigation-runs/run-'));
  const child = spawn(electron, [resolve('test/fixtures/navigation-fragment.mjs'), root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  await writeFile(join(root, 'stdout.txt'), stdout);
  await writeFile(join(root, 'stderr.txt'), stderr);
  assert.equal(code, 0, JSON.stringify({ signal, stdout, stderr }));
  const results = JSON.parse(await readFile(join(root, 'results.json'), 'utf8'));
  assert.equal(results.length, 13);
  for (const result of results) await t.test(result.name, () => assert.equal(result.passed, true, JSON.stringify(result)));
});
