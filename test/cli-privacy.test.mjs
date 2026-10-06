import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cliPath = resolve('src/cli.mjs');
const secret = 'SYNTHETIC_PRIVATE_INPUT';
async function fixture(t, { heapMiB } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cli-privacy-')));
  const profile = join(dir, 'profile');
  await mkdir(profile, { mode: 0o700 });
  const requests = [];
  const log = join(dir, 'requests.jsonl'), preload = join(dir, 'fetch-boundary.mjs');
  await writeFile(log, '');
  const token = randomBytes(32).toString('hex');
  await writeFile(preload, `import { appendFile } from 'node:fs/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { identityProof } from ${JSON.stringify(new URL('../src/server-identity.mjs', import.meta.url).href)};
const sockets = new WeakMap();
http.request = (url, options, callback) => {
  const outgoing = new EventEmitter();
  if (!sockets.has(options.agent)) sockets.set(options.agent, { destroyed: false, writable: true, localPort: 12345, remotePort: 34567 });
  outgoing.socket = sockets.get(options.agent);
  outgoing.shouldKeepAlive = true;
  outgoing.destroy = error => { outgoing.emit('error', error); };
  outgoing.end = async body => {
    const path = new URL(url).pathname;
    const request = body ? JSON.parse(body) : undefined;
    const response = new EventEmitter();
    response.headers = { connection: 'keep-alive' };
    response.statusCode = 200;
    let result;
    if (path === '/v1/identity') {
      const nonce = options.headers['X-Naru-Nonce'];
      result = { nonce, proof: identityProof(${JSON.stringify(token)}, nonce, outgoing.socket.localPort, outgoing.socket.remotePort) };
    } else {
      await appendFile(${JSON.stringify(log)}, JSON.stringify({ path, request }) + '\\n');
      if (request?.command?.action === 'review.prepare') {
        response.statusCode = 409;
        result = { error: { code: 'busy', message: 'Synthetic busy response.' } };
      } else result = { id: request?.id, state: 'completed', result: {} };
    }
    outgoing.emit('socket', outgoing.socket);
    callback(response);
    response.emit('data', Buffer.from(JSON.stringify(result)));
    response.emit('end');
  };
  return outgoing;
};
syncBuiltinESMExports();`);
  await writeFile(join(profile, 'connection.json'), JSON.stringify({ version: 1, pid: process.pid,
    origin: 'http://127.0.0.1:34567', token }), { mode: 0o600 });
  const cli = async (...args) => {
    let result;
    try { result = { code: 0, ...await exec(process.execPath, [...(heapMiB === undefined ? [] : [`--max-old-space-size=${heapMiB}`]), '--import', preload, cliPath, '--profile', profile, ...args], { cwd: dir }) }; }
    catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    requests.splice(0, requests.length, ...(await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    return result;
  };
  return { dir, profile, requests, cli };
}
const errorOf = (result) => JSON.parse(result.stderr.trim().split('\n').at(-1)).error;

test('malformed run, prepared input and continuation checkpoint JSON never expose source text', async (t) => {
  const { dir, cli, requests } = await fixture(t);
  const invalid = join(dir, 'invalid.json');
  await writeFile(invalid, secret);
  const previous = join(dir, 'previous.txt');
  await writeFile(`${previous}.request.json`, secret);
  for (const args of [
    ['run', '--file', invalid],
    ['prepare', '--request', invalid, '--out', join(dir, 'prepared.json')],
    ['prepare', '--question', 'follow up', '--continue-from', previous, '--out', join(dir, 'follow.json')],
    ['collect', '--out', previous],
    ['submit', '--out', previous],
  ]) {
    const result = await cli(...args);
    assert.equal(result.code, 1);
    assert.equal(errorOf(result).code, 'invalid_json');
    assert.equal(errorOf(result).message, 'Input file must contain valid JSON; no request was submitted.');
    assert(!`${result.stdout}${result.stderr}`.includes(secret));
  }
  assert.equal(requests.length, 0);
});

test('schema errors and file errors do not expose input keys or private paths', async (t) => {
  const { dir, cli, requests } = await fixture(t);
  const input = join(dir, 'invalid-schema.json');
  await writeFile(input, JSON.stringify({ id: randomUUID(), command: { action: 'quit', [secret]: true } }));
  const prepared = join(dir, 'invalid-prepared.json');
  await writeFile(prepared, JSON.stringify({ action: 'review.prepare', reviewId: randomUUID(), question: 'q', files: [], [secret]: true }));
  for (const args of [
    ['run', '--file', input],
    ['prepare', '--request', prepared, '--out', join(dir, 'answer.json')],
    ['run', '--file', join(dir, secret)],
  ]) {
    const result = await cli(...args);
    assert.equal(result.code, 1);
    assert(!`${result.stdout}${result.stderr}`.includes(secret));
    assert(!`${result.stdout}${result.stderr}`.includes(dir));
  }
  assert.equal(requests.length, 0);
});

test('command option allowlists reject ignored options before reading files or connecting', async (t) => {
  const { dir } = await fixture(t);
  const invalidProfile = join(dir, 'missing-profile');
  for (const args of [
    ['fill', '--file', 'missing.txt', '--base-dir', dir],
    ['run', '--file', 'missing.json', '--id', randomUUID()],
    ['run', '--file', 'missing.json', '--deadline', '1'],
    ['status', '--file', 'missing.txt'],
    ['click', '--timeout', '1'],
    ['prepare', '--question', 'q', '--out', 'out.json', '--timeout', '1'],
    ['prepare', '--question', 'q', '--out', 'out.json', '--deadline', '1'],
    ['ask', '--request', 'missing.json', '--question', 'q', '--out', 'out.txt'],
    ['doctor', '--id', randomUUID()],
    ['review-status', randomUUID(), '--out', 'out.txt'],
    ['unknown-command', '--file', 'missing.txt'],
  ]) {
    await assert.rejects(exec(process.execPath, [cliPath, '--profile', invalidProfile, ...args]), error => {
      assert.equal(errorOf(error).code, 'invalid_arguments', args.join(' '));
      assert(!error.stderr.includes(invalidProfile));
      return true;
    });
  }
});

test('default parse options, normal command options and explicit request JSON are preserved', async (t) => {
  const { dir, cli, requests } = await fixture(t);
  assert.equal((await cli('status')).code, 0);
  assert.equal(requests.at(-1).path, '/v1/status');
  assert.equal((await cli('fill', '--help')).code, 0);
  const document = randomUUID(), id = randomUUID();
  await writeFile(join(dir, 'source.txt'), '\uFEFF한글\r\n🙂');
  assert.equal((await cli('fill', '--document', document, '--attr', 'id', '--value', 'composer', '--file', 'source.txt', '--id', id, '--deadline', '2000')).code, 0);
  assert.equal(requests.at(-1).request.id, id);
  assert.equal(requests.at(-1).request.deadlineMs, 2000);
  assert.equal(requests.at(-1).request.command.text, '\uFEFF한글\r\n🙂');
  assert.equal((await cli('wait', '--document', document, '--attr', 'id', '--value', 'composer', '--state', 'absent', '--timeout', '1500', '--deadline', '2000')).code, 0);
  assert.equal(requests.at(-1).request.command.state, 'absent');
  assert.equal(requests.at(-1).request.command.timeoutMs, 1500);
  assert.equal(requests.at(-1).request.deadlineMs, 2000);
  const jsonRequest = { id: randomUUID(), deadlineMs: 3000, command: { action: 'quit' } };
  await writeFile(join(dir, 'request.json'), JSON.stringify(jsonRequest));
  assert.equal((await cli('run', '--file', 'request.json')).code, 0);
  assert.deepEqual(requests.at(-1).request, jsonRequest);
});

test('offline prepare keeps source, effort, multipart and continuation options', async (t) => {
  const { dir, profile, cli, requests } = await fixture(t);
  const source = '\uFEFFsource\r\n🙂';
  await writeFile(join(dir, 'source.txt'), source);
  const output = join(dir, 'input.json');
  const id = randomUUID();
  assert.equal((await cli('prepare', '--question', 'q', '--file', 'source.txt', '--base-dir', dir,
    '--effort', 'max', '--part', '1/2', '--id', id, '--out', output)).code, 0);
  const command = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(command.reviewId, id);
  assert.equal(command.effort, 'max');
  assert.deepEqual(command.part, { index: 1, total: 2 });
  assert.equal(command.files[0].content, source);
  const previous = join(dir, 'previous.txt');
  const { composeReviewPrompt } = await import('../src/review-files.mjs');
  const promptHash = createHash('sha256').update(composeReviewPrompt({ id, ...command })).digest('hex');
  await writeFile(`${previous}.request.json`, JSON.stringify({ version: 2, profile, reviewId: id, command, promptHash, prepareRequestId: randomUUID() }));
  await writeFile(previous, 'PART-RECEIVED');
  const follow = join(dir, 'follow.json');
  assert.equal((await cli('prepare', '--question', 'q2', '--effort', 'max', '--part', '2/2', '--continue-from', previous, '--out', follow)).code, 0);
  const continuation = JSON.parse(await readFile(follow, 'utf8'));
  assert.equal(continuation.continueFrom.reviewId, id);
  assert.equal(continuation.continueFrom.answerHash, createHash('sha256').update('PART-RECEIVED').digest('hex'));
  assert.equal(requests.length, 0);
  const ask = await cli('ask', '--request', output, '--out', join(dir, 'answer.txt'), '--deadline', '2000', '--timeout', '0');
  assert.equal(errorOf(ask).code, 'busy');
  assert.deepEqual(requests.at(-1).request.command, command);
  const direct = await cli('ask', '--question', 'direct question', '--file', 'source.txt', '--base-dir', dir, '--effort', 'high',
    '--part', '1/2', '--id', randomUUID(), '--out', join(dir, 'direct-answer.txt'), '--deadline', '3000', '--timeout', '0');
  assert.equal(errorOf(direct).code, 'busy');
  assert.equal(requests.at(-1).request.command.effort, 'high');
  assert.deepEqual(requests.at(-1).request.command.part, { index: 1, total: 2 });
  assert.equal(requests.at(-1).request.command.files[0].content, source);
  assert.equal(requests.at(-1).request.deadlineMs, 3000);
});

test('run, prepared input and continuation checkpoints accept formatting larger than 16 MiB', async (t) => {
  const padding = ' '.repeat(16 * 1024 * 1024);
  await t.test('run preserves the explicit API request', async (t) => {
    const { dir, cli, requests } = await fixture(t);
    const request = { id: randomUUID(), deadlineMs: 3000,
      command: { action: 'navigate', url: 'https://example.test/' } };
    await writeFile(join(dir, 'request.json'), padding + JSON.stringify(request));
    const result = await cli('run', '--file', 'request.json');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.at(-1).request, request);
  });
  await t.test('prepare preserves the supplied command without connecting', async (t) => {
    const { dir, cli, requests } = await fixture(t);
    const command = { action: 'review.prepare', reviewId: randomUUID(), question: 'q', files: [], effort: 'max' };
    await writeFile(join(dir, 'request.json'), padding + JSON.stringify(command));
    const output = join(dir, 'prepared.json');
    const result = await cli('prepare', '--request', 'request.json', '--out', output);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), command);
    assert.equal(requests.length, 0);
  });
  await t.test('continuation validates the checkpoint and retains its hashes', async (t) => {
    const { dir, profile, cli, requests } = await fixture(t);
    const id = randomUUID();
    const command = { action: 'review.prepare', reviewId: id, question: 'q', files: [], effort: 'max' };
    const { composeReviewPrompt } = await import('../src/review-files.mjs');
    const promptHash = createHash('sha256').update(composeReviewPrompt({ id, ...command })).digest('hex');
    const previous = join(dir, 'previous.txt');
    const checkpoint = { version: 2, profile, reviewId: id, command, promptHash, prepareRequestId: randomUUID() };
    const depth = 50000;
    const source = padding + JSON.stringify(checkpoint).replace(/}$/, `,"extra":{"huge":"${'x'.repeat(17 * 1024 * 1024)}",` +
      `"deep":${'['.repeat(depth)}0${']'.repeat(depth)}}}`);
    await writeFile(`${previous}.request.json`, source);
    await writeFile(previous, 'PART-RECEIVED');
    const output = join(dir, 'follow.json');
    const result = await cli('prepare', '--question', 'follow up', '--continue-from', previous, '--out', output);
    assert.equal(result.code, 0, result.stderr);
    const continuation = JSON.parse(await readFile(output, 'utf8')).continueFrom;
    assert.deepEqual(continuation, { reviewId: id, promptHash, effort: 'max',
      answerHash: createHash('sha256').update('PART-RECEIVED').digest('hex') });
    assert.equal(requests.length, 0);
    await writeFile(`${previous}.request.json`, JSON.stringify(checkpoint).replace(/}$/, ',"extra":{"bad":"bad\\q"}}'));
    const invalid = await cli('prepare', '--question', 'follow up', '--continue-from', previous, '--out', join(dir, 'invalid.json'));
    assert.equal(errorOf(invalid).code, 'invalid_json');
    assert.equal(requests.length, 0);
  });
});

