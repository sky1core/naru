import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Reviews } from '../src/review.mjs';
import { encodeReviewPrompt, escapeReviewJSON } from '../src/review-files.mjs';

async function context(content) {
  await mkdir('artifacts/review-url-runs', { recursive: true });
  const profile = await mkdtemp(resolve('artifacts/review-url-runs/run-'));
  let view;
  const browser = { assertActive() {}, reviewView: async () => ({ ...structuredClone(view), inputHistory: JSON.stringify(view.messages) }) };
  const reviews = new Reviews(profile, browser);
  const record = reviews.prepare({ reviewId: randomUUID(), question: 'Review source', files: [
    { path: 'source.txt', content, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) },
  ] });
  const project = { id: 'g-p-0123456789abcdef0123456789abcdef', origin: 'https://example.com' };
  reviews.save(record, { state: 'submitted', project, origin: project.origin, baselineIds: [], baselineHistory: [], sendAttemptedAt: new Date().toISOString() });
  view = { url: `${project.origin}/g/${project.id}/c/${randomUUID()}`, stableForMs: 1000, busy: false,
    messages: [{ id: randomUUID(), role: 'user', text: record.prompt, complete: false, error: '' },
      { id: randomUUID(), role: 'assistant', text: `answer\nEND-OF-REVIEW:${record.id}`, complete: true, error: '' }] };
  return { reviews, record, message: view.messages[0], view };
}

test('many short exact links complete without repeatedly scanning the source prefix', async t => {
  const url = 'https://source.example/file';
  const { reviews, record, message } = await context(Array(2000).fill(url).join(' '));
  message.links = [];
  let start = message.text.indexOf(url);
  while (start !== -1) {
    message.links.push({ start, end: start + url.length, href: url });
    start = message.text.indexOf(url, start + url.length);
  }
  const started = performance.now();
  assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
  const elapsed = performance.now() - started;
  t.diagnostic(`Collection of 2000 short links took ${elapsed.toFixed(1)} ms`);
  assert(elapsed < 2000, `Collection of 2000 short links took ${elapsed.toFixed(1)} ms`);
});

test('compact quoted URL arrays keep collection responsive with and without rendered links', async t => {
  const url = 'https://source.example/file';
  const content = 'const urls = [' + Array(16000).fill(`'${url}'`).join(',') + '];';
  for (const linked of [false, true]) await t.test(linked ? 'legacy anchors' : 'Unicode without anchors', async t => {
    const { reviews, record, message } = await context(content);
    if (linked) {
      message.links = [...message.text.matchAll(/https:\/\/source\.example\/file/g)].map(match =>
        ({ start: match.index, end: match.index + url.length, href: url }));
    } else message.text = encodeReviewPrompt(escapeReviewJSON(record.prompt));
    const started = performance.now();
    const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 20));
    assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
    const elapsed = performance.now() - started, timerDelay = await timer;
    t.diagnostic(`16000 quoted URLs: collect ${elapsed.toFixed(1)} ms; timer ${timerDelay.toFixed(1)} ms`);
    assert(elapsed < 2000 && timerDelay < 2000, `Collection blocked for ${elapsed.toFixed(1)} ms; timer ${timerDelay.toFixed(1)} ms`);
  });
});

test('near-limit source with many code spans completes and verifies links within a bounded heap', { timeout: 30000 }, async t => {
  for (const display of ['dom', 'wrapper']) {
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--max-old-space-size=1024', resolve('test/fixtures/review-large-source.mjs'), display], { timeout: 25000 });
    const result = JSON.parse(stdout);
    assert(result.wireBytes > 7.8 * 1024 * 1024);
    t.diagnostic(`Near-limit ${display}: ${result.wireBytes} wire bytes; ${result.elapsedMs.toFixed(1)} ms; peak RSS ${result.maxRSS} KiB`);
  }
});

test('default Unicode source completes within a bounded heap and still rejects changed text', { timeout: 30000 }, async t => {
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--max-old-space-size=1024', resolve('test/fixtures/review-large-source.mjs'), 'unicode'], { timeout: 25000 });
  const result = JSON.parse(stdout);
  assert(result.wireBytes >= 5_200_000);
  t.diagnostic(`Unicode source: ${result.wireBytes} wire bytes; ${result.elapsedMs.toFixed(1)} ms; peak RSS ${result.maxRSS} KiB`);
});

test('unsupported inline annotations of transport fences fail as a content mismatch', async () => {
  const { reviews, record, message } = await context('unchanged source');
  message.text = encodeReviewPrompt(escapeReviewJSON(record.prompt));
  const start = message.text.indexOf('```json');
  assert(start > 0);
  message.inlineCode = [{ start, end: start + 7 }];
  await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
  assert.equal(reviews.get(record.id).answer, undefined);
});

