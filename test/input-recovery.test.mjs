import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Reviews } from '../src/review.mjs';
import { Browser } from '../src/browser.mjs';
import { startServer } from '../src/server.mjs';
import { connect } from '../src/client.mjs';
import { writePrivateJSON } from '../src/profile.mjs';

function setup() {
  const receipt = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const contents = new EventEmitter();
  const cancelled = Promise.withResolvers();
  let cancellations = 0;
  Object.assign(contents, {
    debugger: { attach() {}, async sendCommand() {} },
    session: { webRequest: { onErrorOccurred() {}, onCompleted() {} } },
    mainFrame: { framesInSubtree: [] },
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    focus() {},
    getURL: () => 'http://127.0.0.1/',
    getTitle: () => 'Input recovery fixture',
    async executeJavaScriptInIsolatedWorld(_world, scripts) {
      if (scripts[0].code.startsWith('globalThis.chatgptRelayInput.finish(')) {
        entered.resolve();
        return receipt.promise;
      }
      if (scripts[0].code.startsWith('globalThis.chatgptRelayInput.cancel(')) {
        cancellations++;
        receipt.resolve({ blocked: true });
        cancelled.resolve();
        return;
      }
      return { x: 1, y: 1, text: 'ready' };
    },
  });
  const browser = new Browser({ webContents: contents, focus() {} });
  return { browser, contents, receipt, entered, cancelled, cancellations: () => cancellations };
}

test('an expired click or key receipt settles without another input event', async () => {
  for (const action of ['click', 'press']) {
    const { browser, receipt, entered, cancellations } = setup();
    const controller = new AbortController();
    const outcome = browser.execute({ action, key: 'Escape', documentId: browser.documentId,
      target: { attribute: 'id', value: 'control' } }, controller.signal, Date.now() + 1000)
      .then(result => ({ result }), error => ({ error }));
    await entered.promise;
    controller.abort();
    try {
      const result = await Promise.race([outcome, delay(200).then(() => null)]);
      assert.notEqual(result, null, 'Expired input still waits for a missing terminal event.');
      assert.equal(result.error?.code, 'command_timeout');
      assert.equal(cancellations(), 1);
    } finally {
      receipt.resolve({ blocked: true });
      await outcome;
    }
  }
});

test('an expired native dispatch stays unsettled until the browser acknowledges it', async () => {
  const { browser, contents, receipt, cancellations } = setup();
  const controller = new AbortController();
  const dispatch = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let settled = false;
  contents.debugger.sendCommand = () => { entered.resolve(); return dispatch.promise; };
  const outcome = browser.execute({ action: 'click', documentId: browser.documentId,
    target: { attribute: 'id', value: 'control' } }, controller.signal, Date.now() + 1000)
    .then(result => ({ result }), error => ({ error })).finally(() => { settled = true; });
  await entered.promise;
  controller.abort();
  try {
    await delay(20);
    assert.equal(settled, false);
    assert.equal(cancellations(), 0);
    dispatch.resolve();
    const result = await Promise.race([outcome, delay(200).then(() => null)]);
    assert.notEqual(result, null, 'Acknowledged dispatch still waits for a missing terminal event.');
    assert.equal(result.error?.code, 'command_timeout');
    assert.equal(cancellations(), 1);
  } finally {
    dispatch.resolve();
    receipt.resolve({ blocked: true });
    await outcome;
  }
});

test('the public API accepts the next command after a missing receipt times out without replaying input', async () => {
  const { browser, contents, receipt, entered, cancelled } = setup();
  let inputs = 0;
  contents.debugger.sendCommand = async () => { inputs++; };
  const profile = await mkdtemp(join(tmpdir(), 'naru-input-recovery-'));
  const { server, descriptor } = await startServer({ browser, profile, quit() {} });
  writePrivateJSON(join(profile, 'connection.json'), descriptor);
  const call = await connect(profile);
  const id = randomUUID();
  const request = { id, deadlineMs: 100, command: { action: 'click', documentId: browser.documentId,
    target: { attribute: 'id', value: 'control' } } };
  try {
    const expired = assert.rejects(call('/v1/commands', request), { code: 'command_timeout' });
    await entered.promise;
    await expired;
    assert.notEqual(await Promise.race([cancelled.promise.then(() => true), delay(200).then(() => null)]), null);
    assert.equal((await call('/v1/status')).execution, null);
    const { lastInput } = await call('/v1/diagnostics');
    assert.equal(lastInput.stage, 'waiting_receipt');
    assert.equal(lastInput.state, 'failed');
    assert.equal(lastInput.error, 'command_timeout');
    assert.deepEqual(lastInput.native, [
      { type: 'mousePressed', state: 'acknowledged' },
      { type: 'mouseReleased', state: 'acknowledged' },
    ]);
    const next = await call('/v1/commands', { id: randomUUID(), command: { action: 'read',
      documentId: browser.documentId, target: { attribute: 'id', value: 'control' } } });
    assert.equal(next.result.text, 'ready');
    await assert.rejects(call(`/v1/requests/${id}`), { code: 'command_timeout' });
    await assert.rejects(call('/v1/commands', request), { code: 'command_timeout' });
    assert.equal(inputs, 2);
  } finally {
    receipt.resolve({ blocked: true });
    await new Promise(resolve => server.close(resolve));
  }
});


test('a stalled history scroll releases the public command lock on timeout without replay', async () => {
  const { browser, contents } = setup();
  const entered = Promise.withResolvers(), stalled = Promise.withResolvers();
  const profile = await mkdtemp(join(tmpdir(), 'naru-history-recovery-'));
  const reviews = new Reviews(profile, browser);
  const prepared = reviews.prepare({ reviewId: randomUUID(), question: 'original', files: [] });
  const url = 'http://127.0.0.1/g/g-p-0123456789abcdef0123456789abcdef/c/conversation';
  contents.getURL = () => url;
  const view = { url, problem: null, busy: false, messages: [{ id: 'own-user', role: 'user', text: prepared.prompt }], stableForMs: 1000, historyScrollable: true, historyAtLatest: false };
  reviews.save(prepared, { state: 'submitted', baselineIds: [], userMessageId: 'own-user', conversationURL: url, origin: 'http://127.0.0.1' });
  contents.executeJavaScriptInIsolatedWorld = async (_world, [{ code }]) => {
    if (code.includes('"action":"scroll-history"')) { entered.resolve(); return stalled.promise; }
    if (code.includes('"action":"cancel-wait"')) { stalled.resolve({ moved: false }); return; }
    return structuredClone(view);
  };
  const { server, descriptor } = await startServer({ browser, profile, quit() {} });
  writePrivateJSON(join(profile, 'connection.json'), descriptor);
  const call = await connect(profile);
  const request = { id: randomUUID(), deadlineMs: 100, command: { action: 'review.collect', reviewId: prepared.id, waitMs: 0 } };
  try {
    const expired = assert.rejects(call('/v1/commands', request), { code: 'command_timeout' });
    await entered.promise; await expired;
    assert.equal((await call('/v1/status')).execution, null);
    await assert.rejects(call('/v1/commands', request), { code: 'command_timeout' });
    assert.equal((await call('/v1/status')).execution, null);
  } finally { stalled.resolve({ moved: false }); await new Promise(resolve => server.close(resolve)); }
});
