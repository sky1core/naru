import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function mainFixture(profile, mainURL, serverURL, scenario) {
  const { mock } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');
  const { EventEmitter } = await import('node:events');
  const moduleOptions = exports => Number(process.versions.node.split('.')[0]) >= 26
    ? { exports } : { namedExports: exports };
  const ready = Promise.withResolvers();
  const dialogs = [], exits = [], paths = new Map();
  let dialogResponse = 1;
  const secretURL = 'https://site.invalid/?token=private-query-marker#private-fragment-marker';
  const failure = Object.assign(new Error(`ERR_CONNECTION_REFUSED (-102) loading '${secretURL}'`),
    { code: 'ERR_CONNECTION_REFUSED', errno: -102, url: secretURL });
  const app = new EventEmitter();
  Object.assign(app, {
    setName() {}, setPath(key, value) { paths.set(key, value); },
    getPath(key) { assert.equal(key, 'appData'); return profile + '/app-data'; },
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    exit(code) { exits.push(code); ready.resolve(false); },
    quit() { app.emit('will-quit'); },
  });
  let window, checkHandler, requestHandler, serverClosed = false, serverOptions;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      if (scenario === 'startup-error') throw failure;
      this.options = options;
      window = this;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        debugger: { attach() {} },
        isDestroyed: () => false,
        setWindowOpenHandler(handler) { this.openHandler = handler; },
        session: {
          webRequest: { onErrorOccurred() {}, onCompleted() {} },
          setPermissionCheckHandler(handler) { checkHandler = handler; },
          setPermissionRequestHandler(handler) { requestHandler = handler; },
        },
      });
    }
    static fromWebContents(contents) { return contents === window.webContents ? window : null; }
    isDestroyed() { return false; }
    async loadURL(url) { assert.equal(url, secretURL); throw failure; }
  }
  mock.module('electron', moduleOptions({ app, BrowserWindow,
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} },
    ipcMain: new EventEmitter(),
    dialog: { async showMessageBox(owner, options) {
      assert.equal(owner, window);
      dialogs.push(options);
      return { response: dialogResponse };
    } },
  }));
  mock.module(serverURL, moduleOptions({ async startServer(options) {
    serverOptions = options;
    return { server: { close() { serverClosed = true; } }, descriptor: { origin: 'http://127.0.0.1:1', token: 'fixture-token' } };
  } }));
  const log = console.log;
  console.log = (...args) => {
    log(...args);
    if (typeof args[0] === 'string' && args[0].startsWith('{') && JSON.parse(args[0]).event === 'ready') ready.resolve(true);
  };
  process.argv = [process.execPath, 'main.mjs', '--profile', profile, '--url', secretURL];
  await import(mainURL);
  const started = await ready.promise;
  if (scenario === 'startup-error') {
    assert.equal(started, false);
    assert.deepEqual(exits, [1]);
    return;
  }
  assert.equal(started, true);
  assert.equal(paths.get('userData'), profile);
  assert.equal(paths.get('sessionData'), profile + '/chromium');
  assert.equal(window.options.webPreferences.preload.endsWith('/input-guard.cjs'), true);
  assert.equal(serverOptions.browser.window, window);
  assert.equal(serverOptions.profile, profile);
  const request = async (permission, details, origin = 'https://site.invalid/') => {
    const answers = [];
    await requestHandler(window.webContents, permission, allowed => answers.push(allowed),
      { requestingUrl: origin, ...details });
    assert.equal(answers.length, 1);
    return answers[0];
  };
  const check = (permission, details, origin = 'https://site.invalid/') =>
    checkHandler(window.webContents, permission, origin, details);
  if (scenario === 'media') {
    assert.equal(await request('media', { mediaTypes: ['audio'] }), true);
    assert.equal(check('media', { mediaType: 'audio' }), true);
    assert.equal(check('media', { mediaType: 'video' }), false);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].detail, /마이크/);
    assert.doesNotMatch(dialogs[0].detail, /카메라/);
    assert.equal(await request('media', { mediaTypes: ['video'] }), true);
    assert.equal(dialogs.length, 2);
    assert.match(dialogs[1].detail, /카메라/);
    assert.equal(check('media', { mediaType: 'video' }), true);
    assert.equal(await request('media', { mediaTypes: ['audio', 'video'] }, 'https://combined.invalid/'), true);
    assert.equal(dialogs.length, 3);
    assert.match(dialogs[2].detail, /마이크/);
    assert.match(dialogs[2].detail, /카메라/);
    for (const mediaType of ['audio', 'video']) {
      assert.equal(check('media', { mediaType }, 'https://combined.invalid/'), true);
    }
    dialogResponse = 0;
    assert.equal(await request('media', { mediaTypes: ['video'] }, 'https://denied.invalid/'), false);
    assert.equal(check('media', { mediaType: 'video' }, 'https://denied.invalid/'), false);
    const prompts = dialogs.length;
    assert.equal(await request('media', { mediaTypes: ['video'] }, 'https://denied.invalid/'), false);
    assert.equal(dialogs.length, prompts);
    dialogResponse = 1;
    assert.equal(await request('media', { mediaTypes: ['audio'] }, 'https://denied.invalid/'), true);
    assert.equal(check('media', { mediaType: 'audio' }, 'https://denied.invalid/'), true);
    assert.equal(check('media', { mediaType: 'video' }, 'https://denied.invalid/'), false);
  } else if (scenario === 'files') {
    const scope = { filePath: '/tmp/permission-path-marker', fileAccessType: 'readable', isDirectory: false };
    assert.equal(await request('fileSystem', scope), true);
    assert.equal(check('fileSystem', scope), true);
    assert.match(dialogs[0].detail, /\/tmp\/permission-path-marker/);
    assert.match(dialogs[0].detail, /파일/);
    assert.match(dialogs[0].detail, /읽기/);
    assert.doesNotMatch(dialogs[0].detail, /디렉터리|쓰기/);
    for (const changed of [
      { ...scope, filePath: '/tmp/other-path-marker' },
      { ...scope, fileAccessType: 'writable' },
      { ...scope, isDirectory: true },
    ]) assert.equal(check('fileSystem', changed), false);
    const other = { filePath: '/tmp/other-path-marker', fileAccessType: 'writable', isDirectory: true };
    assert.equal(await request('fileSystem', other), true);
    assert.equal(dialogs.length, 2);
    assert.match(dialogs[1].detail, /\/tmp\/other-path-marker/);
    assert.match(dialogs[1].detail, /디렉터리/);
    assert.match(dialogs[1].detail, /쓰기/);
    assert.equal(check('fileSystem', other), true);
  } else if (scenario === 'missing') {
    assert.equal(await request('media', { mediaTypes: ['audio'] }), true);
    for (const scope of [undefined, {}, { mediaType: 'unknown' }, { mediaType: 'video' }]) {
      assert.equal(check('media', scope), false);
    }
    for (const details of [undefined, {}, { mediaTypes: [] }, { mediaTypes: ['audio', 'unknown'] }]) {
      assert.equal(await request('media', details), false);
    }
    const file = { filePath: '/tmp/permission-path-marker', fileAccessType: 'readable', isDirectory: false };
    assert.equal(await request('fileSystem', file), true);
    for (const key of Object.keys(file)) {
      const details = { ...file, [key]: undefined };
      assert.equal(check('fileSystem', details), false);
      assert.equal(await request('fileSystem', details), false);
    }
    assert.equal(dialogs.length, 2);
    assert.equal(await request('persistent-storage', {}, 'https://chatgpt.com/'), true);
    assert.equal(check('persistent-storage', {}, 'https://chatgpt.com/'), true);
    assert.equal(dialogs.length, 2);
    assert.equal(await request('notifications', {}), true);
    assert.equal(dialogs.length, 3);
    assert.equal(check('notifications', {}), true);
    assert.equal(await request('notifications', {}, 'file:///tmp/page'), false);
    assert.equal(dialogs.length, 3);
  } else if (scenario === 'errors') {
    process.emit('uncaughtException', failure);
    process.emit('unhandledRejection', failure);
    process.emit('unhandledRejection', Object.assign(new Error(secretURL), { code: secretURL, errno: secretURL }));
    assert.deepEqual(exits, [1, 1, 1]);
  }
  app.quit();
  assert.equal(serverClosed, true);
}

