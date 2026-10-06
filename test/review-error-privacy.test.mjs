import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Reviews } from '../src/review.mjs';
import { startServer } from '../src/server.mjs';
import { Journal } from '../src/journal.mjs';
import { publicError } from '../src/protocol.mjs';

test('legacy history errors remain comparable after restart without exposing their body in results or journals', async () => {
  const marker = 'SYNTHETIC_PRIVATE_SOURCE token=SYNTHETIC_SECRET';
  const hash = text => createHash('sha256').update(text).digest('hex');
  for (const state of ['submitted', 'uncertain', 'completed']) {
    for (const changed of [false, true]) {
      const profile = await mkdtemp(join(tmpdir(), 'naru-review-error-'));
      let view;
      const browser = { assertActive() {}, reviewView: async () => structuredClone(view) };
      const reviews = new Reviews(profile, browser);
      const review = reviews.prepare({ reviewId: randomUUID(), question: 'Review original input', files: [] });
      const history = [
        { id: 'prior-user', role: 'user', text: 'prior source', error: '', complete: false },
        { id: 'prior-answer', role: 'assistant', text: 'failure', error: marker, complete: false },
      ];
      const answer = `answer\nEND-OF-REVIEW:${review.id}`;
      const legacy = { ...review, state, origin: 'https://example.com', baselineIds: history.map(message => message.id),
        baselineHistory: history.map(({ id, role, text, complete, error }) => ({ id, role, textHash: hash(text), complete, error })),
        sendAttemptedAt: new Date().toISOString(),
        ...(state === 'completed' ? { answer, responseId: 'answer', answerHash: hash(answer) } : {}) };
      await writeFile(join(profile, 'reviews', `${review.id}.json`), JSON.stringify(legacy));
      view = { url: 'https://example.com/c/example', busy: false, stableForMs: 1000, messages: [...history,
        { id: 'user', role: 'user', text: review.prompt, error: '', complete: false },
        { id: 'answer', role: 'assistant', text: answer, error: '', complete: true },
      ] };
      if (changed) history[1].error += 'changed';
      const restored = new Reviews(profile, browser);
      if (changed && state !== 'completed') {
        await assert.rejects(restored.collect(review.id, 0), { code: 'conversation_changed' });
        assert.equal(restored.get(review.id).state, state);
      } else {
        const completed = await restored.collect(review.id, 0);
        assert.equal(completed.state, 'completed');
        assert.equal(completed.promptHash, review.promptHash);
        assert.deepEqual(completed.sources, review.sources);
        assert.equal(completed.answerHash, hash(answer));
        assert.equal(completed.baselineHistory[1].errorHash, hash(marker));
        assert(!JSON.stringify(completed).includes('SYNTHETIC_PRIVATE_SOURCE'));
        assert(!JSON.stringify(completed).includes('SYNTHETIC_SECRET'));
        const journal = new Journal(profile);
        const { record } = journal.begin(randomUUID(), { command: { action: 'review.collect', reviewId: review.id, waitMs: 0 } });
        journal.finish(record, { state: 'completed', result: completed }, { reviewId: review.id });
        const disk = await readFile(join(profile, 'requests', `${record.id}.json`), 'utf8');
        assert(!disk.includes('SYNTHETIC_PRIVATE_SOURCE'));
        assert(!disk.includes('SYNTHETIC_SECRET'));
      }
    }
  }
});

