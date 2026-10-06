import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Reviews } from '../src/review.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, win32 } from 'node:path';
import { writePrivateJSON } from '../src/profile.mjs';
import { loadReviewFiles } from '../src/review-files.mjs';
import { Journal } from '../src/journal.mjs';
import { startServer } from '../src/server.mjs';
import { request as httpRequest } from 'node:http';

const fixture = () => {
  fs.mkdirSync('artifacts/record-runs', { recursive: true });
  return fs.mkdtempSync(resolve('artifacts/record-runs/run-'));
};

test('review status separates completed results from previous failures without mutating records or using the browser', async t => {
  for (const state of ['completed', 'submitted', 'uncertain', 'send_attempted', 'failed']) {
    await t.test(state, async t => {
      const profile = fixture();
      const browser = {
        reviewView() { assert.fail('Status must not observe the browser.'); },
        execute() { assert.fail('Status must not dispatch browser input.'); },
      };
      const reviews = new Reviews(profile, browser);
      const content = 'original source\r\n🙂';
      const command = { action: 'review.prepare', reviewId: randomUUID(), question: 'original input', files: [
        { path: 'source.txt', content, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) },
      ] };
      const prepared = reviews.prepare(command);
      const error = { code: 'command_timeout', message: 'Previous submission exceeded its deadline.' };
      const lastFailure = { phase: 'sending', at: new Date().toISOString(), error };
      const answer = `original answer\nEND-OF-REVIEW:${prepared.id}`;
      const record = reviews.save(prepared, { state, error, lastFailure,
        ...(state === 'completed' ? { answer, answerHash: createHash('sha256').update(answer).digest('hex'), responseId: randomUUID() } : {}),
      });
      const recordPath = join(profile, 'reviews', `${prepared.id}.json`);
      const original = fs.readFileSync(recordPath);
      const { server, descriptor } = await startServer({ profile, browser, quit() { assert.fail('Status must not quit the app.'); } });
      writePrivateJSON(join(profile, 'connection.json'), descriptor);
      t.after(async () => { await new Promise(resolveClose => server.close(resolveClose)); });
      const response = await fetch(`${descriptor.origin}/v1/reviews/${prepared.id}`, {
        headers: { Authorization: `Bearer ${descriptor.token}` },
      });
      assert.equal(response.status, 200);
      const actual = await response.json();
      const { error: oldError, ...completed } = record;
      assert.deepEqual(actual, state === 'completed' ? completed : record);
      const { stdout } = await promisify(execFile)(process.execPath, ['src/cli.mjs', '--profile', profile, 'review-status', prepared.id]);
      const cli = JSON.parse(stdout);
      const { prompt, answer: storedAnswer, ...status } = state === 'completed' ? completed : record;
      assert.deepEqual(cli, { ...status, promptCharacters: prompt.length,
        ...(storedAnswer === undefined ? {} : { answerCharacters: storedAnswer.length }),
      });
      assert.deepEqual(fs.readFileSync(recordPath), original);
      assert.deepEqual(fs.readdirSync(join(profile, 'requests')), []);
    });
  }
});

test('completed review commands clear obsolete current errors without replaying input or replacing their result and failure history', async t => {
  for (const action of ['review.prepare', 'review.submit', 'review.collect']) await t.test(action, async t => {
    const profile = fixture();
    const browser = {
      reviewView() { assert.fail('Cached preparation must not observe the browser.'); },
      execute() { assert.fail('Cached preparation must not dispatch browser input.'); },
    };
    const reviews = new Reviews(profile, browser);
    const content = 'original source\r\n🙂';
    const command = { action: 'review.prepare', reviewId: randomUUID(), question: 'original input', files: [
      { path: 'source.txt', content, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) },
    ] };
    const prepared = reviews.prepare(command);
    const error = { code: 'command_timeout', message: 'Previous submission exceeded its deadline.' };
    const lastFailure = { phase: 'sending', at: new Date().toISOString(), error };
    const answer = `original answer\nEND-OF-REVIEW:${prepared.id}`;
    const original = reviews.save(prepared, { state: 'completed', error, lastFailure, answer,
      answerHash: createHash('sha256').update(answer).digest('hex'), responseId: randomUUID(),
      userMessageId: randomUUID(), sendAttemptedAt: new Date().toISOString(),
    });
    const { server, descriptor } = await startServer({ profile, browser, quit() { assert.fail('Preparation must not quit the app.'); } });
    t.after(async () => { await new Promise(resolveClose => server.close(resolveClose)); });
    const response = await fetch(descriptor.origin + '/v1/commands', { method: 'POST', headers: {
      Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ id: randomUUID(), command: action === 'review.prepare' ? command : {
      action, reviewId: prepared.id, ...(action === 'review.submit' ? { documentId: randomUUID() } : { waitMs: 0 }),
    } }) });
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    const { error: oldError, updatedAt: oldUpdatedAt, ...expected } = original;
    const { updatedAt: newUpdatedAt, ...actual } = result;
    assert.deepEqual(actual, expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(profile, 'reviews', `${prepared.id}.json`), 'utf8')), result);
  });
});