test('run streams a 96 MiB duplicate text value within a 48 MiB heap and dispatches only its replacement', async (t) => {
  const { dir, cli, requests } = await fixture(t, { heapMiB: 48 });
  const request = { id: randomUUID(), deadlineMs: 3000, command: { action: 'fill', documentId: randomUUID(),
    target: { attribute: 'id', value: 'composer' }, text: 'small🙂' } };
  const path = join(dir, 'request.json');
  const handle = await open(path, 'w');
  try {
    await handle.write(JSON.stringify(request).replace('"text":"small🙂"}}', '"text":"'));
    const chunk = Buffer.alloc(65536, 120);
    for (let i = 0; i < 1536; i++) await handle.write(chunk);
    await handle.write('","\\u0074ext":"small🙂"}}');
  } finally { await handle.close(); }
  const result = await cli('run', '--file', path);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1).request, request);
});

test('run retains numeric, Unicode and action last-wins semantics and schema rejection before dispatch', async (t) => {
  const { dir, cli, requests } = await fixture(t);
  const path = join(dir, 'request.json');
  const request = { id: randomUUID(), deadlineMs: 3000, command: { action: 'fill', documentId: randomUUID(),
    target: { attribute: 'id', value: 'composer', scope: { attribute: 'id', value: 'scope' } }, text: '한글🙂\ud800\u0000' } };
  const source = JSON.stringify(request).replace('"deadlineMs":3000', '"deadlineMs":3' + '0'.repeat(100000) + 'e-99997')
    .replace('"action":"fill"', '"action":"quit","\\u0061ction":"fill"');
  await writeFile(path, source);
  const result = await cli('run', '--file', path);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.at(-1).request, request);
  const dispatches = requests.length;
  for (const field of ['__proto__', 'constructor', 'prototype', 'x'.repeat(100000)]) {
    await writeFile(path, JSON.stringify(request).replace(/}$/, `,"${field}":{"polluted":true}}`));
    const invalid = await cli('run', '--file', path);
    assert.equal(errorOf(invalid).code, 'invalid_command');
    assert.equal(requests.length, dispatches);
  }
  await writeFile(path, JSON.stringify(request).replace('"text":', `"${secret}":true,"text":`).replace('"한글🙂\\ud800\\u0000"', `"${'x'.repeat(9 * 1024 * 1024)}"`));
  const invalid = await cli('run', '--file', path);
  assert.equal(errorOf(invalid).code, 'invalid_command');
  assert(!`${invalid.stdout}${invalid.stderr}`.includes(secret));
  assert.equal(requests.length, dispatches);
});
