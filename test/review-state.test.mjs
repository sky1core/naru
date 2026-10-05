import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Reviews } from '../src/review.mjs';
import { Project } from '../src/project.mjs';
import { Browser } from '../src/browser.mjs';

const projectId = 'g-p-0123456789abcdef0123456789abcdef';
const homeURL = `https://example.com/g/${projectId}/project`;

test('continuation navigation preserves a draft, attachment or generation that appears on the last browser observation', async () => {
  await mkdir('artifacts/review-state-runs', { recursive: true });
  const profile = await mkdtemp(resolve('artifacts/review-state-runs/run-'));
  const documentId = randomUUID();
  let view = { url: homeURL, composer: { attribute: 'id', value: 'prompt-textarea' }, composerPlacement: null,
    draft: '', busy: false, attachments: false, messages: [], stableForMs: 1000,
    send: { attribute: 'data-testid', value: 'send-button' }, sendEnabled: true };
  const browser = {
    assertDocument: id => assert.equal(id, documentId), assertActive() {},
    status: () => ({ documentId }), reviewView: async () => ({ ...structuredClone(view), inputHistory: JSON.stringify(view.messages) }),
    snapshot: async () => ({ elements: [{ attributes: { 'data-app-action-sidebar-project-id': projectId } }] }),
    async execute(command, _signal, _deadlineAt, beforeDispatch) {
      if (command.action === 'navigate') view.url = command.url;
      if (command.action === 'fill') view.draft = command.text;
      if (command.action === 'click') {
        beforeDispatch?.();
        const id = view.draft.match(/Review request UUID: ([a-f0-9-]+)/)[1];
        view.messages.push({ id: `u-${id}`, role: 'user', text: view.draft, error: '', complete: false },
          { id: `a-${id}`, role: 'assistant', text: `answer\nEND-OF-REVIEW:${id}`, error: '', complete: true });
        view.draft = ''; view.url = `https://example.com/g/${projectId}/c/${id}`;
      }
      return { documentId };
    },
  };
  await new Project(profile, browser).bind(documentId);
  const reviews = new Reviews(profile, browser);
  const first = reviews.prepare({ reviewId: randomUUID(), question: 'original', files: [] });
  await reviews.submit(first.id, documentId, undefined, Date.now() + 30000);
  const previous = await reviews.collect(first.id, 0);
  assert.equal(previous.state, 'completed');
  for (const change of [{ draft: 'new private draft' }, { attachments: true }, { busy: true }]) {
    const next = reviews.prepare({ reviewId: randomUUID(), question: 'follow', files: [],
      continueFrom: { reviewId: previous.id, promptHash: previous.promptHash, answerHash: previous.answerHash } });
    let observations = 0, navigations = 0;
    browser.reviewView = async () => {
      observations++;
      return { ...view, url: homeURL, messages: [], ...(observations >= 2 ? change : {}) };
    };
    browser.execute = async command => {
      if (command.action === 'navigate') navigations++;
      throw new Error('The page must not be left after new user work appears.');
    };
    await assert.rejects(reviews.submit(next.id, documentId, undefined, Date.now() + 30000),
      { code: change.busy ? 'generation_active' : change.attachments ? 'attachments_present' : 'draft_conflict' });
    assert.equal(navigations, 0);
    assert.equal(reviews.get(next.id).state, 'prepared');
    assert.equal(reviews.get(next.id).lastFailure.phase, 'opening_previous');
    assert.equal(reviews.get(next.id).lastFailure.error.code, change.busy ? 'generation_active' : change.attachments ? 'attachments_present' : 'draft_conflict');
  }
});


test('history pages loaded after a temporary empty viewport remain part of the observed lineage', async () => {
  for (const navigateWhileEmpty of [false, true]) {
    const messages = Array.from({ length: 17 }, (_, index) => ({ id: `message-${index}`, role: 'user', text: `body-${index}` }));
    const latest = messages.slice(10), middle = messages.slice(8, 12), earlier = messages.slice(6, 10);
    let current = latest, url = `${homeURL}/conversation`, earlierScrolls = 0;
    const contents = {
      debugger: { attach() {} }, session: { webRequest: { onErrorOccurred() {}, onCompleted() {} } }, on() {},
      isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => url, focus() {},
      async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
        if (code.includes('"action":"scroll-history"')) {
          if (code.includes('"direction":"earlier"')) current = ++earlierScrolls === 1 ? [] : earlier;
          else current = latest;
          return { moved: true };
        }
        if (code.includes('"action":"wait"')) {
          current = middle;
          if (navigateWhileEmpty) url = 'https://example.com/other-conversation';
          return;
        }
        return { url, messages: structuredClone(current), stableForMs: 1000, busy: false, historyScrollable: true, historyAtLatest: current === latest };
      },
    };
    const browser = new Browser({ webContents: contents, focus() {} });
    const result = browser.reviewView(undefined, messages.slice(6).map(message => message.id), Date.now() + 5000);
    if (navigateWhileEmpty) {
      await assert.rejects(result, { code: 'conversation_changed' });
      assert.equal(earlierScrolls, 1);
    } else {
      const view = await result;
      assert.deepEqual(view.messages, messages.slice(6));
      assert.deepEqual(JSON.parse(view.inputHistory), latest);
      assert.equal(earlierScrolls, 2);
    }
  }
});