test('failed initial record writes leave no partial final record and the same ID can be prepared', t => {
  const profile = fixture();
  const journal = new Journal(profile);
  const id = randomUUID();
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (fd, text) => {
    original(fd, text.slice(0, 10));
    throw Object.assign(new Error('Injected storage failure'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => journal.begin(id, { action: 'click' }), { code: 'EIO' });
  assert.equal(fs.existsSync(join(profile, 'requests', `${id}.json`)), false);
  assert.deepEqual(fs.readdirSync(join(profile, 'requests')), []);
  t.mock.restoreAll(); syncBuiltinESMExports();
  const { fresh, record } = journal.begin(id, { action: 'click' });
  assert.equal(fresh, true);
  assert.equal(journal.get(id).state, 'started');
  journal.finish(record, { state: 'completed', result: { dispatched: true } });
  assert.deepEqual(journal.get(id).result, { dispatched: true });
});

test('private record publication is whole, exclusive, and preserves an existing record on write failure', t => {
  const profile = fixture();
  const path = join(profile, 'record.json');
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (fd, text) => {
    assert.equal(fs.existsSync(path), false);
    original(fd, text);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  writePrivateJSON(path, { value: 'original' }, true);
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.throws(() => writePrivateJSON(path, { value: 'other' }, true), { code: 'EEXIST' });
  t.mock.method(fs, 'writeFileSync', (fd, text) => {
    original(fd, text.slice(0, 10));
    throw Object.assign(new Error('Injected storage failure'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  assert.throws(() => writePrivateJSON(path, { value: 'replacement' }), { code: 'EIO' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), { value: 'original' });
  assert.deepEqual(fs.readdirSync(profile), ['record.json']);
});

test('synchronous preparation cannot succeed after its public API execution deadline', async t => {
  const profile = fixture();
  const { server, descriptor } = await startServer({ profile, browser: {}, quit() {} });
  t.after(async () => { await new Promise(resolveClose => server.close(resolveClose)); });
  const sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', fd => {
    const until = performance.now() + 15;
    while (performance.now() < until) {}
    return sync(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const id = randomUUID();
  const response = await fetch(descriptor.origin + '/v1/commands', { method: 'POST', headers: {
    Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ id, deadlineMs: 5, command: { action: 'review.prepare', reviewId: randomUUID(), question: 'review', files: [] } }) });
  assert.equal(response.status, 504);
  const record = await response.json();
  assert.equal(record.state, 'uncertain');
  assert.equal(record.error.code, 'command_timeout');
  assert.equal(new Journal(profile).get(id).state, 'uncertain');
});

test('an oversized unfinished HTTP request receives an explicit rejection without creating a record', { timeout: 5000 }, async t => {
  const profile = fixture();
  const { server, descriptor } = await startServer({ profile, browser: {}, quit() {} });
  t.after(async () => { await new Promise(resolveClose => server.close(resolveClose)); });
  const result = await new Promise((resolveResponse, reject) => {
    const request = httpRequest(descriptor.origin + '/v1/commands', { method: 'POST', headers: {
      Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json',
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { request.destroy(); resolveResponse({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.write(Buffer.alloc(8 * 1024 * 1024 + 1, 97));
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'body_too_large');
  assert.deepEqual(fs.readdirSync(join(profile, 'requests')), []);
});

test('prepared POSIX file names are accepted unchanged by the public review API', async t => {
  const profile = fixture();
  const names = ['a\\b.txt', 'C:notes.txt'];
  for (const name of names) fs.writeFileSync(join(profile, name), 'exact source');
  const files = await loadReviewFiles(names, { baseDir: profile });
  const { server, descriptor } = await startServer({ profile, browser: {}, quit() {} });
  t.after(async () => { await new Promise(resolveClose => server.close(resolveClose)); });
  const response = await fetch(descriptor.origin + '/v1/commands', { method: 'POST', headers: {
    Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ id: randomUUID(), command: {
    action: 'review.prepare', reviewId: randomUUID(), question: 'Review exact file names.', files,
  } }) });
  const record = await response.json();
  assert.equal(response.status, 200, JSON.stringify(record));
  assert.deepEqual(record.result.sources.map(file => file.path), names);
  const payload = JSON.parse(record.result.prompt.split('\n')[2]);
  assert.deepEqual(payload.files.map(file => file.path), names);
  assert(payload.files.every(file => file.content === 'exact source'));
  for (const path of ['/private/source.txt', 'C:/source.txt', win32.resolve('C:/', 'source.txt'), '\\\\server\\source.txt', '../source.txt', 'a//b', 'a/./b', 'a/']) {
    const rejected = await fetch(descriptor.origin + '/v1/commands', { method: 'POST', headers: {
      Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ id: randomUUID(), command: {
      action: 'review.prepare', reviewId: randomUUID(), question: 'Reject ambiguous paths.', files: [{ ...files[0], path }],
    } }) });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'invalid_source_path');
  }
});

test('the CLI total collection timeout bounds slow review reads without publishing late output', { timeout: 12000 }, async t => {
  for (const delayedRead of [1, 2]) await t.test(`review read ${delayedRead}`, async t => {
    const profile = fixture();
    const reviews = new Reviews(profile, {});
    const command = { action: 'review.prepare', reviewId: randomUUID(), question: 'original', files: [] };
    const prepared = reviews.prepare(command);
    const answer = `Original answer\nEND-OF-REVIEW:${prepared.id}`;
    const completed = reviews.save(prepared, { state: 'completed', answer, answerHash: createHash('sha256').update(answer).digest('hex'), responseId: 'original-response' });
    const out = join(profile, 'answer.txt');
    const checkpoint = JSON.stringify({ version: 2, profile, reviewId: prepared.id, command, promptHash: completed.promptHash, prepareRequestId: randomUUID() });
    fs.writeFileSync(out + '.request.json', checkpoint);
    const wrapper = join(profile, 'timed-cli.mjs');
    fs.writeFileSync(wrapper, `const start=performance.now();try{await import(${JSON.stringify(pathToFileURL(resolve('src/cli.mjs')).href)})}finally{console.error(JSON.stringify({elapsedMs:performance.now()-start}))}`);
    const { server, descriptor } = await startServer({ profile, browser: {}, quit() {} });
    writePrivateJSON(join(profile, 'connection.json'), descriptor);
    t.after(async () => { await new Promise(resolveClose => server.close(resolveClose)); });
    let reads = 0;
    let delaying = true;
    server.prependListener('request', (request, response) => {
      if (!delaying || ![ `/v1/reviews/${prepared.id}`, '/v1/commands' ].includes(request.url) || ++reads !== delayedRead) return;
      const end = response.end.bind(response);
      response.end = (...args) => {
        const timer = setTimeout(() => { if (!response.destroyed) end(...args); }, 1500);
        response.once('close', () => clearTimeout(timer));
        return response;
      };
    });
    const exec = promisify(execFile);
    await assert.rejects(exec(process.execPath, [wrapper, '--profile', profile, 'collect', '--out', out, '--timeout', String(delayedRead === 1 ? 50 : 200), '--deadline', '120000']), error => {
      assert.match(error.stderr, /review_pending/);
      const elapsed = JSON.parse(error.stderr.trim().split('\n').at(-1)).elapsedMs;
      assert(elapsed < 800, `Collection exceeded its total timeout: ${elapsed}ms`);
      return true;
    });
    assert.equal(reads, delayedRead);
    if (delayedRead === 2) {
      const records = fs.readdirSync(join(profile, 'requests')).map(name => JSON.parse(fs.readFileSync(join(profile, 'requests', name), 'utf8')));
      assert.equal(records.length, 1);
      const expected = createHash('sha256').update(JSON.stringify({ command: { action: 'review.collect', reviewId: prepared.id, waitMs: 0 }, deadlineMs: 120000 })).digest('hex');
      assert.equal(records[0].digest, expected, 'Collection must preserve the explicit API execution deadline');
    }
    assert.equal(fs.readFileSync(out + '.request.json', 'utf8'), checkpoint);
    assert.equal(fs.existsSync(out), false);
    delaying = false;
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'collect', '--out', out, '--timeout', '3000']);
    assert.equal(fs.readFileSync(out, 'utf8'), answer);
    assert.equal(reviews.get(prepared.id).state, 'completed');
  });
});

test('a synchronous storage failure after the API deadline retains an uncertain timeout outcome', async t => {
  const profile = fixture();
  const { server, descriptor } = await startServer({ profile, browser: {}, quit() {} });
  t.after(async () => { await new Promise(resolveClose => server.close(resolveClose)); });
  const write = fs.writeFileSync;
  const sync = fs.fsyncSync;
  let failSync = false;
  t.mock.method(fs, 'writeFileSync', (fd, text) => {
    failSync = Boolean(JSON.parse(text).prompt);
    return write(fd, text);
  });
  t.mock.method(fs, 'fsyncSync', fd => {
    if (failSync) {
      failSync = false;
      const until = performance.now() + 15;
      while (performance.now() < until) {}
      throw Object.assign(new Error('Injected storage failure after deadline'), { code: 'EIO' });
    }
    return sync(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const id = randomUUID();
  const response = await fetch(descriptor.origin + '/v1/commands', { method: 'POST', headers: {
    Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ id, deadlineMs: 5, command: { action: 'review.prepare', reviewId: randomUUID(), question: 'review', files: [] } }) });
  const record = await response.json();
  assert.equal(response.status, 504);
  assert.equal(record.state, 'uncertain');
  assert.equal(record.error.code, 'command_timeout');
  assert.equal(new Journal(profile).get(id).state, 'uncertain');
});
