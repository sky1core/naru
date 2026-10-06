import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Reviews } from '../src/review.mjs';
import { encodeReviewPrompt, escapeReviewJSON } from '../src/review-files.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const project = { id: 'g-p-0123456789abcdef0123456789abcdef', origin: 'https://example.com' };
const escaped = text => text.replace(/[!-/:-@[-`{-~]/g, character => '\\' + character);

async function context(source) {
  await mkdir('artifacts/review-identity-runs', { recursive: true });
  const profile = await mkdtemp(resolve('artifacts/review-identity-runs/run-'));
  let view;
  const browser = { assertActive() {}, reviewView: async () => ({ ...structuredClone(view), inputHistory: JSON.stringify(view.messages) }) };
  const reviews = new Reviews(profile, browser);
  const content = source ?? '1. item [link](url) _name_ #title ! % & + - = / : ; < > ? @ ^ { | } original `code` **bold** ~tilde~ "quote" \\n \\" \\* \\` \\~ 🙂\r\nend';
  const record = reviews.prepare({ reviewId: randomUUID(), question: 'Review source', files: [
    { path: 'source.txt', content, sha256: hash(content), bytes: Buffer.byteLength(content) },
  ] });
  reviews.save(record, { state: 'submitted', project, origin: project.origin, baselineIds: [], baselineHistory: [], sendAttemptedAt: new Date().toISOString() });
  view = { url: `${project.origin}/g/${project.id}/c/${randomUUID()}`, stableForMs: 1000, busy: false,
    messages: [{ id: randomUUID(), role: 'user', text: escaped(record.prompt), complete: false, error: '' },
      { id: randomUUID(), role: 'assistant', text: `answer\nEND-OF-REVIEW:${record.id}`, complete: true, error: '' }] };
  return { reviews, record, view, browser, profile };
}

test('collect recognizes the sent UUID when the rendered body escapes punctuation and preserves literal backslashes', async () => {
  const { reviews, record, view, browser, profile } = await context();
  const completed = await reviews.collect(record.id, 0);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.userMessageId, view.messages[0].id);
  assert.equal(completed.answer, view.messages[1].text);
  assert.equal(completed.promptHash, record.promptHash);
  assert.deepEqual(completed.sources, record.sources);
  assert.equal((await new Reviews(profile, browser).collect(record.id, 0)).answer, completed.answer);
});

test('legacy and Unicode plain or fenced requests retain identity, bytes and hashes through checkpoint recovery', async () => {
  const source = 'npm @scope/package https://source.example/(path) `code` **bold** literal \\u0040 \\*\r\n한글🙂';
  for (const state of ['submitted', 'uncertain', 'send_attempted']) {
    for (const kind of ['plain', 'fenced', 'unicode', 'unicode-fenced']) {
      for (const altered of [false, true]) {
        const { reviews, record, view, browser, profile } = await context(source);
        const unicode = escapeReviewJSON(record.prompt);
        const variants = { plain: record.prompt, fenced: encodeReviewPrompt(record.prompt),
          unicode, 'unicode-fenced': encodeReviewPrompt(unicode) };
        const text = variants[kind];
        const payload = text.split('\n').find(line => line.startsWith('{"id":'));
        const parsed = JSON.parse(payload);
        assert.equal(parsed.files[0].content, source);
        assert.equal(Buffer.byteLength(parsed.files[0].content), record.sources[0].bytes);
        assert.equal(hash(parsed.files[0].content), record.sources[0].sha256);
        reviews.save(reviews.get(record.id), { state, userMessageId: view.messages[0].id, conversationURL: view.url });
        view.messages[0].text = altered ? text.replace('scope', 'other') : text;
        browser.execute = async () => { assert.fail('Recovery must not replay input.'); };
        const restored = new Reviews(profile, browser);
        if (altered) {
          await assert.rejects(restored.collect(record.id, 0), { code: 'review_content_mismatch' });
          assert.equal(restored.get(record.id).answer, undefined);
        } else {
          const completed = await restored.collect(record.id, 0);
          assert.equal(completed.state, 'completed');
          assert.equal(completed.prompt, record.prompt);
          assert.equal(completed.promptHash, record.promptHash);
          assert.deepEqual(completed.sources, record.sources);
          browser.reviewView = async () => { assert.fail('Completed checkpoints use the verified result.'); };
          assert.equal((await restored.collect(record.id, 0)).answerHash, completed.answerHash);
        }
      }
    }
  }
});

test('Unicode transmission rejects a decoded but transformed URL or npm scope display', async () => {
  for (const change of [text => text.replace('@scope/package', '@scope'),
    text => text.replace('https://source.example/path', 'https://source.example'),
    text => text.replace('https://source.example/path', 'https://changed.example/path')]) {
    const { reviews, record, view } = await context('npm @scope/package https://source.example/path');
    view.messages[0].text = change(record.prompt);
    await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
    assert.equal(reviews.get(record.id).answer, undefined);
  }
});

test('successful collection clears the current error and retains failure history without replaying input', async () => {
  for (const state of ['submitted', 'uncertain', 'send_attempted']) {
    const { reviews, record, view, browser, profile } = await context();
    const error = { code: 'review_content_mismatch', message: 'Earlier observation did not match.' };
    const lastFailure = { phase: 'locating_request', at: new Date().toISOString(), error };
    const before = reviews.save(reviews.get(record.id), { state, error, lastFailure });
    browser.execute = async () => { assert.fail('Collection must not dispatch input.'); };
    view.busy = true;
    const pending = await reviews.collect(record.id, 0);
    assert.equal(pending.observation.state, 'generating');
    assert.deepEqual(pending.error, error);
    assert.notEqual(reviews.get(record.id).state, 'completed');
    view.busy = false;
    const completed = await reviews.collect(record.id, 0);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.error, undefined);
    assert.deepEqual(completed.lastFailure, lastFailure);
    const restored = new Reviews(profile, browser).get(record.id);
    assert.equal(restored.error, undefined);
    assert.deepEqual(restored.lastFailure, lastFailure);
    assert.equal(restored.promptHash, before.promptHash);
    assert.deepEqual(restored.sources, before.sources);
    assert.equal(restored.sendAttemptedAt, before.sendAttemptedAt);
    assert.equal(restored.answerHash, hash(view.messages[1].text));
    assert.equal((await reviews.collect(record.id, 0)).error, undefined);
  }
});