test('submission preserves an exact legacy or encoded draft and blocks a representation swap', async () => {
  for (const kind of ['legacy', 'encoded', 'legacy-to-encoded', 'encoded-to-legacy', 'new-fill-swapped']) {
    await mkdir('artifacts/review-state-runs', { recursive: true });
    const profile = await mkdtemp(resolve('artifacts/review-state-runs/run-'));
    const documentId = randomUUID();
    let view = { url: homeURL, composer: { attribute: 'id', value: 'prompt-textarea' }, composerPlacement: null,
      draft: '', attachments: false, busy: false, stableForMs: 1000, messages: [],
      send: { attribute: 'data-testid', value: 'send-button' }, sendEnabled: true };
    let reads = 0, fills = 0, clicks = 0, canonical, encoded;
    const browser = {
      assertDocument(id) { assert.equal(id, documentId); }, assertActive() {}, status: () => ({ documentId }),
      snapshot: async () => ({ elements: [{ attributes: { 'data-app-action-sidebar-project-id': projectId } }] }),
      reviewView: async () => {
        reads++;
        if (reads === 2 && kind === 'legacy-to-encoded') view.draft = encoded;
        if (reads === 2 && kind === 'encoded-to-legacy') view.draft = canonical;
        return { ...structuredClone(view), inputHistory: JSON.stringify(view.messages) };
      },
      async execute(command, _signal, _deadlineAt, beforeDispatch) {
        if (command.action === 'navigate') view.url = command.url;
        if (command.action === 'fill') { fills++; view.draft = kind === 'new-fill-swapped' ? canonical : command.text; }
        if (command.action === 'click') {
          assert.equal(command.expectedText.text, view.draft);
          beforeDispatch?.(); clicks++;
          const id = view.draft.match(/Review request UUID: ([a-f0-9-]+)/)[1];
          view.messages = [{ id: 'user-' + id, role: 'user', text: view.draft, error: '', complete: false }];
          view.draft = ''; view.url = `https://example.com/g/${projectId}/c/${id}`;
        }
      },
    };
    await new Project(profile, browser).bind(documentId);
    const reviews = new Reviews(profile, browser);
    const record = reviews.prepare({ reviewId: randomUUID(), question: 'Original source', files: [] });
    canonical = record.prompt;
    const lines = canonical.split('\n');
    encoded = [...lines.slice(0, 2), '```json', lines[2], '```', ...lines.slice(3)].join('\n');
    if (kind !== 'new-fill-swapped') {
      reviews.save(record, { state: 'failed', project: { id: projectId, origin: 'https://example.com' },
        startURL: homeURL, origin: 'https://example.com', baselineIds: [], baselineHistory: [] });
      view.draft = kind.startsWith('legacy') ? canonical : encoded;
    }
    reads = 0;
    if (kind === 'legacy' || kind === 'encoded') {
      const submitted = await reviews.submit(record.id, documentId, undefined, Date.now() + 30000);
      assert.equal(submitted.state, 'submitted');
      assert.equal(submitted.prompt, canonical);
      assert.equal(submitted.promptHash, record.promptHash);
      assert.equal(view.messages[0].text, kind === 'legacy' ? canonical : encoded);
      assert.equal(fills, 0);
      assert.equal(clicks, 1);
    } else {
      await assert.rejects(reviews.submit(record.id, documentId, undefined, Date.now() + 30000), { code: 'draft_conflict' });
      assert.equal(clicks, 0);
      assert.equal(fills, kind === 'new-fill-swapped' ? 1 : 0);
      assert.equal(view.draft, kind === 'legacy-to-encoded' ? encoded : canonical);
      assert.equal(reviews.get(record.id).sendAttemptedAt, undefined);
    }
  }
});