function runMain(scenario) {
  const profile = mkdtempSync(join(tmpdir(), 'naru-permission-details-'));
  const script = `await (${mainFixture.toString()})(${JSON.stringify(profile)}, ${JSON.stringify(new URL('../src/main.mjs', import.meta.url).href)}, ${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)}, ${JSON.stringify(scenario)}); console.log('main_fixture_complete');`;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^main_fixture_complete$/m, result.stderr);
  return result;
}

for (const scenario of ['media', 'files', 'missing']) {
  test(`main permission handlers preserve ${scenario} scope and approval details`, () => {
    const { stderr } = runMain(scenario);
    assert.doesNotMatch(stderr, /permission-path-marker|other-path-marker/);
  });
}

for (const scenario of ['errors', 'startup-error']) {
  test(`main ${scenario} reporting excludes external error messages and URLs`, () => {
    const { stderr } = runMain(scenario);
    assert.doesNotMatch(stderr, /private-query-marker|private-fragment-marker/);
    const records = stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert(records.length > 0);
    for (const record of records) {
      assert.equal(record.code === undefined || record.code === 'ERR_CONNECTION_REFUSED', true);
      assert.equal(record.errno === undefined || record.errno === -102, true);
      assert.equal(Object.hasOwn(record, 'url'), false);
    }
    if (scenario === 'errors') {
      assert.deepEqual(records.find(record => record.event === 'initial_navigation_failed'), {
        event: 'initial_navigation_failed', message: 'Initial navigation failed.', code: 'ERR_CONNECTION_REFUSED', errno: -102,
      });
      for (const event of ['uncaught_exception', 'unhandled_rejection']) assert(records.some(record => record.event === event));
    }
  });
}