test('collect removes a legacy completed record current error while preserving its cached result and failure history', async () => {
  const { reviews, record, browser, profile } = await context();
  const completed = await reviews.collect(record.id, 0);
  const error = { code: 'review_content_mismatch', message: 'Earlier observation did not match.' };
  const lastFailure = { phase: 'locating_request', at: new Date().toISOString(), error };
  const before = reviews.save(completed, { error, lastFailure });
  browser.reviewView = async () => { assert.fail('A cached completed result must not require the current conversation.'); };
  browser.execute = async () => { assert.fail('Collection must not dispatch input.'); };
  const collected = await new Reviews(profile, browser).collect(record.id, 0);
  assert.equal(collected.error, undefined);
  const { error: oldError, updatedAt: oldUpdatedAt, ...expected } = before;
  const { updatedAt: newUpdatedAt, ...actual } = reviews.get(record.id);
  assert.deepEqual(actual, expected);
  assert.deepEqual((await reviews.collect(record.id, 0)).lastFailure, lastFailure);
});

test('editor autolinks preserve the complete URL in both label and destination, including JSON escapes', async () => {
  const url = 'https://example.com/docs?x=1&y=2\\r\\n';
  for (const destination of [url, url + '#changed']) {
    const { reviews, record, view } = await context('See ' + url + ' original source');
    const encoded = JSON.stringify(url).slice(1, -1);
    const target = JSON.stringify(destination).slice(1, -1);
    view.messages[0].text = record.prompt.replace(encoded, `[${encoded}](${target})`);
    if (destination === url) {
      const completed = await reviews.collect(record.id, 0);
      assert.equal(completed.state, 'completed');
      assert.equal(completed.promptHash, record.promptHash);
      assert.deepEqual(completed.sources, record.sources);
    } else {
      await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
    }
  }
});

test('DOM links preserve exact destinations both inside and outside inline code', async () => {
  const url = 'https://example.com/path?x=1&y=2';
  for (const code of ['none', 'source', 'display']) for (const changed of [false, true]) {
    const { reviews, record, view } = await context(code === 'source' ? `Read \`${url}\` here` : `Read ${url} here`);
    const message = view.messages[0];
    message.text = code === 'source' ? record.prompt.replace(`\`${url}\``, url) : record.prompt;
    const start = message.text.indexOf(url), end = start + url.length;
    if (code !== 'none') message.inlineCode = [{ start, end }];
    message.links = [{ start, end, href: changed ? 'https://changed.example/path' : new URL(url).href }];
    if (changed) await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
    else assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
  }
});