test('serialized source fences may render as inline code without changing source or history', async t => {
  for (const altered of [false, true]) await t.test(altered ? 'changed' : 'exact', async () => {
    const content = '```js\nlet x = 1;\n```';
    const { reviews, record, message, view } = await context(content);
    const encoded = JSON.stringify(content).slice(1, -1), literal = encoded.slice(3, -3);
    const start = message.text.indexOf(encoded);
    message.text = message.text.slice(0, start) + literal + message.text.slice(start + encoded.length);
    message.inlineCode = [{ start, end: start + literal.length }];
    if (altered) message.text = message.text.replace('let x = 1;', 'let x = 2;');
    if (altered) await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
    else {
      const completed = await reviews.collect(record.id, 0);
      assert.equal(completed.state, 'completed');
      assert.doesNotThrow(() => reviews.assertPrevious(completed, view));
    }
  });
});

test('one rendered code span does not force repeated searches across unrelated unmatched backticks', async t => {
  for (const linked of [false, true]) await t.test(linked ? 'with a URL' : 'without URLs', async t => {
    const url = 'https://source.example/file';
    const content = 'const flag = `ok`; const ticks = [' + Array.from({ length: 1600 }, (_, index) =>
      JSON.stringify('`'.repeat(index + 2))).join(',') + '];' + (linked ? ` const url = "${url}";` : '');
    const { reviews, record, message } = await context(content);
    const start = message.text.indexOf('`ok`');
    message.text = message.text.slice(0, start) + 'ok' + message.text.slice(start + 4);
    message.inlineCode = [{ start, end: start + 2 }];
    if (linked) {
      const at = message.text.indexOf(url);
      message.links = [{ start: at, end: at + url.length, href: url }];
    }
    const started = performance.now();
    const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 20));
    assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
    const elapsed = performance.now() - started, timerDelay = await timer;
    t.diagnostic(`1600 unmatched backtick runs: collect ${elapsed.toFixed(1)} ms; timer ${timerDelay.toFixed(1)} ms`);
    assert(elapsed < 2000 && timerDelay < 2000, `Collection blocked for ${elapsed.toFixed(1)} ms; timer ${timerDelay.toFixed(1)} ms`);
  });
});

test('a URL backtick is not reused as the delimiter of a following displayed code span', async t => {
  const url = 'https://source.example/a`b';
  for (const form of ['plain', 'fenced']) for (const altered of [false, true]) {
    await t.test(`${form} ${altered ? 'changed' : 'exact'}`, async () => {
      const { reviews, record, message } = await context(`Read ${url} and \`ok\` now.`);
      message.text = form === 'fenced' ? encodeReviewPrompt(record.prompt) : record.prompt;
      const start = message.text.indexOf('`ok`');
      message.text = message.text.slice(0, start) + (altered ? 'no' : 'ok') + message.text.slice(start + 4);
      message.inlineCode = [{ start, end: start + 2 }];
      const link = message.text.indexOf(url);
      message.links = [{ start: link, end: link + url.length, href: new URL(url).href }];
      if (altered) await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
      else assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
    });
  }
});

test('HTML-looking source code can be collected without repeated suffix scans', async t => {
  const url = 'https://source.example/file.';
  const { reviews, record, message } = await context('Read `' + '<?'.repeat(128000) + '` "' + url + '" now.');
  const start = message.text.indexOf(url);
  message.links = [{ start, end: start + url.length, href: url }];
  const begun = performance.now();
  const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - begun), 20));
  assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
  const elapsed = performance.now() - begun, timerDelay = await timer;
  t.diagnostic(`256 KiB inline code: collect ${elapsed.toFixed(1)} ms; timer ${timerDelay.toFixed(1)} ms`);
  assert(elapsed < 2000 && timerDelay < 2000, `Collection blocked for ${elapsed.toFixed(1)} ms; timer ${timerDelay.toFixed(1)} ms`);
});

test('legacy display formatting preserves source text without interpreting quoted addresses', async t => {
  const url = 'https://source.example/file.';
  const cases = [
    ['adjacent quotation', 'Read ("docs"https://source.example/file) now.', ['https://source.example/file', 'https://source.example/file)']],
    ['particle and quoted word', "Read 'https://source.example/file'를'확인' 하세요.",
      ['https://source.example/file', "https://source.example/file'를'확인"]],
    ['internal apostrophe', "Read 'https://source.example/a-'b.' now.", ["https://source.example/a-'b."]],
    ['container HTML', '> Read <span\n> title="`">label</span> `https://source.example/file.` now.', [url]],
    ['regular expression', "const quote = /'/;\nconst url = '" + url + "';", [url]],
    ['comment', "// single quote: '\nconst url = '" + url + "';", [url]],
    ['Unicode apostrophe', "Read 'https://source.example/한글'한글.' now.", ["https://source.example/한글'한글."]],
    ['backticks in address', 'Read "https://source.example/a`b`c." now.', ['https://source.example/a`b`c.']],
    ['code fence', ['```js', 'const marker = "```";', `const url = "${url}";`, '```'].join('\n'), [url]],
    ['nested parentheses', 'Read https://source.example/(one(two))/three now.', ['https://source.example/(one(two))/three']],
  ];
  for (const [name, content, labels] of cases) for (const label of labels) {
    await t.test(`${name} ${label}`, async () => {
      const { reviews, record, message, view } = await context(content);
      const start = message.text.indexOf(label);
      assert(start >= 0);
      message.links = [{ start, end: start + label.length, href: new URL(label).href }];
      const completed = await reviews.collect(record.id, 0);
      assert.equal(completed.state, 'completed');
      assert.equal(completed.promptHash, record.promptHash);
      assert.deepEqual(completed.sources, record.sources);
      assert.doesNotThrow(() => reviews.assertPrevious(completed, view));
      message.links[0].href = 'https://changed.example/file';
      assert.throws(() => reviews.assertPrevious(completed, view), { code: 'review_content_mismatch' });
    });
  }
});

