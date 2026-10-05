import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Reviews } from '../src/review.mjs';
import { Project } from '../src/project.mjs';
import { RelayError, requestSchema } from '../src/protocol.mjs';

async function setup() {
  await mkdir('artifacts/recovery-unit-runs', { recursive: true });
  const profile = await mkdtemp(resolve('artifacts/recovery-unit-runs/run-'));
  const projectId = 'g-p-0123456789abcdef0123456789abcdef';
  const documentId = randomUUID();
  const view = { url: `https://example.com/g/${projectId}/project`, composer: { attribute: 'id', value: 'prompt-textarea' },
    composerPlacement: 'home', draft: '', busy: false, attachments: false, messages: [], stableForMs: 1000,
    send: { attribute: 'data-testid', value: 'send-button' }, sendEnabled: true };
  const effects = [];
  const browser = {
    assertDocument: id => assert.equal(id, documentId),
    assertActive(signal) { if (signal?.aborted) throw new RelayError('command_timeout', 'Execution deadline expired.', 504); },
    status: () => ({ documentId }), reviewView: async () => ({ ...structuredClone(view), inputHistory: JSON.stringify(view.messages) }),
    snapshot: async () => ({ elements: [{ attributes: { 'data-app-action-sidebar-project-id': projectId } }] }),
    async execute(command, signal, _deadlineAt, beforeDispatch) {
      this.assertActive(signal); effects.push(command.action);
      if (command.action === 'navigate') view.url = command.url;
      if (command.action === 'fill') view.draft = command.text;
      if (command.action === 'click') {
        beforeDispatch?.();
        const id = view.draft.match(/Review request UUID: ([a-f0-9-]+)/)[1];
        view.messages.push({ id: `u-${id}`, role: 'user', text: view.draft, error: '', complete: false },
          { id: `a-${id}`, role: 'assistant', text: `answer\nEND-OF-REVIEW:${id}`, error: '', complete: true });
        view.draft = '';
        view.url = `https://example.com/g/${projectId}/c/${id}`;
      }
      return { documentId };
    },
  };
  await new Project(profile, browser).bind(documentId);
  const reviews = new Reviews(profile, browser);
  const record = reviews.prepare({ reviewId: randomUUID(), question: 'Keep the original material.', files: [] });
  const submit = signal => reviews.submit(record.id, documentId, signal, Date.now() + 30000);
  return { reviews, record, view, browser, effects, submit };
}

test('interrupted preparation resumes its original identity with an empty or exact draft', async () => {
  for (const draft of ['empty', 'exact']) {
    const { reviews, record, view, effects, submit } = await setup();
    reviews.save(record, { state: 'preparing', startURL: view.url, baselineIds: [] });
    if (draft === 'exact') view.draft = record.prompt;
    assert.equal((await submit()).state, 'submitted');
    const expected = draft === 'exact' ? record.prompt : record.prompt.replace(/^(\{"id":.*\})$/m, '```json\n$1\n```');
    assert.equal(view.messages[0].text, expected);
    assert.equal(reviews.get(record.id).promptHash, record.promptHash);
    assert.equal(effects.filter(action => action === 'fill').length, draft === 'exact' ? 0 : 1);
    await submit();
    assert.equal(view.messages.filter(message => message.role === 'user').length, 1);
  }
});

test('interrupted preparation preserves conflicting drafts and conversation history', async () => {
  for (const conflict of ['draft', 'history', 'conversation']) {
    const { reviews, record, view, effects, submit } = await setup();
    reviews.save(record, { state: 'preparing', startURL: view.url, baselineIds: [] });
    view.draft = conflict === 'draft' ? 'private user work' : record.prompt;
    if (conflict === 'history') view.messages.push({ id: 'new-user', role: 'user', text: 'new turn' });
    if (conflict === 'conversation') view.url = view.url.replace('/project', '/c/another');
    await assert.rejects(submit(), { code: conflict === 'draft' ? 'draft_conflict' : 'conversation_changed' });
    assert.equal(effects.length, 0);
    assert.equal(view.draft, conflict === 'draft' ? 'private user work' : record.prompt);
  }
});