test('URL display ranges preserve the exact body and matching destination', async () => {
  for (const url of ['https://source.example/path', 'https://source.example/(part)/path', 'https://source.example/part_(nested(one))']) {
    for (const wrap of [value => `(${value})`, value => `(see ${value})`, value => `'${value}'`,
      value => `\`${value}\``, value => `${value}.`, value => `${value},`]) {
      for (const display of ['dom', 'wrapper', 'inline']) {
        for (const alteration of ['none', 'href', 'prefix', 'body']) {
          const { reviews, record, view } = await context(`Review ${wrap(url)} now.`);
          const message = view.messages[0];
          message.text = record.prompt;
          if (display === 'wrapper') message.text = message.text.replace(url, `[${url}](${alteration === 'href' ? url + '#changed' : url})`);
          else {
            if (display === 'inline') {
              const raw = `\`${url}\``;
              if (!record.prompt.includes(raw)) continue;
              message.text = message.text.replace(raw, url);
              const start = message.text.indexOf(url);
              message.inlineCode = [{ start, end: start + url.length }];
            }
            const start = message.text.indexOf(url);
            const label = alteration === 'prefix' ? 'https://source.example' : url;
            message.links = [{ start, end: start + label.length,
              href: alteration === 'href' ? url + '#changed' : new URL(label).href }];
          }
          if (alteration === 'body') message.text = message.text.replace('/path', '/other').replace('/part_', '/other_');
          if (display === 'wrapper' && alteration === 'prefix') {
            const prefix = 'https://source.example';
            message.text = record.prompt.replace(url, `[${prefix}](${prefix})${url.slice(prefix.length)}`);
          }
          if (['none', 'prefix'].includes(alteration)) assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
          else await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
        }
      }
    }
  }
});

test('link ranges inside code preserve all remaining source characters', async () => {
  for (const raw of ['https://source.example/rules)', '`https://source.example/path.`',
    '`https://source.example/path?`', '`https://source.example/(path))`', '``https://source.example/a`b``',
    'https://source.example/a`b']) {
    const code = raw.startsWith('`');
    const width = code ? raw.match(/^`+/)[0].length : 0;
    const url = width ? raw.slice(width, -width) : raw;
    for (const shortened of [false, true]) {
      const { reviews, record, view } = await context(`Review ${raw} now.`);
      const message = view.messages[0];
      message.text = width ? record.prompt.replace(raw, url) : record.prompt;
      const start = message.text.indexOf(url);
      if (width) message.inlineCode = [{ start, end: start + url.length }];
      const label = shortened ? url.slice(0, -1) : url;
      message.links = [{ start, end: start + label.length, href: new URL(label).href }];
      const completed = await reviews.collect(record.id, 0);
      assert.equal(completed.state, 'completed');
      message.text = message.text.slice(0, start + label.length) + 'changed' + message.text.slice(start + label.length);
      assert.throws(() => reviews.assertPrevious(completed, view), { code: 'review_content_mismatch' });
    }
  }
});

test('autolink ranges preserve adjacent source text and cannot insert an empty link', async () => {
  const url = 'https://example.com/docs?x=1#section';
  for (const prefix of ['https://example.com', 'https://example.com/docs', 'https://example.com/docs?x=1', '']) {
    const { reviews, record, view } = await context('See ' + url + ' original source');
    view.messages[0].text = record.prompt.replace(url, `[${prefix}](${prefix})${url.slice(prefix.length)}`);
    if (prefix) assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
    else await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
  }
});

test('literal backticks and URL punctuation survive different editor link ranges', async () => {
  for (const url of ['https://source.example/path.', 'https://source.example/path?', 'https://source.example/path)']) {
    for (const shortened of [false, true]) {
      const { reviews, record, view } = await context(`Review \`${url}\` now.`);
      const message = view.messages[0];
      message.text = record.prompt;
      const start = message.text.indexOf(url), label = shortened ? url.slice(0, -1) : url;
      message.links = [{ start, end: start + label.length, href: new URL(label).href }];
      assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
    }
  }
});

