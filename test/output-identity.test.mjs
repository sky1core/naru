import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runOutput } from './fixtures/output-io-boundary.mjs';

async function fixture() {
  await mkdir('artifacts/output-runs', { recursive: true });
  const root = await mkdtemp(resolve('artifacts/output-runs/run-'));
  const directory = join(root, 'output');
  await mkdir(directory, { mode: 0o770 });
  return { root, directory, path: join(directory, 'answer.txt') };
}

for (const boundary of ['sync', 'link', 'unlink', 'cleanup']) {
  test(`directory replacement at ${boundary} preserves replacement files and cannot report success`, async () => {
    const { root, directory, path } = await fixture();
    const result = await runOutput(path, 'ORIGINAL ANSWER', boundary, directory);
    assert.equal(result.error?.code, 'review_output_write_failed');
    assert.equal(result.stderr, '');
    const injected = JSON.parse(await readFile(join(root, 'injected'), 'utf8'));
    assert.equal(injected.boundary, boundary);
    assert(injected.originalModes.length > 0);
    assert(injected.originalModes.every(entry => entry.mode === (entry.directory ? 0o700 : 0o600)));
    assert.deepEqual((await readdir(directory)).sort(), injected.replacementNames);
    for (const name of injected.replacementNames) {
      assert.equal(await readFile(join(directory, name), 'utf8'), `OTHER USER DATA:${name}`);
      assert.equal((await lstat(join(directory, name))).mode & 0o777, 0o644);
    }
    const original = join(root, 'original');
    assert.deepEqual(await readdir(original), boundary === 'cleanup' ? [] : ['answer.txt']);
    if (boundary !== 'cleanup') {
      assert.equal(await readFile(join(original, 'answer.txt'), 'utf8'), 'ORIGINAL ANSWER');
      assert.equal((await lstat(join(original, 'answer.txt'))).mode & 0o777, 0o600);
    }
  });
}

test('replacing the private staging name inside the output directory cannot delete a replacement file', async () => {
  const { root, directory, path } = await fixture();
  const result = await runOutput(path, 'ORIGINAL ANSWER', 'staging-replacement', directory);
  assert.equal(result.error?.code, 'review_output_write_failed');
  const staging = await readFile(join(root, 'replaced-name'), 'utf8');
  assert.equal(await readFile(join(directory, staging, 'answer'), 'utf8'), 'OTHER USER DATA');
  assert.equal((await lstat(join(directory, staging, 'answer'))).mode & 0o777, 0o644);
  assert.deepEqual(await readdir(join(directory, `${staging}.original`)), []);
  assert.equal(await readFile(path, 'utf8'), 'ORIGINAL ANSWER');
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test('an unrelated sibling created after file fsync preserves successful publication', async () => {
  const { directory, path } = await fixture();
  const text = '\uFEFF리뷰\r\n🙂\n\n';
  const result = await runOutput(path, text, 'sibling', directory);
  assert.equal(result.output, path);
  assert.equal(result.stderr, '');
  assert.deepEqual(await readFile(path), Buffer.from(text));
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(join(directory, 'unrelated.txt'), 'utf8'), 'unrelated data');
  assert.deepEqual((await readdir(directory)).sort(), ['answer.txt', 'unrelated.txt']);
});

for (const boundary of ['write-failure', 'file-sync-failure', 'directory-sync-failure']) {
  test(`child ${boundary} retains the existing output failure contract`, async () => {
    const { root, directory, path } = await fixture();
    await writeFile(join(directory, 'keep.txt'), 'keep');
    const text = '전체 결과\r\n🙂\n';
    const result = await runOutput(path, text, boundary, directory);
    assert.equal(result.error?.code, 'review_output_write_failed');
    assert.equal(result.stderr, '');
    assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'keep');
    if (boundary === 'directory-sync-failure') {
      assert.equal(await readFile(join(root, 'file-synced'), 'utf8'), 'complete');
      assert.equal(await readFile(join(root, 'directory-synced'), 'utf8'), 'attempted');
      assert.deepEqual(await readFile(path), Buffer.from(text));
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      assert.deepEqual((await readdir(directory)).sort(), ['answer.txt', 'keep.txt']);
    } else {
      await assert.rejects(lstat(path), { code: 'ENOENT' });
      assert.deepEqual(await readdir(directory), ['keep.txt']);
    }
  });
}

test('a replacement before child startup is rejected before creating any temporary file', async () => {
  const { root, directory, path } = await fixture();
  const result = await runOutput(path, 'ORIGINAL ANSWER', 'startup', directory);
  assert.equal(result.error?.code, 'review_output_write_failed');
  assert.equal(result.stderr, '');
  assert.deepEqual(await readdir(join(root, 'original')), []);
  assert.deepEqual(await readdir(directory), ['answer.txt']);
  assert.equal(await readFile(path, 'utf8'), 'OTHER USER DATA');
  assert.equal((await lstat(path)).mode & 0o777, 0o644);
});

test('the parent rejects an output inode replaced after child publication', async () => {
  const { directory, path } = await fixture();
  const result = await runOutput(path, 'ORIGINAL ANSWER', 'published-inode', directory);
  assert.equal(result.error?.code, 'review_output_write_failed');
  assert.equal(result.stderr, '');
  assert.equal(await readFile(path, 'utf8'), 'FORGED ANSWER');
  assert.equal(await readFile(join(directory, 'original-answer.txt'), 'utf8'), 'ORIGINAL ANSWER');
  assert.equal((await lstat(join(directory, 'original-answer.txt'))).mode & 0o777, 0o600);
});
