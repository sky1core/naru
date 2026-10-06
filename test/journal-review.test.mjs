import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { connect } from '../src/client.mjs';
import { Reviews } from '../src/review.mjs';
import { Journal } from '../src/journal.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = () => mkdtemp(join(tmpdir(), 'naru-journal-review-'));
test('explicit review journal records store references and reconstruct the frozen result', async () => {
  const profile = await fixture(), reviews = new Reviews(profile, {}), journal = new Journal(profile);
  const review = reviews.prepare({ reviewId: randomUUID(), question: 'Unique private prompt', files: [] });
  const { record } = journal.begin(randomUUID(), { command: { action: 'review.collect', reviewId: review.id } });
  const final = journal.finish(record, { state: 'completed', result: review }, { reviewId: review.id });
  const text = await readFile(join(profile, 'requests', `${record.id}.json`), 'utf8');
  assert(!text.includes('Unique private prompt'));
  assert.deepEqual(journal.get(record.id), final);
  assert.equal(final.result.prompt, review.prompt);
  reviews.save(review, { state: 'completed', answer: 'later' });
  assert.deepEqual(journal.get(record.id), final);
});
test('1 MiB prepare, submit and three actual HTTP collects store no prompt copies and freeze request results', async t => {
  const profile = await fixture();
  const url = 'https://example.com/g/g-p-0123456789abcdef0123456789abcdef/c/test';
  const browser = { assertActive() {}, reviewView: async () => ({ url, busy: true, messages: [] }) };
  const { server, descriptor } = await startServer({ profile, browser, quit() {} });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await writeFile(join(profile, 'connection.json'), JSON.stringify(descriptor));
  const call = await connect(profile);
  const reviews = new Reviews(profile, browser), journal = new Journal(profile);
  const content = 'A'.repeat(1024 * 1024), reviewId = randomUUID(), ids = [];
  const command = { action: 'review.prepare', reviewId, question: 'Review input', files: [
    { path: 'source.txt', content, sha256: hash(content), bytes: Buffer.byteLength(content) },
  ] };
  const run = async command => {
    const id = randomUUID(); ids.push(id);
    const record = await call('/v1/commands', { id, command });
    assert.deepEqual(await call(`/v1/requests/${id}`), record);
    assert.deepEqual(journal.get(id), record);
    return record;
  };
  const prepared = await run(command);
  let review = reviews.save(reviews.get(reviewId), { state: 'submitted', origin: 'https://example.com', conversationURL: url, baselineIds: [] });
  const submitted = await run({ action: 'review.submit', reviewId, documentId: randomUUID() });
  const polls = [];
  for (let index = 0; index < 3; index++) polls.push(await run({ action: 'review.collect', reviewId, waitMs: 0 }));
  review = reviews.save(review, { state: 'completed', answer: 'new answer', answerHash: hash('new answer') });
  assert.equal(review.state, 'completed');
  for (const saved of [prepared, submitted, ...polls]) {
    assert.deepEqual(await call(`/v1/requests/${saved.id}`), saved);
    assert.deepEqual(journal.get(saved.id), saved);
  }
  assert.deepEqual(await call('/v1/commands', { id: polls[0].id, command: { action: 'review.collect', reviewId, waitMs: 0 } }), polls[0]);
  const disks = await Promise.all(ids.map(id => readFile(join(profile, 'requests', `${id}.json`), 'utf8')));
  assert.equal(disks.filter(text => text.includes(content)).length, 0);
  const journalBytes = disks.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  assert(journalBytes < 20000);
  t.diagnostic(`1 MiB input: ${ids.length} request journals, ${journalBytes} bytes, 0 full source copies.`);
  for (const text of disks) {
    const record = JSON.parse(text);
    assert.equal(record.result.prompt, undefined);
    assert.deepEqual(record.reviewPromptRef, { reviewId, hash: prepared.result.promptHash });
  }
  const changed = JSON.parse(disks[2]);
  changed.reviewPromptRef.hash = 'a'.repeat(64);
  await writeFile(join(profile, 'requests', `${changed.id}.json`), JSON.stringify(changed));
  await assert.rejects(call(`/v1/requests/${changed.id}`), error => {
    assert(!JSON.stringify(error.record).includes(content));
    return error.code === 'review_reference_invalid';
  });
});

test('review references reject changed hash, canonical prompt, missing canonical record and invalid identity', async t => {
  for (const mode of ['hash', 'prompt', 'missing', 'identity', 'null-record']) await t.test(mode, async () => {
    const profile = await fixture();
    const reviews = new Reviews(profile, {}), journal = new Journal(profile);
    const review = reviews.prepare({ reviewId: randomUUID(), question: 'Original', files: [] });
    const { record } = journal.begin(randomUUID(), { command: { action: 'review.collect', reviewId: review.id } });
    journal.finish(record, { state: 'completed', result: review }, { reviewId: review.id });
    const path = join(profile, 'requests', `${record.id}.json`);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (mode === 'hash') saved.reviewPromptRef = { reviewId: review.id, hash: 'a'.repeat(64) };
    if (mode === 'identity') saved.reviewPromptRef = { reviewId: '../invalid', hash: review.promptHash };
    if (mode === 'missing') saved.reviewPromptRef = { reviewId: randomUUID(), hash: review.promptHash };
    if (mode === 'prompt') await writeFile(join(profile, 'reviews', `${review.id}.json`), JSON.stringify({ ...review, prompt: 'Changed' }));
    if (mode === 'null-record') await writeFile(join(profile, 'reviews', `${review.id}.json`), 'null');
    await writeFile(path, JSON.stringify(saved));
    await assert.rejects(async () => journal.get(record.id), { code: 'review_reference_invalid' });
  });
});

test('legacy records and ordinary read/screenshot outcomes retain exact storage and response contracts', async () => {
  const profile = await fixture(), journal = new Journal(profile);
  const legacy = { id: randomUUID(), digest: 'legacy', state: 'completed', result: { prompt: 'legacy full input', state: 'submitted' } };
  const path = join(profile, 'requests', `${legacy.id}.json`), text = JSON.stringify(legacy) + '\n';
  await writeFile(path, text);
  assert.deepEqual(journal.get(legacy.id), legacy);
  assert.equal(await readFile(path, 'utf8'), text);
  for (const result of [{ text: 'Original text', prompt: 'ordinary prompt property' }, { pngBase64: 'cG5n', width: 1, height: 1 }]) {
    const { record } = journal.begin(randomUUID(), { action: 'read' });
    const final = journal.finish(record, { state: 'completed', result });
    assert.deepEqual(journal.get(record.id), final);
    assert.deepEqual(JSON.parse(await readFile(join(profile, 'requests', `${record.id}.json`), 'utf8')).result, result);
  }
});