test('autolink labels and destinations retain source backslashes despite display escaping', async () => {
  const url = 'https://example.invalid/image\\';
  for (const alteration of ['none', 'changed-label', 'changed-destination', 'shortened-destination']) {
    const { reviews, record, view } = await context('See https://example.invalid/image" next');
    const display = url.replaceAll('\\', '\\\\');
    const label = alteration === 'changed-label' ? display + '#changed' : display;
    const destination = alteration === 'changed-destination' ? display + '#changed' :
      alteration === 'shortened-destination' ? display.slice(0, -2) : display;
    view.messages[0].text = record.prompt.replace(url, `[${label}](${destination})`);
    if (alteration === 'none') assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
    else await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
  }
});

test('autolink destinations may escape parentheses independently of the unchanged label', async () => {
  for (const url of ['https://example.com/rules)으로', 'https://example.com/(rules)/next']) {
    for (const alteration of ['none', 'plain-parentheses', 'changed-destination', 'shortened-destination']) {
      const { reviews, record, view } = await context(`See ${url} next`);
      const destination = alteration === 'changed-destination' ? url + '#changed' :
        alteration === 'shortened-destination' ? url.split(')')[0] :
          alteration === 'plain-parentheses' ? url : url.replaceAll(')', '\\)');
      view.messages[0].text = record.prompt.replace(url, `[${url}](${destination})`);
      if (['none', 'plain-parentheses'].includes(alteration)) assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
      else await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
    }
  }
});

test('literal text annotated as inline code still requires every original character', async () => {
  for (const alteration of ['none', 'changed', 'removed-backslash']) {
    const { reviews, record, view } = await context('tool@latest\\n next');
    const literal = escaped('@latest\\\\n');
    const start = view.messages[0].text.indexOf(literal);
    assert(start >= 0);
    view.messages[0].inlineCode = [{ start, end: start + literal.length }];
    if (alteration === 'changed') view.messages[0].text = view.messages[0].text.replace('@latest', '@oldest');
    if (alteration === 'removed-backslash') view.messages[0].text = view.messages[0].text.replace(literal, literal.replaceAll('\\', ''));
    if (alteration === 'none') assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
    else await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
  }
});

test('large autolinks with internal parentheses can be collected promptly without truncation', async () => {
  const url = 'https://example.invalid/' + '(a)'.repeat(20000);
  const { reviews, record, view } = await context('See ' + url + ' next');
  view.messages[0].text = record.prompt.replace(url, `[${url}](${url})`);
  const started = performance.now();
  assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
  const elapsedMs = performance.now() - started;
  assert(elapsedMs < 2000, `Full URL collection took ${elapsedMs.toFixed(1)} ms`);
});

test('inline code needs matching DOM ranges and the original full fence and contents', async () => {
  const codes = [['`one`', 'one'], ['``two ` three``', 'two ` three'], ['``` four `` five ```', 'four `` five']];
  for (const alteration of ['none', 'missing-format', 'changed-content']) {
    const { reviews, record, view } = await context(codes.map(([raw]) => raw).join(' then '));
    const spans = []; let text = ''; let offset = 0;
    for (const [raw, value] of codes) {
      const index = record.prompt.indexOf(raw, offset);
      text += record.prompt.slice(offset, index);
      spans.push({ start: text.length, end: text.length + value.length });
      text += value; offset = index + raw.length;
    }
    view.messages[0].text = text + record.prompt.slice(offset);
    view.messages[0].inlineCode = alteration === 'missing-format' ? [] : spans;
    if (alteration === 'changed-content') view.messages[0].text = view.messages[0].text.replace('one', 'two');
    if (alteration === 'none') assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
    else await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
  }
});

test('part of an opening backtick run cannot become a shorter code delimiter', async () => {
  for (const raw of ['``one`', '```one`']) {
    const { reviews, record, view } = await context(raw);
    const index = record.prompt.indexOf(raw);
    const prefix = raw.slice(0, raw.indexOf('one') - 1);
    view.messages[0].text = record.prompt.replace(raw, prefix + 'one');
    view.messages[0].inlineCode = [{ start: index + prefix.length, end: index + prefix.length + 3 }];
    await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
  }
});