test('a deadline persists the failed phase while browser work remains unsettled', async () => {
  for (const afterDispatch of [false, true]) {
    const { reviews, record, browser, effects, submit } = await setup();
    const entered = Promise.withResolvers(), pending = Promise.withResolvers();
    const execute = browser.execute.bind(browser);
    browser.execute = async (command, signal, deadlineAt, beforeDispatch) => {
      if (command.action !== (afterDispatch ? 'click' : 'fill')) return execute(command, signal, deadlineAt, beforeDispatch);
      if (afterDispatch) beforeDispatch();
      entered.resolve();
      await pending.promise;
      browser.assertActive(signal);
    };
    const controller = new AbortController();
    const operation = submit(controller.signal);
    const rejected = assert.rejects(operation, { code: 'command_timeout' });
    await entered.promise; controller.abort();
    try {
      const failed = reviews.get(record.id);
      assert.equal(failed.state, afterDispatch ? 'uncertain' : 'failed');
      assert.equal(failed.error.code, 'command_timeout');
      assert.equal(failed.lastFailure.phase, afterDispatch ? 'sending' : 'filling');
      assert.equal(Boolean(failed.sendAttemptedAt), afterDispatch);
    } finally { pending.resolve(); await rejected; }
    assert.equal(reviews.get(record.id).state, afterDispatch ? 'uncertain' : 'failed');
    if (afterDispatch) { await submit(); assert.equal(effects.filter(action => action === 'click').length, 0); }
    else {
      const failure = reviews.get(record.id).lastFailure;
      browser.execute = execute;
      assert.equal((await submit()).state, 'submitted');
      assert.deepEqual(reviews.get(record.id).lastFailure, failure);
      assert.equal(reviews.get(record.id).error, undefined);
    }
  }
});

test('a recorded send attempt prevents replay regardless of a stale preparation state', async () => {
  const { reviews, record, effects, submit } = await setup();
  for (const state of ['preparing', 'failed', 'send_attempted', 'submitted', 'uncertain']) {
    reviews.save(record, { state, sendAttemptedAt: new Date().toISOString() });
    await submit();
    assert.equal(effects.length, 0);
  }
});

test('resuming an empty draft cannot change its recorded project', async () => {
  const { reviews, record, browser, view, effects, submit } = await setup();
  const project = reviews.project.require();
  const alternate = 'g-p-fedcba9876543210fedcba9876543210';
  reviews.save(record, { state: 'preparing', project, startURL: view.url, baselineIds: [] });
  view.url = view.url.replace(project.id, alternate);
  browser.snapshot = async () => ({ elements: [{ attributes: { 'data-app-action-sidebar-project-id': alternate } }] });
  await reviews.project.bind(browser.status().documentId);
  await assert.rejects(submit(), { code: 'project_changed' });
  assert.equal(effects.length, 0);
  assert.deepEqual(reviews.get(record.id).project, project);
});

test('preflight timeouts replace stale failure diagnostics even before browser work settles', async () => {
  for (const step of ['checking_context', 'opening_project', 'opening_previous']) {
    const { reviews, record, browser, view, submit } = await setup();
    let id = record.id;
    if (step === 'opening_previous') {
      await submit();
      const previous = await reviews.collect(id, 0);
      const next = reviews.prepare({ reviewId: randomUUID(), question: 'Continue.', files: [],
        continueFrom: { reviewId: id, promptHash: previous.promptHash, answerHash: previous.answerHash } });
      id = next.id; view.url = reviews.project.require().url; view.messages = [];
    }
    reviews.save(reviews.get(id), { phase: 'effort.wait_changed', lastFailure: { phase: 'effort.wait_changed', error: { code: 'old_error' } } });
    const entered = Promise.withResolvers(), pending = Promise.withResolvers();
    const controller = new AbortController();
    const blocked = async () => {
      entered.resolve(); await pending.promise;
      browser.assertActive(controller.signal);
    };
    if (step === 'checking_context') browser.reviewView = blocked;
    else browser.execute = blocked;
    const operation = reviews.submit(id, browser.status().documentId, controller.signal, Date.now() + 30000);
    const rejected = assert.rejects(operation, { code: 'command_timeout' });
    await entered.promise; controller.abort();
    try {
      const failed = reviews.get(id);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.lastFailure.phase, step);
      assert.equal(failed.error.code, 'command_timeout');
      assert.equal(failed.sendAttemptedAt, undefined);
    } finally { pending.resolve(); await rejected; }
    assert.equal(reviews.get(id).lastFailure.phase, step);
  }
});