test('text outside a displayed link must remain exactly present', async t => {
  const url = 'https://source.example/file';
  for (const change of ['delete', 'replace', 'append']) await t.test(change, async () => {
    const { reviews, record, message } = await context(`BEFORE '${url}'를'확인' AFTER`);
    const start = message.text.indexOf(url);
    message.links = [{ start, end: start + url.length, href: url }];
    if (change === 'delete') message.text = message.text.replace(' AFTER', '');
    if (change === 'replace') message.text = message.text.replace(' AFTER', ' CHANGED');
    if (change === 'append') message.text = message.text.replace(' AFTER', ' AFTER EXTRA');
    await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
    assert.equal(reviews.get(record.id).answer, undefined);
  });
});

test('literal wrapper delimiters keep large source collection responsive', { timeout: 30000 }, async t => {
  const url = 'https://example.com/a' + ']('.repeat(32000) + 'end';
  const { reviews, record, message } = await context(url);
  message.text = record.prompt.replace(url, '[' + url + '](' + url + ')');
  const started = performance.now();
  const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 20));
  assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
  const elapsed = performance.now() - started, timerDelay = await timer;
  t.diagnostic(`${Buffer.byteLength(url)} byte wrapper: collect ${elapsed.toFixed(1)} ms; timer ${timerDelay.toFixed(1)} ms`);
  assert(elapsed < 2000 && timerDelay < 2000, `Collection blocked for ${elapsed.toFixed(1)} ms; timer ${timerDelay.toFixed(1)} ms`);
});

test('literal wrapper boundaries preserve escaped labels and ignore incomplete prefix matches', async t => {
  const address = 'https://example.com/a';
  for (const [name, source, label] of [
    ['escaped label', address + '](b)', address + '\\](b)'],
    ['internal partial match', address + '](' + address + ')', address + '](' + address + ')'],
  ]) for (const form of ['plain', 'fenced']) for (const changed of [false, true]) {
    await t.test(`${name} ${form} ${changed ? 'changed destination' : 'preserved'}`, async () => {
      const { reviews, record, message } = await context(source);
      message.text = form === 'fenced' ? encodeReviewPrompt(record.prompt) : record.prompt;
      message.text = message.text.replace(source, '[' + label + '](' + source + (changed ? '#changed' : '') + ')');
      if (changed) {
        await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
        assert.equal(reviews.get(record.id).answer, undefined);
      } else {
        assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
        assert.equal(reviews.get(record.id).promptHash, record.promptHash);
      }
    });
  }
});

test('rendered backslashes may cross a link boundary without losing source characters', async t => {
  const address = 'https://example.com/a';
  for (const [displayed, inside, original] of [[4, 2, 1], [3, 1, 1], [2, 2, 2]]) {
    for (const form of ['plain', 'fenced']) for (const display of ['dom', 'wrapper']) {
      await t.test(`${displayed} slashes ${inside} linked ${form} ${display}`, async () => {
        const { reviews, record, message } = await context(address + '\\tail');
        message.text = form === 'fenced' ? encodeReviewPrompt(record.prompt) : record.prompt;
        message.text = message.text.replace(address + '\\'.repeat(2), address + '\\'.repeat(displayed));
        const start = message.text.indexOf(address), label = address + '\\'.repeat(inside);
        if (display === 'dom') message.links = [{ start, end: start + label.length, href: new URL(address + '\\'.repeat(original)).href }];
        else message.text = message.text.slice(0, start) + '[' + label + '](' + label + ')' + message.text.slice(start + label.length);
        assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
        assert.equal(reviews.get(record.id).promptHash, record.promptHash);
      });
    }
  }
  const { reviews, record, message } = await context(address + '\\tail');
  message.text = record.prompt.replace(address + '\\'.repeat(2), address + '\\'.repeat(4));
  const start = message.text.indexOf(address);
  message.links = [{ start, end: start + address.length + 2, href: new URL(address + '\\'.repeat(2)).href }];
  await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
  assert.equal(reviews.get(record.id).answer, undefined);
});