test('copied UUIDs, truncated or changed source and removed original escapes cannot complete a request', async () => {
  for (const alter of [text => text.replace('original', 'different'), text => text.replace('original', ''),
    text => text.replace('source.txt', 'other.txt'), text => text.replace('\\n', 'n'),
    text => text.replace('\\*', '*'), text => text + '\\', text => text.replace('original', '\\original')]) {
    const { reviews, record, view } = await context();
    view.messages[0].text = alter(record.prompt);
    await assert.rejects(reviews.collect(record.id, 0), { code: 'review_content_mismatch' });
    assert.equal(reviews.get(record.id).state, 'submitted');
  }
});

test('same UUID rendered twice is ambiguous even if only one body is byte-identical', async () => {
  const { reviews, record, view } = await context();
  view.messages.unshift({ ...view.messages[0], id: randomUUID(), text: record.prompt });
  await assert.rejects(reviews.collect(record.id, 0), { code: 'ambiguous_request' });
});

test('collect after restart rejects a replaced native message or changed bound body', async () => {
  for (const change of ['id', 'body']) {
    const { reviews, record, view, profile, browser } = await context();
    view.messages[1].complete = false;
    const pending = await reviews.collect(record.id, 0);
    assert.equal(pending.observation.state, 'generating');
    const restored = new Reviews(profile, browser);
    if (change === 'id') view.messages[0].id = randomUUID();
    else view.messages[0].text = view.messages[0].text.replace('original', 'changed');
    await assert.rejects(restored.collect(record.id, 0), { code: change === 'id' ? 'conversation_changed' : 'review_content_mismatch' });
  }
});

test('a temporary conversation URL can become canonical without replacing the recorded request', async () => {
  const { reviews, record, view, profile, browser } = await context();
  const temporaryURL = `${project.origin}/g/${project.id}/c/local-chatgpt%3A${randomUUID()}`;
  reviews.save(reviews.get(record.id), { conversationURL: temporaryURL, userMessageId: view.messages[0].id });
  const restored = new Reviews(profile, browser);
  const completed = await restored.collect(record.id, 0);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.conversationURL, view.url);
  assert.equal(completed.userMessageId, view.messages[0].id);
  assert.equal(completed.promptHash, record.promptHash);
  assert.deepEqual(completed.sources, record.sources);
});

test('URL migration during generation remains bound to the same native request and canonical conversation', async () => {
  const { reviews, record, view } = await context();
  const temporaryURL = `${project.origin}/g/${project.id}/c/local-chatgpt%3A${randomUUID()}`;
  reviews.save(reviews.get(record.id), { conversationURL: temporaryURL, userMessageId: view.messages[0].id });
  view.busy = true;
  const pending = await reviews.collect(record.id, 0);
  assert.equal(pending.observation.state, 'generating');
  assert.equal(reviews.get(record.id).conversationURL, view.url);
  view.url = `${project.origin}/g/${project.id}/c/${randomUUID()}`;
  await assert.rejects(reviews.collect(record.id, 0), { code: 'conversation_changed' });
  assert.notEqual(reviews.get(record.id).state, 'completed');
});

test('URL migration during generation defers missing viewport history until full idle verification', async () => {
  for (const changed of [false, true]) {
    const { reviews, record, view, browser } = await context();
    const earlier = [{ id: randomUUID(), role: 'user', text: 'earlier source', complete: false, error: '' },
      { id: randomUUID(), role: 'assistant', text: 'earlier answer', complete: true, error: '' }];
    reviews.save(reviews.get(record.id), {
      conversationURL: `${project.origin}/g/${project.id}/c/local-chatgpt%3A${randomUUID()}`,
      userMessageId: view.messages[0].id, baselineIds: earlier.map(message => message.id),
      baselineHistory: earlier.map(({ text, ...identity }) => ({ ...identity, textHash: hash(text) })),
    });
    const historyReads = [];
    browser.reviewView = async (_signal, requiredIds = []) => {
      if (requiredIds.length) {
        assert.equal(view.busy, false);
        historyReads.push(requiredIds);
      }
      const messages = requiredIds.length ? [...earlier, ...view.messages] : view.messages;
      return { ...structuredClone(view), messages: structuredClone(messages), inputHistory: JSON.stringify(messages) };
    };
    view.busy = true;
    assert.equal((await reviews.collect(record.id, 0)).observation.state, 'generating');
    assert.equal(reviews.get(record.id).conversationURL, view.url);
    assert.deepEqual(historyReads, []);
    view.busy = false;
    if (changed) {
      earlier[0].text = 'changed earlier source';
      await assert.rejects(reviews.collect(record.id, 0), { code: 'conversation_changed' });
      assert.equal(reviews.get(record.id).answer, undefined);
      assert.notEqual(reviews.get(record.id).state, 'completed');
    } else assert.equal((await reviews.collect(record.id, 0)).state, 'completed');
    assert.equal(historyReads.length, 1);
    assert.deepEqual(historyReads[0], [...earlier.map(message => message.id), view.messages[0].id]);
  }
});

