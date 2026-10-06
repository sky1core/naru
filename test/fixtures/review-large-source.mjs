import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Reviews } from '../../src/review.mjs';
import { encodeReviewPrompt, escapeReviewJSON } from '../../src/review-files.mjs';
import { maxRequestBytes, requestSchema } from '../../src/protocol.mjs';

const url = 'https://source.example/file';
const display = process.argv[2];
assert(['dom', 'wrapper', 'unicode'].includes(display));
const content = display === 'unicode' ? 'a.'.repeat(2_600_000)
  : '`a'.repeat(Math.floor(7.9 * 1024 * 1024 / 2)) + ' ' + url;
const command = { action: 'review.prepare', reviewId: randomUUID(), question: 'Review source', files: [
  { path: 'source.txt', content, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') },
] };
const request = { id: randomUUID(), command };
assert(requestSchema.safeParse(request).success);
const wireBytes = Buffer.byteLength(JSON.stringify(request));
assert(wireBytes < maxRequestBytes);
await mkdir('artifacts/review-large-source-runs', { recursive: true });
const profile = await mkdtemp(resolve('artifacts/review-large-source-runs/run-'));
let view;
const reviews = new Reviews(profile, { assertActive() {}, reviewView: async () => structuredClone(view) });
const record = reviews.prepare(command);
const project = { id: 'g-p-0123456789abcdef0123456789abcdef', origin: 'https://example.com' };
reviews.save(record, { state: 'submitted', project, origin: project.origin, baselineIds: [], baselineHistory: [], sendAttemptedAt: new Date().toISOString() });
const start = record.prompt.indexOf(url);
view = { url: `${project.origin}/g/${project.id}/c/${randomUUID()}`, stableForMs: 1000, busy: false,
  messages: [{ id: randomUUID(), role: 'user',
    text: display === 'unicode' ? encodeReviewPrompt(escapeReviewJSON(record.prompt))
      : display === 'dom' ? record.prompt : record.prompt.replace(url, '[' + url + '](' + url + ')'), complete: false, error: '',
    links: display === 'dom' ? [{ start, end: start + url.length, href: url }] : [] },
  { id: randomUUID(), role: 'assistant', text: `answer\nEND-OF-REVIEW:${record.id}`, complete: true, error: '' }] };
const started = performance.now();
const completed = await reviews.collect(record.id, 0);
assert.equal(completed.state, 'completed');
assert.equal(completed.promptHash, record.promptHash);
assert.deepEqual(completed.sources, record.sources);
if (display === 'unicode') view.messages[0].text = view.messages[0].text.replace('a\\u002e', 'b\\u002e');
else if (display === 'dom') view.messages[0].links[0].href = 'https://changed.example/file';
else view.messages[0].text = view.messages[0].text.replace('](' + url + ')', '](' + url + '#changed)');
assert.throws(() => reviews.assertPrevious(completed, view), { code: 'review_content_mismatch' });
console.log(JSON.stringify({ wireBytes, elapsedMs: performance.now() - started, maxRSS: process.resourceUsage().maxRSS }));