test('collection errors retain public classification and frozen journal failure without remote text', async () => {
  for (const role of ['user', 'assistant', 'both']) {
    const profile = await mkdtemp(join(tmpdir(), 'naru-review-error-'));
    const marker = 'SYNTHETIC_PRIVATE_SOURCE token=SYNTHETIC_SECRET';
    let view;
    const reviews = new Reviews(profile, { assertActive() {}, reviewView: async () => structuredClone(view) });
    const review = reviews.prepare({ reviewId: randomUUID(), question: 'Review synthetic input', files: [] });
    const before = reviews.save(review, { state: 'submitted', origin: 'https://example.com', baselineIds: [], baselineHistory: [],
      sendAttemptedAt: new Date().toISOString() });
    view = { url: 'https://example.com/c/example', busy: false, stableForMs: 1000, messages: [
      { id: randomUUID(), role: 'user', text: review.prompt, error: role === 'assistant' ? '' : marker, complete: false },
      { id: randomUUID(), role: 'assistant', text: 'failure', error: role === 'user' ? '' : marker, complete: false },
    ] };
    const journal = new Journal(profile);
    const { record } = journal.begin(randomUUID(), { command: { action: 'review.collect', reviewId: review.id, waitMs: 0 } });
    await assert.rejects(reviews.collect(review.id, 0), error => {
      const failure = publicError(error);
      assert.equal(failure.code, 'response_failed');
      assert.match(failure.message, role === 'assistant' ? /assistant response/ : /request.*delivery/);
      assert(!JSON.stringify(failure).includes('SYNTHETIC_PRIVATE_SOURCE'));
      assert(!JSON.stringify(failure).includes('SYNTHETIC_SECRET'));
      const finished = journal.finish(record, { state: 'failed', status: error.status, error: failure }, { reviewId: review.id });
      assert.deepEqual(journal.get(record.id), finished);
      return true;
    });
    const disk = await readFile(join(profile, 'requests', `${record.id}.json`), 'utf8');
    assert(!disk.includes('SYNTHETIC_PRIVATE_SOURCE'));
    assert(!disk.includes('SYNTHETIC_SECRET'));
    assert.deepEqual(reviews.get(review.id), before);
  }
});

test('remote request and answer errors retain failure classification without reaching CLI or journals', async t => {
  for (const role of ['user', 'assistant', 'both']) await t.test(role, async t => {
    const profile = await mkdtemp(join(tmpdir(), 'naru-review-error-'));
    let view;
    const browser = { assertActive() {}, reviewView: async () => structuredClone(view) };
    const reviews = new Reviews(profile, browser);
    const review = reviews.prepare({ reviewId: randomUUID(), question: 'Review synthetic input', files: [] });
    reviews.save(review, { state: 'submitted', origin: 'https://example.com', baselineIds: [], baselineHistory: [],
      sendAttemptedAt: new Date().toISOString() });
    const marker = 'SYNTHETIC_PRIVATE_SOURCE token=SYNTHETIC_SECRET';
    view = { url: 'https://example.com/c/example', busy: false, stableForMs: 1000, messages: [
      { id: randomUUID(), role: 'user', text: review.prompt, error: role === 'assistant' ? '' : marker, complete: false },
      { id: randomUUID(), role: 'assistant', text: 'failure', error: role === 'user' ? '' : marker, complete: false },
    ] };
    let running;
    try { running = await startServer({ browser, profile, quit() {} }); }
    catch (error) {
      if (error.code !== 'EPERM') throw error;
      t.skip('Loopback HTTP listening is denied by this execution environment.');
      return;
    }
    const { server, descriptor } = running;
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    await writeFile(join(profile, 'connection.json'), JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    const request = { id: randomUUID(), command: { action: 'review.collect', reviewId: review.id, waitMs: 0 } };
    const input = join(profile, 'request.json');
    await writeFile(input, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    await assert.rejects(promisify(execFile)(process.execPath, [
      new URL('../src/cli.mjs', import.meta.url).pathname, '--profile', profile, 'run', '--file', input,
    ]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /response_failed/);
      assert(!error.stderr.includes('SYNTHETIC_PRIVATE_SOURCE'));
      assert(!error.stderr.includes('SYNTHETIC_SECRET'));
      return true;
    });
    const journal = await readFile(join(profile, 'requests', `${request.id}.json`), 'utf8');
    assert(!journal.includes('SYNTHETIC_PRIVATE_SOURCE'));
    assert(!journal.includes('SYNTHETIC_SECRET'));
    const failure = JSON.parse(journal);
    assert.equal(failure.state, 'failed');
    assert.equal(failure.error.code, 'response_failed');
    assert.match(failure.error.message, role === 'assistant' ? /assistant response/ : /request.*delivery/);
    const saved = await readFile(join(profile, 'reviews', `${review.id}.json`), 'utf8');
    assert(!saved.includes(marker));
    assert.equal(JSON.parse(saved).state, 'submitted');
    assert.equal(JSON.parse(saved).answer, undefined);
  });
});
