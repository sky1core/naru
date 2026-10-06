import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reviewCLI } from '../src/review-cli.mjs';
import { loadReviewFiles } from '../src/review-files.mjs';
import { maxRequestBytes } from '../src/protocol.mjs';
import { readJSONFile } from '../src/cli-files.mjs';

const tooLarge = error => error.code === 'body_too_large';
async function fixture() { return fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'review-budget-'))); }
async function measureReads(t, paths) {
  const counts = new Map(paths.map(path => [path, 0]));
  const originalOpen = fsp.open, originalRead = fsp.readFile;
  t.mock.method(fsp, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (counts.has(args[0])) {
      const read = handle.read.bind(handle);
      handle.read = async (...params) => {
        const result = await read(...params);
        counts.set(args[0], counts.get(args[0]) + result.bytesRead);
        return result;
      };
    }
    return handle;
  });
  t.mock.method(fsp, 'readFile', async (...args) => {
    const result = await originalRead(...args);
    if (counts.has(args[0])) counts.set(args[0], counts.get(args[0]) + Buffer.byteLength(result));
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return counts;
}

test('CLI rejects a stat-known oversized source before reading any of its bytes', async (t) => {
  const dir = await fixture(), source = join(dir, 'large.txt');
  await fsp.writeFile(source, Buffer.alloc(maxRequestBytes + 1, 97));
  const counts = await measureReads(t, [source]);
  await assert.rejects(reviewCLI('prepare', undefined, { question: 'q', file: [source], 'base-dir': dir, out: join(dir, 'out.json') }), tooLarge);
  assert.equal(counts.get(source), 0);
});

test('CLI accumulates byte counts and rejects the next source without reading it', async (t) => {
  const dir = await fixture(), first = join(dir, 'first.txt'), second = join(dir, 'second.txt');
  await fsp.writeFile(first, Buffer.alloc(5 * 1024 * 1024, 97));
  await fsp.writeFile(second, Buffer.alloc(4 * 1024 * 1024, 98));
  const counts = await measureReads(t, [first, second]);
  await assert.rejects(reviewCLI('prepare', undefined, { question: 'q', file: [first, second], 'base-dir': dir, out: join(dir, 'out.json') }), tooLarge);
  assert.equal(counts.get(first), 5 * 1024 * 1024);
  assert.equal(counts.get(second), 0);
});

test('question and metadata exceeding request budget fail before source reads', async (t) => {
  const dir = await fixture(), source = join(dir, 'source.txt');
  await fsp.writeFile(source, 'source');
  const counts = await measureReads(t, [source]);
  for (const question of ['q'.repeat(maxRequestBytes + 1), '\0'.repeat(Math.ceil(maxRequestBytes / 6))]) {
    await assert.rejects(reviewCLI('prepare', undefined, { question, file: [source], 'base-dir': dir, out: join(dir, 'out.json') }), tooLarge);
  }
  await assert.rejects(reviewCLI('prepare', undefined, { question: 'q', file: ['p'.repeat(maxRequestBytes + 1)], 'base-dir': dir, out: join(dir, 'metadata.json') }), tooLarge);
  assert.equal(counts.get(source), 0);
});

test('JSON escaping still rejects a raw source that fits the byte budget', async (t) => {
  const dir = await fixture(), source = join(dir, 'escapes.txt');
  const bytes = Buffer.alloc(Math.ceil(maxRequestBytes / 6), 0);
  await fsp.writeFile(source, bytes);
  const counts = await measureReads(t, [source]);
  await assert.rejects(reviewCLI('prepare', undefined, { question: 'q', file: [source], 'base-dir': dir, out: join(dir, 'out.json') }), tooLarge);
  assert.equal(counts.get(source), bytes.length);
});

test('final oversized request and checkpoint commands reject after bounded streaming reads', async (t) => {
  const dir = await fixture(), request = join(dir, 'request.json'), previous = join(dir, 'answer.txt');
  const checkpoint = `${previous}.request.json`;
  const command = { action: 'review.prepare', reviewId: randomUUID(), question: 'q'.repeat(3 * maxRequestBytes), files: [] };
  await fsp.writeFile(request, JSON.stringify(command));
  await fsp.writeFile(checkpoint, JSON.stringify({ version: 2, profile: dir, reviewId: command.reviewId,
    prepareRequestId: randomUUID(), promptHash: 'a'.repeat(64), command }));
  const counts = await measureReads(t, [request, checkpoint]);
  const sizes = new Map(await Promise.all([request, checkpoint].map(async path => [path, (await fsp.stat(path)).size])));
  const originalOpen = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (sizes.has(args[0])) {
      const read = handle.read.bind(handle);
      handle.read = async (...params) => {
        assert(params[2] <= 65536);
        return read(...params);
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(reviewCLI('prepare', undefined, { request, out: join(dir, 'out.json') }), tooLarge);
  await assert.rejects(reviewCLI('prepare', undefined, { profile: dir, question: 'q', 'continue-from': previous, out: join(dir, 'follow.json') }), tooLarge);
  assert.equal(counts.get(request), sizes.get(request));
  assert.equal(counts.get(checkpoint), sizes.get(checkpoint));
});

test('near-limit prepared JSON is accepted through --request with exact source and hash', async () => {
  const dir = await fixture(), source = join(dir, 'source.txt'), prepared = join(dir, 'prepared.json'), copied = join(dir, 'copied.json');
  const reviewId = randomUUID();
  const skeleton = { action: 'review.prepare', reviewId, question: 'q', part: { index: 1, total: 2 },
    files: [{ path: 'source.txt', content: '', sha256: 'a'.repeat(64), bytes: maxRequestBytes }] };
  const overhead = Buffer.byteLength(JSON.stringify({ id: randomUUID(), deadlineMs: 120000, command: skeleton }));
  const content = 'x'.repeat(maxRequestBytes - overhead - 1);
  await fsp.writeFile(source, content);
  await reviewCLI('prepare', undefined, { id: reviewId, question: 'q', part: '1/2', file: [source], 'base-dir': dir, out: prepared });
  const command = JSON.parse(await fsp.readFile(prepared, 'utf8'));
  const wireBytes = Buffer.byteLength(JSON.stringify({ id: randomUUID(), deadlineMs: 120000, command }));
  assert(wireBytes <= maxRequestBytes);
  assert(wireBytes > maxRequestBytes - 256);
  assert((await fsp.stat(prepared)).size > maxRequestBytes);
  await reviewCLI('prepare', undefined, { request: prepared, out: copied });
  const result = JSON.parse(await fsp.readFile(copied, 'utf8'));
  assert.deepEqual(result, command);
  assert.equal(result.files[0].bytes, Buffer.byteLength(content));
  assert.equal(result.files[0].sha256, createHash('sha256').update(content).digest('hex'));
});

test('loader retains unlimited default and enforces only an explicit aggregate byte budget', async (t) => {
  const dir = await fixture(), source = join(dir, 'large.txt');
  await fsp.writeFile(source, Buffer.alloc(maxRequestBytes + 1, 97));
  const [file] = await loadReviewFiles([source], { baseDir: dir });
  assert.equal(file.bytes, maxRequestBytes + 1);
  const counts = await measureReads(t, [source]);
  await assert.rejects(loadReviewFiles([source], { baseDir: dir, maxBytes: maxRequestBytes }), tooLarge);
  assert.equal(counts.get(source), 0);
});

test('budgeted source and direct JSON reads reject growth without consuming the appended file', async (t) => {
  for (const json of [false, true]) {
    await t.test(json ? 'direct JSON' : 'review source', async (t) => {
      const dir = await fixture(), source = join(dir, json ? 'input.json' : 'source.txt');
      await fsp.writeFile(source, json ? '{"q":"bad\\q"}' : 'original');
      const originalSize = (await fsp.stat(source)).size;
      const originalOpen = fsp.open;
      let bytesRead = 0, grew = false;
      t.mock.method(fsp, 'open', async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === source) {
          const read = handle.read.bind(handle);
          handle.read = async (...params) => {
            const result = await read(...params);
            bytesRead += result.bytesRead;
            if (!grew) {
              grew = true;
              await fsp.appendFile(source, Buffer.alloc(maxRequestBytes + 1, 97));
            }
            return result;
          };
        }
        return handle;
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(json ? readJSONFile(source) : loadReviewFiles([source], { baseDir: dir, maxBytes: maxRequestBytes }),
          error => error.code === (json ? 'input_file_changed' : 'review_file_changed'));
        assert(grew);
        assert.equal(bytesRead, originalSize + 1);
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    });
  }
});

test('bounded JSON preserves BOM semantics and rejects invalid UTF-8 without source fragments', async () => {
  const dir = await fixture(), source = join(dir, 'input.json');
  await fsp.writeFile(source, Buffer.from([0xc3, 0x28]));
  await assert.rejects(readJSONFile(source), { code: 'invalid_utf8' });
  await fsp.writeFile(source, '\uFEFF{"q":"한글🙂"}\r\n');
  await assert.rejects(readJSONFile(source), { code: 'invalid_json' });
  const request = { id: randomUUID(), command: { action: 'fill', documentId: randomUUID(),
    target: { attribute: 'id', value: 'composer' }, text: '한글🙂' } };
  await fsp.writeFile(source, JSON.stringify(request) + '\r\n');
  assert.deepEqual(await readJSONFile(source), request);
});

test('oversized direct prepared content is rejected without serializing it again', async (t) => {
  const dir = await fixture(), source = join(dir, 'request.json');
  const content = 'x'.repeat(maxRequestBytes + 1);
  const command = { action: 'review.prepare', reviewId: randomUUID(), question: 'q', files: [{ path: 'source.txt', content,
    bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }] };
  await fsp.writeFile(source, JSON.stringify(command));
  const stringify = JSON.stringify;
  let sourceSerializations = 0;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    const files = value?.command?.files ?? value?.files;
    if (files?.some(file => file.content === content)) sourceSerializations++;
    return stringify(value, ...args);
  });
  await assert.rejects(reviewCLI('prepare', undefined, { request: source, out: join(dir, 'out.json') }), tooLarge);
  assert.equal(sourceSerializations, 0);
});