test('a canonical URL cannot adopt a copied, changed or interleaved temporary request', async () => {
  for (const alteration of ['copied-id', 'unbound-id', 'body', 'baseline', 'another-local-url', 'origin', 'project']) {
    const { reviews, record, view } = await context();
    const temporaryURL = `${project.origin}/g/${project.id}/c/local-chatgpt%3A${randomUUID()}`;
    reviews.save(reviews.get(record.id), { conversationURL: temporaryURL, userMessageId: view.messages[0].id });
    if (alteration === 'unbound-id') reviews.save(reviews.get(record.id), { userMessageId: undefined });
    if (alteration === 'copied-id') view.messages[0].id = randomUUID();
    if (alteration === 'body') view.messages[0].text = view.messages[0].text.replace('original', 'changed');
    if (alteration === 'baseline') view.messages.unshift({ id: randomUUID(), role: 'user', text: 'another question', error: '', complete: false });
    if (alteration === 'another-local-url') view.url = `${project.origin}/g/${project.id}/c/local-chatgpt%3A${randomUUID()}`;
    if (alteration === 'origin') view.url = view.url.replace(project.origin, 'https://other.example');
    if (alteration === 'project') view.url = view.url.replace(project.id, 'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await assert.rejects(reviews.collect(record.id, 0), { code: alteration === 'body' ? 'review_content_mismatch' :
      ['origin', 'project'].includes(alteration) ? 'project_changed' : 'conversation_changed' });
    assert.equal(reviews.get(record.id).conversationURL, temporaryURL);
    assert.notEqual(reviews.get(record.id).state, 'completed');
  }
});

test('continuation verifies a migrated conversation before navigating or dispatching input', async () => {
  const { reviews, record, view, browser } = await context();
  Object.assign(view, { composer: { attribute: 'id', value: 'prompt-textarea' }, draft: '', attachments: false });
  const previous = reviews.save(reviews.get(record.id), {
    state: 'completed', conversationURL: `${project.origin}/g/${project.id}/c/local-chatgpt%3A${randomUUID()}`,
    userMessageId: view.messages[0].id, responseId: view.messages[1].id, answerHash: hash(view.messages[1].text),
  });
  browser.execute = async () => { assert.fail('The same observed conversation must not be navigated or receive input.'); };
  const current = await reviews.openPrevious(previous, project, undefined, Date.now() + 30000);
  assert.equal(current.url, view.url);
  assert.equal(reviews.get(record.id).conversationURL, view.url);
});

test('continuation fixes the first verified canonical URL before waiting for stability', async () => {
  for (const changed of [false, true]) {
    const { reviews, record, view, browser } = await context();
    Object.assign(view, { composer: { attribute: 'id', value: 'prompt-textarea' }, draft: '', attachments: false, stableForMs: 0 });
    const canonicalURL = view.url;
    const previous = reviews.save(reviews.get(record.id), {
      state: 'completed', conversationURL: `${project.origin}/g/${project.id}/c/local-chatgpt%3A${randomUUID()}`,
      userMessageId: view.messages[0].id, responseId: view.messages[1].id, answerHash: hash(view.messages[1].text),
    });
    let waits = 0;
    browser.execute = async () => { assert.fail('Verified continuation must not navigate or dispatch input.'); };
    browser.waitReviewChange = async () => {
      waits++;
      if (changed) view.url = `${project.origin}/g/${project.id}/c/${randomUUID()}`;
      view.stableForMs = 1000;
    };
    const operation = reviews.openPrevious(previous, project, undefined, Date.now() + 30000);
    if (changed) await assert.rejects(operation, { code: 'conversation_changed' });
    else assert.equal((await operation).url, canonicalURL);
    assert.equal(waits, 1);
    assert.equal(reviews.get(record.id).conversationURL, canonicalURL);
  }
});