test('submit persists the native message and conversation before returning, without collecting or resending', async () => {
  const { reviews, record, view, effects, submit } = await setup();
  const submitted = await submit();
  assert.equal(submitted.userMessageId, view.messages[0].id);
  assert.equal(submitted.conversationURL, view.url);
  assert.equal(reviews.get(record.id).userMessageId, submitted.userMessageId);
  await submit();
  assert.equal(effects.filter(action => action === 'click').length, 1);
});


test('submission binds the sent message without scanning old pages during generation, then collection verifies full history', async () => {
  for (const changeHistory of [false, true]) {
    const { reviews, record, view, browser, submit } = await setup();
    await submit();
    const first = await reviews.collect(record.id, 0);
    const next = reviews.prepare({ reviewId: randomUUID(), question: 'Follow the existing material.', files: [],
      continueFrom: { reviewId: first.id, promptHash: first.promptHash, answerHash: first.answerHash } });
    const execute = browser.execute.bind(browser);
    browser.execute = async (...args) => {
      const result = await execute(...args);
      if (args[0].action === 'click') { view.busy = true; view.url = first.conversationURL; }
      return result;
    };
    let historyReadsDuringGeneration = 0, historyReadsAfterGeneration = 0;
    browser.reviewView = async (_signal, requiredIds = []) => {
      if (requiredIds.length && view.messages.length > 2) {
        if (view.busy) historyReadsDuringGeneration++;
        else historyReadsAfterGeneration++;
      }
      const messages = requiredIds.length ? view.messages : view.messages.slice(-2);
      return { ...structuredClone(view), messages: structuredClone(messages), inputHistory: JSON.stringify(messages) };
    };
    const sent = await reviews.submit(next.id, browser.status().documentId, undefined, Date.now() + 30000);
    assert.equal(sent.state, 'submitted');
    assert.equal(sent.userMessageId, `u-${next.id}`);
    const pending = await reviews.collect(next.id, 0);
    assert.equal(pending.observation.state, 'generating');
    assert.equal(historyReadsDuringGeneration, 0);
    view.busy = false;
    if (changeHistory) {
      view.messages[0].text = 'changed source after sending';
      await assert.rejects(reviews.collect(next.id, 0), error => ['conversation_changed', 'review_content_mismatch'].includes(error.code));
      assert.notEqual(reviews.get(next.id).state, 'completed');
    } else assert.equal((await reviews.collect(next.id, 0)).state, 'completed');
    assert.equal(historyReadsAfterGeneration, 1);
  }
});


test('public review requests get their declared longer deadline while explicit limits and ordinary commands stay unchanged', () => {
  for (const command of [
    { action: 'review.prepare', reviewId: randomUUID(), question: 'review', files: [] },
    { action: 'review.submit', reviewId: randomUUID(), documentId: randomUUID() },
    { action: 'review.collect', reviewId: randomUUID(), waitMs: 30000 },
  ]) {
    assert.equal(requestSchema.parse({ id: randomUUID(), command }).deadlineMs, 120000);
    assert.equal(requestSchema.parse({ id: randomUUID(), command, deadlineMs: 100 }).deadlineMs, 100);
  }
  assert.equal(requestSchema.parse({ id: randomUUID(), command: { action: 'screenshot' } }).deadlineMs, 30000);
  assert.equal(requestSchema.safeParse({ id: randomUUID(), command: { action: 'screenshot' }, deadlineMs: 120001 }).success, false);
});
