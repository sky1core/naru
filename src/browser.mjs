import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { inspectEffort } from './effort-dom.mjs';
import { inspectDOM } from './dom.mjs';
import { inspectChatGPT } from './chatgpt-dom.mjs';
import { RelayError } from './protocol.mjs';

export class Browser {
  constructor(window) {
    this.window = window;
    this.contents = window.webContents;
    this.contents.debugger.attach('1.3');
    this.documentId = randomUUID();
    this.crashed = false;
    this.inputOperation = null;
    this.lastInput = null;
    this.reviewSnapshots = new WeakMap();
    this.guardedFrames = new Set();
    this.networkFailures = [];
    this.failureCount = 0;
    const recordFailure = (details) => {
      if (details.webContentsId !== this.contents.id) return;
      const url = new URL(details.url);
      this.failureCount += 1;
      this.networkFailures.push({ at: new Date().toISOString(), url: `${url.origin}${url.pathname}`,
        resourceType: details.resourceType, statusCode: details.statusCode, error: details.error });
      if (this.networkFailures.length > 100) this.networkFailures.shift();
    };
    this.contents.session.webRequest.onErrorOccurred(recordFailure);
    this.contents.session.webRequest.onCompleted((details) => { if (details.statusCode >= 400) recordFailure(details); });
    this.contents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) this.documentId = randomUUID();
    });
    this.contents.on('render-process-gone', () => { this.crashed = true; });
    this.contents.on('did-finish-load', () => { this.crashed = false; });
  }

  status() {
    return {
      documentId: this.documentId,
      url: this.contents.getURL(),
      title: this.contents.getTitle(),
      loading: this.contents.isLoadingMainFrame(),
      crashed: this.crashed,
      versions: { electron: process.versions.electron, chromium: process.versions.chrome },
    };
  }

  diagnostics() {
    return { failureCount: this.failureCount, recentNetworkFailures: this.networkFailures, lastInput: this.lastInput,
      guardedFrames: this.contents.mainFrame.framesInSubtree.map((frame) => ({ main: frame === this.contents.mainFrame, guarded: this.guardedFrames.has(frame.frameToken) })) };
  }

  guardFrame(sender, frame, type, token) {
    if (sender !== this.contents) return false;
    if (type === 'ready') { this.guardedFrames.add(frame.frameToken); return false; }
    const operation = this.inputOperation;
    const current = operation && operation.documentId === this.documentId &&
      !this.contents.isLoadingMainFrame() && Date.now() < operation.deadlineAt;
    if (type === 'context') return Boolean(current && frame === this.contents.mainFrame && token === operation.token);
    if (!operation) return false;
    const relevant = operation.action === 'fill' ? type === 'beforeinput'
      : operation.action === 'press' ? ['keydown', 'keyup'].includes(type)
        : ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].includes(type);
    if (relevant && operation.diagnostic.events.length < 16) operation.diagnostic.events.push({ type, mainFrame: frame === this.contents.mainFrame });
    if (frame === this.contents.mainFrame) {
      if (relevant && (!current || token !== operation.token)) {
        operation.completeFrameInput({ blocked: true });
        return true;
      }
      if (type === 'tab-accepted' && operation.key === 'Tab') operation.tabAccepted = true;
      return false;
    }
    if (type === 'keyup' && operation.tabAccepted && current) {
      operation.completeFrameInput({ blocked: false });
      return false;
    }
    if (relevant) operation.completeFrameInput({ blocked: true });
    return relevant;
  }

  assertDocument(id) {
    if (this.crashed || this.contents.isDestroyed()) throw new RelayError('browser_unavailable', 'Browser renderer is unavailable.');
    if (id !== this.documentId) throw new RelayError('stale_document', 'Document changed. Inspect the current document before another action.');
    if (this.contents.isLoadingMainFrame()) throw new RelayError('document_loading', 'Document is still loading.');
  }

  assertActive(signal) {
    if (signal?.aborted) throw new RelayError('command_timeout', 'Command deadline expired; no further input will be dispatched.', 504);
  }

  async dom(command, documentId, signal) {
    this.assertActive(signal);
    this.assertDocument(documentId);
    const result = await this.contents.executeJavaScriptInIsolatedWorld(999, [
      { code: `(${inspectDOM.toString()})(${JSON.stringify(command)})` },
    ]);
    this.assertActive(signal);
    this.assertDocument(documentId);
    if (result.error) throw new RelayError(result.error.code, result.error.message);
    return result;
  }

  async snapshot() {
    const documentId = this.documentId;
    return { documentId, ...await this.dom({ action: 'snapshot' }, documentId) };
  }

  async effort(input, documentId, signal) {
    this.assertActive(signal);
    this.assertDocument(documentId);
    const result = await this.contents.executeJavaScriptInIsolatedWorld(999, [
      { code: `(${inspectEffort.toString()})(${JSON.stringify(input)})` },
    ]);
    this.assertActive(signal);
    this.assertDocument(documentId);
    if (result.error) throw new RelayError(result.error.code, result.error.message);
    return result;
  }

  async releaseEffort(token) {
    if (this.contents.isDestroyed()) return;
    await this.contents.executeJavaScriptInIsolatedWorld(999, [
      { code: `(${inspectEffort.toString()})(${JSON.stringify({ action: 'release', token })})` },
    ]);
  }

  async reviewSnapshot(signal) {
    this.assertActive(signal);
    const result = await this.contents.executeJavaScriptInIsolatedWorld(999, [
      { code: `(${inspectChatGPT.toString()})({}, (${inspectDOM.toString()}))` },
    ]);
    this.assertActive(signal);
    return result;
  }

  async scrollHistory(direction, url, documentId, signal, anchorId) {
    this.assertActive(signal);
    this.assertDocument(documentId);
    const token = randomUUID();
    let cancellation;
    const abort = () => {
      cancellation = this.contents.executeJavaScriptInIsolatedWorld(999, [
        { code: `(${inspectChatGPT.toString()})(${JSON.stringify({ action: 'cancel-wait', token })}, (${inspectDOM.toString()}))` },
      ]).then(() => null, error => error);
    };
    signal?.addEventListener('abort', abort, { once: true });
    let result;
    try {
      this.window.focus();
      this.contents.focus();
      result = await this.contents.executeJavaScriptInIsolatedWorld(999, [
        { code: `(${inspectChatGPT.toString()})(${JSON.stringify({ action: 'scroll-history', direction, url, anchorId, token })}, (${inspectDOM.toString()}))` },
      ]);
    } finally {
      signal?.removeEventListener('abort', abort);
      const cancellationError = await cancellation;
      if (cancellationError) throw cancellationError;
    }
    this.assertActive(signal);
    this.assertDocument(documentId);
    if (result.problem) throw new RelayError(result.problem.code, result.problem.message);
    return result;
  }

  async reviewView(signal, requiredIds = null, deadlineAt = Date.now() + 30000) {
    let view = await this.reviewSnapshot(signal);
    let messages = view.messages;
    const missing = () => requiredIds !== null && requiredIds.some(id => !messages.some(message => message.id === id));
    if (!view.problem && missing() && view.historyScrollable === false) {
      throw new RelayError('conversation_changed', 'Recorded conversation messages are absent and no identified history container is available.');
    }
    const merge = (page) => {
      if (!page.length) return;
      if (!messages.length) { messages = page; return; }
      const overlap = page.findIndex(message => messages.some(known => known.id === message.id));
      if (overlap < 0) throw new RelayError('conversation_changed', 'Conversation history pages have no shared message identity.');
      const offset = messages.findIndex(message => message.id === page[overlap].id) - overlap;
      const start = Math.min(0, offset), end = Math.max(messages.length, offset + page.length);
      const combined = [];
      for (let index = start; index < end; index++) {
        const known = messages[index], current = page[index - offset];
        if (known && current && known.id !== current.id) throw new RelayError('conversation_changed', 'Conversation message order changed while reading history.');
        combined.push(current || known);
      }
      if (new Set(combined.map(message => message.id)).size !== combined.length) throw new RelayError('conversation_changed', 'Conversation history contains repeated message identities.');
      messages = combined;
    };
    if (!view.problem && (view.messages.length || requiredIds?.length) &&
        (missing() || requiredIds !== null && view.historyScrollable && view.historyAtLatest !== true)) {
      const documentId = this.documentId, url = view.url;
      const latestView = async () => {
        while (true) {
          if (Date.now() >= deadlineAt) throw new RelayError('command_timeout', 'The latest conversation position was not readable before the deadline.', 504);
          await this.scrollHistory('latest', url, documentId, signal);
          const page = await this.reviewSnapshot(signal);
          if (page.url !== url) throw new RelayError('conversation_changed', 'Conversation changed while reading its history.');
          if (page.historyScrollable && page.historyAtLatest === null) throw new RelayError('unsupported_chatgpt_ui', 'Conversation history must have one identified scroll container.');
          if (page.problem || page.historyAtLatest !== false) return page;
        }
      };
      view = await latestView();
      messages = view.messages;
      let readEarlier = false;
      try {
        while (!view.problem && missing()) {
          if (!view.messages.length) {
            await this.waitReviewSnapshot(view, Math.max(0, deadlineAt - Date.now()), signal);
            view = await this.reviewSnapshot(signal);
            if (view.url !== url) throw new RelayError('conversation_changed', 'Conversation changed while reading its history.');
            merge(view.messages);
            continue;
          }
          readEarlier = true;
          const moved = await this.scrollHistory('earlier', url, documentId, signal, view.messages[0].id);
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) throw new RelayError('command_timeout', 'Conversation history was not readable before the command deadline.', 504);
          if (!moved.moved) await this.waitReviewSnapshot(view, remaining, signal);
          const next = await this.reviewSnapshot(signal);
          if (next.url !== url) throw new RelayError('conversation_changed', 'Conversation changed while reading its history.');
          merge(next.messages);
          view = next;
        }
      } finally {
        if (readEarlier && !signal?.aborted && Date.now() < deadlineAt && documentId === this.documentId && this.contents.getURL() === url) {
          view = await latestView();
        }
      }
      view = await this.reviewSnapshot(signal);
      if (readEarlier && !view.problem && !view.busy && view.stableForMs < 600) {
        await this.waitReviewSnapshot(view, 600 - view.stableForMs, signal);
        view = await this.reviewSnapshot(signal);
      }
      merge(view.messages);
    }
    const result = { ...view, messages };
    Object.defineProperty(result, 'inputHistory', { value: JSON.stringify(view.messages) });
    this.reviewSnapshots.set(result, view);
    return result;
  }

  async waitReviewChange(view, timeoutMs, signal) {
    await this.waitReviewSnapshot(this.reviewSnapshots.get(view), timeoutMs, signal);
  }

  async waitReviewSnapshot(view, timeoutMs, signal) {
    this.assertActive(signal);
    const { stableForMs, ...previous } = view;
    const token = randomUUID();
    let cancellation;
    const abort = () => {
      cancellation = this.contents.executeJavaScriptInIsolatedWorld(999, [
        { code: `(${inspectChatGPT.toString()})(${JSON.stringify({ action: 'cancel-wait', token })}, (${inspectDOM.toString()}))` },
      ]).then(() => null, error => error);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.contents.executeJavaScriptInIsolatedWorld(999, [
        { code: `(${inspectChatGPT.toString()})(${JSON.stringify({ action: 'wait', token, previous: JSON.stringify(previous), timeoutMs })}, (${inspectDOM.toString()}))` },
      ]);
    } finally {
      signal?.removeEventListener('abort', abort);
      const cancellationError = await cancellation;
      if (cancellationError) throw cancellationError;
    }
    this.assertActive(signal);
  }

  async execute(command, signal, deadlineAt, beforeDispatch) {
    this.assertActive(signal);
    if (command.action === 'navigate') {
      try { await this.contents.loadURL(command.url); }
      catch (error) { throw new RelayError('navigation_failed', error.message); }
      if (this.contents.isLoadingMainFrame()) await once(this.contents, 'did-stop-loading', { signal });
      this.assertActive(signal);
      return this.status();
    }
    if (command.action === 'screenshot') {
      const image = await this.contents.capturePage();
      return { ...this.status(), mimeType: 'image/png', base64: image.toPNG().toString('base64') };
    }
    const { documentId } = command;
    const token = randomUUID();
    const inputCommand = ['fill', 'click', 'press'].includes(command.action);
    const waitCommand = command.action === 'wait';
    let cancellation;
    const cancelOperation = () => {
      if (cancellation === undefined && !this.contents.isDestroyed()) {
        cancellation = this.contents.executeJavaScriptInIsolatedWorld(999, [
          { code: waitCommand ? `(${inspectDOM.toString()})(${JSON.stringify({ action: 'cancel-wait', token })})`
            : `globalThis.chatgptRelayInput.cancel(${JSON.stringify(token)})` },
        ]).then(() => null, error => error);
      }
      return cancellation;
    };
    let frameDelivery;
    let diagnostic;
    if (inputCommand) {
      diagnostic = { action: command.action, documentId, startedAt: new Date().toISOString(), stage: 'preparing', state: 'running', native: [], events: [] };
      this.lastInput = diagnostic;
      frameDelivery = new Promise((resolve) => {
        this.inputOperation = { action: command.action, key: command.key, documentId, token, deadlineAt, diagnostic, completeFrameInput: resolve, tabAccepted: false };
      });
    }
    try {
      if (waitCommand) signal?.addEventListener('abort', cancelOperation, { once: true });
      const prepared = await this.dom({ ...command, token, deadlineAt, documentURL: this.contents.getURL() }, documentId, signal);
      if (command.action === 'fill') {
        diagnostic.state = 'completed';
        return { documentId, characters: command.text.length };
      }
      if (!inputCommand) return { documentId, ...prepared };
      this.assertActive(signal);
      this.assertDocument(documentId);
      this.window.focus();
      this.contents.focus();
      if (beforeDispatch) beforeDispatch();
      diagnostic.stage = 'dispatching';
      if (command.action === 'click') {
        const point = { x: Math.round(prepared.x), y: Math.round(prepared.y), button: 'left', clickCount: 1 };
        await this.dispatchInput('Input.dispatchMouseEvent', [
          { type: 'mousePressed', ...point, buttons: 1 },
          { type: 'mouseReleased', ...point, buttons: 0 },
        ]);
      } else {
        const key = { key: command.key, code: command.key, windowsVirtualKeyCode: { Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowRight: 39 }[command.key] };
        await this.dispatchInput('Input.dispatchKeyEvent', [
          { type: 'keyDown', ...key }, { type: 'keyUp', ...key },
        ]);
      }
      this.assertActive(signal);
      diagnostic.stage = 'waiting_receipt';
      signal?.addEventListener('abort', cancelOperation, { once: true });
      const receipt = this.contents.executeJavaScriptInIsolatedWorld(999, [
        { code: `globalThis.chatgptRelayInput.finish(${JSON.stringify(token)})` },
      ]);
      const delivery = await Promise.race([receipt, frameDelivery]);
      this.assertActive(signal);
      if (delivery.blocked) throw new RelayError('target_changed', 'Input target changed before delivery; the mismatched input event was blocked.');
      diagnostic.state = 'completed';
      return { documentId, dispatched: true };
    } catch (error) {
      if (diagnostic) { diagnostic.state = 'failed'; diagnostic.error = error.code || 'input_failed'; }
      throw error;
    } finally {
      try {
        signal?.removeEventListener('abort', cancelOperation);
        if (inputCommand || waitCommand) {
          const cancellationError = await cancelOperation();
          if (cancellationError) throw cancellationError;
        }
      } finally {
        if (inputCommand) this.inputOperation = null;
      }
    }
  }

  async dispatchInput(method, events) {
    const outcomes = await Promise.allSettled(events.map(async (event) => {
      const delivery = { type: event.type, state: 'pending' };
      this.inputOperation.diagnostic.native.push(delivery);
      try { await this.contents.debugger.sendCommand(method, event); delivery.state = 'acknowledged'; }
      catch (error) { delivery.state = 'failed'; throw error; }
    }));
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed) throw new RelayError('input_delivery_unknown', `Browser input acknowledgment failed: ${failed.reason.message}`);
  }
}
