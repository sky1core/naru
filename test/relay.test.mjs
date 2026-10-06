import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWriteStream } from 'node:fs';
import electron from 'electron';
import { connect } from '../src/client.mjs';
import { Journal } from '../src/journal.mjs';

const exec = promisify(execFile);
const fixture = `<!doctype html><meta charset="utf-8"><title>Relay integration fixture</title>
<style>body{font:20px system-ui;max-width:820px;margin:50px auto;background:#f4f6f8}textarea{display:block;width:90%;height:150px}button{margin:20px 0;padding:15px}pre{white-space:pre-wrap}#cover{position:fixed;inset:0;z-index:99;background:white}</style>
<h1>ChatGPT Relay · 실제 Chromium 검증</h1>
<textarea id="composer"></textarea><button data-testid="send-button">라벨은 식별자로 쓰지 않습니다</button>
<div data-testid="duplicate"></div><div data-testid="duplicate"></div>
<input id="readonly" readonly><pre id="result"></pre><pre id="security"></pre>
<button id="cover-button">Overlay</button><div id="editable" contenteditable="true" style="min-height:1em;white-space:pre-wrap">old</div>
<div id="plain-editable" contenteditable="true" style="min-height:1em">old</div>
<textarea id="redirect">unchanged</textarea><textarea id="other"></textarea>
<button id="animate">Animate</button><div id="animated" style="visibility:hidden">Visible later</div>
<style>@keyframes reveal{to{visibility:visible}}</style>
<textarea id="slow-focus"></textarea>
<textarea id="tab-from"></textarea><textarea id="tab-to"></textarea><pre id="tab-result"></pre>
<div id="hidden-editable" contenteditable="true">A<span hidden>X</span><span style="display:none">Y</span>B</div>
<div id="visible-child" contenteditable="true">A<span style="visibility:hidden">X<span style="visibility:visible">Y</span></span>B</div>
<textarea id="frame-redirect">unchanged</textarea><textarea id="tab-into-frame"></textarea><iframe id="child-frame"></iframe><pre id="frame-result"></pre>
<button id="cross-frame">Cross-origin frame</button><pre id="input-trust">false</pre>
<button id="moving-target">Moving target</button><pre id="pointer-result">0</pre>
<script>
const result = document.getElementById('result');
document.getElementById('security').innerText = typeof process + ':' + typeof require;
result.innerText = localStorage.getItem('result') || '';
function send(event) {
  const count = Number(localStorage.getItem('count') || '0') + 1;
  localStorage.setItem('count', count);
  result.innerText = JSON.stringify({ text: document.getElementById('composer').value, count, trusted: event.isTrusted });
  localStorage.setItem('result', result.innerText);
  const marker = document.createElement('div'); marker.id = 'delivered'; document.body.append(marker);
  marker.innerText = 'Complete';
}
document.querySelector('[data-testid="send-button"]').onclick = send;
document.getElementById('composer').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); send(event); } };
document.getElementById('composer').oninput = event => { document.getElementById('input-trust').innerText=String(event.isTrusted); };
document.getElementById('cover-button').onclick = () => { const cover = document.createElement('div'); cover.id = 'cover'; document.body.append(cover); };
document.getElementById('redirect').onfocus = () => queueMicrotask(() => document.getElementById('other').focus());
document.getElementById('other').onkeydown = event => { if(event.key === 'Enter') document.getElementById('other').value = 'WRONG ENTER'; };
document.getElementById('animate').onclick = () => { document.getElementById('animated').style.animation = 'reveal 350ms step-end forwards'; };
document.getElementById('slow-focus').onfocus = () => { const until = performance.now() + 700; while(performance.now() < until) {} };
navigator.permissions.query({name:'notifications'}).then(permission => { const marker = document.createElement('pre'); marker.id = 'permission'; marker.innerText = permission.state; document.body.append(marker); });
document.getElementById('tab-to').onfocus = () => { document.getElementById('tab-result').innerText = 'focused'; };
document.getElementById('child-frame').src = '/frame';
window.addEventListener('message', event => { if(event.source === document.getElementById('child-frame').contentWindow) { if(event.data.autofocused){if(!document.getElementById('frame-focused')){const marker=document.createElement('div');marker.id='frame-focused';marker.innerText='focused';document.body.append(marker)}return} document.getElementById('frame-result').innerText = JSON.stringify(event.data); if(new URL(event.origin).hostname === 'localhost' && !document.getElementById('cross-ready')) { const marker=document.createElement('div'); marker.id='cross-ready'; marker.innerText='loaded'; document.body.append(marker); } } });
document.getElementById('cross-frame').onclick=()=>{ document.getElementById('child-frame').src=location.protocol+'//localhost:'+location.port+'/frame'; };
document.getElementById('frame-redirect').onfocus = () => queueMicrotask(() => document.getElementById('child-frame').focus());
const moving = document.getElementById('moving-target');
moving.onpointerdown = () => { const rect = moving.getBoundingClientRect(); const cover=document.createElement('div'); cover.id='pointer-cover'; cover.style.cssText='position:fixed;z-index:99;left:'+rect.left+'px;top:'+rect.top+'px;width:'+rect.width+'px;height:'+rect.height+'px'; cover.onpointerup=()=>{ document.getElementById('pointer-result').innerText='WRONG'; }; document.body.append(cover); };
</script>`;

async function launch(profile, url, evidence, entry = '.') {
  const child = spawn(electron, [entry, '--profile', profile, '--url', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  const log = createWriteStream(join(evidence, `electron-${child.pid}.log`));
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const closed = once(child, 'close');
  closed.then(() => log.end());
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Electron startup timeout\n${output}\n${errors}`));
    }, 45000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.split('\n').some((line) => line.startsWith('{"event":"ready"'))) { clearTimeout(timer); resolveReady(); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); reject(new Error(`Electron exited ${code}\n${errors}`)); });
  });
  const call = await connect(profile);
  return { call, async stop() {
    await call('/v1/commands', { id: randomUUID(), command: { action: 'quit' } });
    const timer = setTimeout(() => { throw new Error('Application failed to quit'); }, 10000);
    await closed;
    clearTimeout(timer);
    await writeFile(join(evidence, `electron-${child.pid}.log`), output + errors);
  } };
}

test('an expired DOM wait releases the command lock without waiting for its condition timeout', { timeout: 30000 }, async t => {
  await mkdir('artifacts/test-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/test-runs/wait-cancel-'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<div id="ready">ready</div>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let running;
  t.after(async () => {
    try { if (running) await running.stop(); }
    finally { await new Promise(resolveClose => server.close(resolveClose)); }
  });
  running = await launch(join(evidence, 'profile'), `http://127.0.0.1:${server.address().port}/`, evidence);
  const call = running.call;
  const documentId = (await call('/v1/status')).documentId;
  const id = randomUUID();
  await assert.rejects(call('/v1/commands', { id, deadlineMs: 100, command: {
    action: 'wait', documentId, target: { attribute: 'id', value: 'never-created' }, state: 'present', timeoutMs: 120000,
  } }), { code: 'command_timeout' });
  assert.equal((await call('/v1/snapshot')).documentId, documentId);
  assert.equal((await call('/v1/status')).execution, null);
  const read = await call('/v1/commands', { id: randomUUID(), command: {
    action: 'read', documentId, target: { attribute: 'id', value: 'ready' },
  } });
  assert.equal(read.result.text, 'ready');
  await assert.rejects(call(`/v1/requests/${id}`), { code: 'command_timeout' });
});

test('invalid UTF-8 in CLI fill and public JSON requests is rejected without changing the editor', { timeout: 30000 }, async t => {
  await mkdir('artifacts/test-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/test-runs/utf8-'));
  const profile = join(evidence, 'profile');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<textarea id="editor">original</textarea>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let running;
  t.after(async () => {
    try { if (running) await running.stop(); }
    finally { await new Promise(resolveClose => server.close(resolveClose)); }
  });
  running = await launch(profile, `http://127.0.0.1:${server.address().port}/`, evidence);
  const call = running.call;
  const documentId = (await call('/v1/status')).documentId;
  const target = { attribute: 'id', value: 'editor' };
  await t.test('CLI file bytes', async () => {
    const path = join(evidence, 'malformed.txt');
    await writeFile(path, Buffer.from([0xc3, 0x28]));
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'fill', '--document', documentId,
      '--attr', 'id', '--value', 'editor', '--file', path]), error => /invalid_utf8/.test(error.stderr));
    assert.equal((await call('/v1/commands', { id: randomUUID(), command: { action: 'read', documentId, target } })).result.text, 'original');
  });
  await t.test('CLI JSON command bytes', async () => {
    const id = randomUUID();
    const serialized = JSON.stringify({ id, command: { action: 'fill', documentId, target, text: 'PLACEHOLDER' } });
    const at = serialized.indexOf('PLACEHOLDER');
    const path = join(evidence, 'invalid-command.json');
    await writeFile(path, Buffer.concat([Buffer.from(serialized.slice(0, at)), Buffer.from([0xc3, 0x28]), Buffer.from(serialized.slice(at + 11))]));
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'run', '--file', path]), error => /invalid_utf8/.test(error.stderr));
    await assert.rejects(call(`/v1/requests/${id}`), { code: 'request_missing' });
    assert.equal((await call('/v1/commands', { id: randomUUID(), command: { action: 'read', documentId, target } })).result.text, 'original');
  });
  await t.test('prepared review JSON bytes', async () => {
    const reviewId = randomUUID();
    const serialized = JSON.stringify({ action: 'review.prepare', reviewId, question: 'PLACEHOLDER', files: [] });
    const at = serialized.indexOf('PLACEHOLDER');
    const path = join(evidence, 'invalid-review.json');
    const out = join(evidence, 'invalid-review.txt');
    await writeFile(path, Buffer.concat([Buffer.from(serialized.slice(0, at)), Buffer.from([0xc3, 0x28]), Buffer.from(serialized.slice(at + 11))]));
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--request', path, '--out', out]), error => /invalid_utf8/.test(error.stderr));
    await assert.rejects(call(`/v1/reviews/${reviewId}`), { code: 'review_missing' });
    await assert.rejects(stat(out + '.request.json'), { code: 'ENOENT' });
  });
  await t.test('HTTP JSON bytes', async () => {
    await call('/v1/commands', { id: randomUUID(), command: { action: 'fill', documentId, target, text: 'original' } });
    const descriptor = JSON.parse(await readFile(join(profile, 'connection.json'), 'utf8'));
    const id = randomUUID();
    const serialized = JSON.stringify({ id, command: { action: 'fill', documentId, target, text: 'PLACEHOLDER' } });
    const index = serialized.indexOf('PLACEHOLDER');
    const body = Buffer.concat([Buffer.from(serialized.slice(0, index)), Buffer.from([0xc3, 0x28]), Buffer.from(serialized.slice(index + 11))]);
    const response = await fetch(descriptor.origin + '/v1/commands', { method: 'POST', headers: {
      Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json',
    }, body });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_json');
    await assert.rejects(call(`/v1/requests/${id}`), { code: 'request_missing' });
    assert.equal((await call('/v1/commands', { id: randomUUID(), command: { action: 'read', documentId, target } })).result.text, 'original');
  });
});

test('real Electron, API, CLI, persistent profile, and safe failure contracts', { timeout: 120000 }, async (t) => {
  await mkdir('artifacts/test-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/test-runs/run-'));
  const profile = join(evidence, 'profile');
  const server = createServer((request, response) => {
    if (request.url === '/frame') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end(`<textarea id="child" autofocus></textarea><script>const child=document.getElementById('child');let key='';function report(){parent.postMessage({text:child.value,key,security:typeof process+':'+typeof require+':'+typeof chatgptRelayInput},'*')}child.onfocus=()=>parent.postMessage({autofocused:true},'*');child.oninput=report;child.onkeydown=e=>{if(e.key==='Enter')key='WRONG';report()};window.onload=report;</script>`);
    }
    if (request.url.startsWith('/failure')) {
      response.writeHead(503, { 'Content-Type': 'text/plain' });
      return response.end('Deliberate test outage');
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixture);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/`;
  let running;
  t.after(async () => { if (running) await running.stop(); await new Promise((resolve) => server.close(resolve)); });
  running = await launch(profile, url, evidence);
  let call = running.call;
  const snapshot = await call('/v1/snapshot');
  let documentId = snapshot.documentId;
  const target = (value, attribute = 'id') => ({ attribute, value });
  const run = async (command, id = randomUUID()) => call('/v1/commands', { id, command });
  const located = (action, value, rest = {}) => ({ action, documentId, target: target(value), ...rest });

  await t.test('DOM snapshot and renderer isolation', async () => {
    assert.equal(snapshot.url, url);
    assert(snapshot.elements.some((element) => element.attributes.id === 'composer'));
    assert.equal((await run(located('read', 'security'))).result.text, 'undefined:undefined');
    assert.equal((await stat(join(profile, 'connection.json'))).mode & 0o777, 0o600);
    const cli = await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'snapshot']);
    assert.equal(JSON.parse(cli.stdout).documentId, documentId);
  });

  await t.test('the same or another profile cannot start a second app or replace the running page', async () => {
    for (const candidate of [join(evidence, 'another-profile'), profile]) {
      let duplicate;
      try {
        await assert.rejects(async () => {
          duplicate = await launch(candidate, `${url}another`, evidence);
        }, /Electron exited 1\n[\s\S]*Naru is already running\./);
        const after = await call('/v1/status');
        assert.equal(after.documentId, documentId);
        assert.equal(after.url, url);
      } finally {
        if (duplicate) await duplicate.stop();
      }
    }
  });

  const sendId = randomUUID();
  const send = located('click', 'send-button', { target: target('send-button', 'data-testid') });
  const prompt = '한글 입력\nexact <>& "🙂"\nno truncation';
  await t.test('CLI fill and trusted click, no text-label locator', async () => {
    const input = join(evidence, 'prompt.txt');
    await writeFile(input, prompt);
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'fill', '--document', documentId, '--attr', 'id', '--value', 'composer', '--file', input]);
    assert.equal((await run(located('read', 'input-trust'))).result.text, 'true');
    await run(send, sendId);
    await run(located('wait', 'delivered', { state: 'present', timeoutMs: 3000 }));
    assert.deepEqual(JSON.parse((await run(located('read', 'result'))).result.text), { text: prompt, count: 1, trusted: true });
    await assert.rejects(run({ action: 'click', documentId, target: { attribute: 'text', value: '라벨은 식별자로 쓰지 않습니다' } }), { code: 'invalid_command' });
  });

  await t.test('duplicate execution, conflicting request, missing/ambiguous/read-only targets', async () => {
    const repeated = await run(send, sendId);
    assert.equal(repeated.id, sendId);
    assert.equal(JSON.parse((await run(located('read', 'result'))).result.text).count, 1);
    await assert.rejects(run(located('click', 'cover-button'), sendId), { code: 'request_conflict' });
    await assert.rejects(run(located('click', 'missing')), { code: 'target_missing' });
    await assert.rejects(run(located('click', 'duplicate', { target: target('duplicate', 'data-testid') })), { code: 'ambiguous_target' });
    await assert.rejects(run(located('fill', 'readonly', { text: 'forbidden' })), { code: 'target_readonly' });
    await assert.rejects(run(located('wait', 'missing', { state: 'present', timeoutMs: 50 })), { code: 'wait_timeout' });
  });

  await t.test('authentication, origin and host checks', async () => {
    const descriptor = JSON.parse(await readFile(join(profile, 'connection.json'), 'utf8'));
    assert.equal((await fetch(`${descriptor.origin}/v1/status`)).status, 401);
    assert.equal((await fetch(`${descriptor.origin}/v1/status`, { headers: { Authorization: `Bearer ${descriptor.token}`, Origin: 'https://example.com' } })).status, 401);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      get(`${descriptor.origin}/v1/status`, { headers: { Authorization: `Bearer ${descriptor.token}`, Host: 'attacker.invalid' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(wrongHostStatus, 401);
    await assert.rejects(run({ action: 'navigate', url: 'file:///etc/passwd' }), { code: 'invalid_command' });
    await assert.rejects(run({ action: 'evaluate', source: 'process.exit()' }), { code: 'invalid_command' });
  });

  await t.test('unapproved browser permissions are not granted', async () => {
    await run(located('wait', 'permission', { state: 'present', timeoutMs: 3000 }));
    assert.notEqual((await run(located('read', 'permission'))).result.text, 'granted');
  });

  await t.test('focus redirection cannot insert into or press Enter on another target', async () => {
    await run(located('fill', 'redirect', { text: 'unchanged' }));
    assert.equal((await run(located('read', 'other'))).result.text, '');
    await assert.rejects(run(located('press', 'redirect', { key: 'Enter' })), { code: 'target_changed' });
    assert.equal((await run(located('read', 'other'))).result.text, '');
  });

  await t.test('sandboxed iframe cannot receive redirected automation input', async () => {
    assert((await call('/v1/diagnostics')).guardedFrames.every(frame => frame.guarded));
    await run(located('fill', 'frame-redirect', { text: 'unchanged' }));
    let frame = JSON.parse((await run(located('read', 'frame-result'))).result.text);
    assert.deepEqual(frame, { text: '', key: '', security: 'undefined:undefined:undefined' });
    await assert.rejects(run(located('press', 'frame-redirect', { key: 'Enter' })), { code: 'target_changed' });
    frame = JSON.parse((await run(located('read', 'frame-result'))).result.text);
    assert.equal(frame.text, '');
    assert.equal(frame.key, '');
    await run(located('click', 'cross-frame'));
    await run(located('wait', 'cross-ready', { state: 'present', timeoutMs: 3000 }));
    await run(located('fill', 'frame-redirect', { text: 'cross-origin-safe' }));
    await assert.rejects(run(located('press', 'frame-redirect', { key: 'Enter' })), { code: 'target_changed' });
    frame = JSON.parse((await run(located('read', 'frame-result'))).result.text);
    assert.deepEqual(frame, { text: '', key: '', security: 'undefined:undefined:undefined' });
  });

  await t.test('Tab follows normal focus movement and hidden editor children are excluded', async () => {
    await run(located('press', 'tab-from', { key: 'Tab' }));
    assert.equal((await run(located('read', 'tab-result'))).result.text, 'focused');
    assert.equal((await run(located('read', 'hidden-editable'))).result.text, 'AB');
    assert.equal((await run(located('read', 'visible-child'))).result.text, 'AYB');
  });

  await t.test('pointer retargeting cannot trigger a different element handler', async () => {
    await assert.rejects(run(located('click', 'moving-target')), { code: 'target_changed' });
    assert.equal((await run(located('read', 'pointer-result'))).result.text, '0');
    await run({ action: 'navigate', url });
    documentId = (await call('/v1/snapshot')).documentId;
  });

  await t.test('wait observes CSS-only visibility changes', async () => {
    await run(located('wait', 'frame-focused', { state: 'present', timeoutMs: 3000 }));
    await run(located('click', 'animate'));
    await run(located('wait', 'animated', { state: 'present', timeoutMs: 1000 }));
  });

  await t.test('main-process deadline prevents late insertion after a renderer stall', async () => {
    const id = randomUUID();
    await assert.rejects(call('/v1/commands', { id, deadlineMs: 100, command: located('fill', 'slow-focus', { text: 'MUST NOT BE INSERTED' }) }), { code: 'command_timeout' });
    assert.deepEqual((await call('/v1/status')).execution, { requestId: id, state: 'timed-out' });
    await assert.rejects(run(located('click', 'cover-button')), { code: 'browser_unresponsive' });
    const after = await call('/v1/snapshot');
    assert.equal(after.documentId, documentId);
    const idleDeadline = Date.now() + 5000;
    while ((await call('/v1/status')).execution !== null) {
      assert(Date.now() < idleDeadline, 'Command lock was not released after renderer recovery');
      await delay(100);
    }
    assert.equal((await run(located('read', 'slow-focus'))).result.text, '');
    await assert.rejects(call(`/v1/requests/${id}`), { code: 'command_timeout' });
  });

  await t.test('contenteditable, screenshot and covered target', async () => {
    await run(located('fill', 'plain-editable', { text: '줄 1\n줄 2\n\n마지막 🙂' }));
    assert.equal((await run(located('read', 'plain-editable'))).result.text, '줄 1\n줄 2\n\n마지막 🙂');
    await run(located('fill', 'editable', { text: '정확한 본문 🙂' }));
    assert.equal((await run(located('read', 'editable'))).result.text, '정확한 본문 🙂');
    await run(located('fill', 'editable', { text: '줄 1\n줄 2\n\n마지막 🙂' }));
    assert.equal((await run(located('read', 'editable'))).result.text, '줄 1\n줄 2\n\n마지막 🙂');
    await run(located('fill', 'editable', { text: '' }));
    await run(located('fill', 'editable', { text: '' }));
    assert.equal((await run(located('read', 'editable'))).result.text, '');
    for (const sample of ['마지막 개행\n', '\n\n', '  indent  value', 'tab\tvalue']) {
      await run(located('fill', 'editable', { text: sample }));
      assert.equal((await run(located('read', 'editable'))).result.text, sample);
    }
    const screenshot = join(evidence, 'browser.png');
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'screenshot', '--out', screenshot]);
    assert.equal((await readFile(screenshot)).subarray(1, 4).toString(), 'PNG');
    await run(located('click', 'cover-button'));
    await run(located('wait', 'cover', { state: 'present', timeoutMs: 3000 }));
    await assert.rejects(run({ ...send, documentId }), { code: 'target_obscured' });
  });

  await t.test('navigation invalidates document ID; trusted Enter works', async () => {
    await run({ action: 'navigate', url });
    await assert.rejects(run(located('fill', 'composer', { text: 'stale' })), { code: 'stale_document' });
    documentId = (await call('/v1/snapshot')).documentId;
    await run(located('fill', 'composer', { text: 'Enter 전송' }));
    await run(located('press', 'composer', { key: 'Enter' }));
    await run(located('wait', 'delivered', { state: 'present', timeoutMs: 3000 }));
    assert.deepEqual(JSON.parse((await run(located('read', 'result'))).result.text), { text: 'Enter 전송', count: 2, trusted: true });
  });

  await t.test('restart retains profile and journal; unfinished command never repeats', async () => {
    await running.stop();
    running = null;
    const uncertainId = randomUUID();
    const journal = new Journal(profile);
    journal.begin(uncertainId, { command: send, deadlineMs: 30000 });
    running = await launch(profile, url, evidence);
    call = running.call;
    documentId = (await call('/v1/snapshot')).documentId;
    assert.equal(JSON.parse((await run(located('read', 'result'))).result.text).count, 2);
    await run(send, sendId);
    assert.equal(JSON.parse((await run(located('read', 'result'))).result.text).count, 2);
    await assert.rejects(run(send, uncertainId), { code: 'outcome_unknown' });
    assert.equal(JSON.parse((await run(located('read', 'result'))).result.text).count, 2);
  });
  await t.test('network diagnostics keep status but redact query secrets', async () => {
    await run({ action: 'navigate', url: `${url}failure?secret=do-not-store` });
    const diagnostics = await call('/v1/diagnostics');
    assert(diagnostics.recentNetworkFailures.some((entry) => entry.statusCode === 503 && entry.url === `${url}failure`));
    assert(!JSON.stringify(diagnostics).includes('do-not-store'));
  });
  await t.test('quit remains available while an expired renderer command is unsettled', async () => {
    await run({ action: 'navigate', url });
    documentId = (await call('/v1/snapshot')).documentId;
    await run(located('press', 'tab-from', { key: 'Escape' }));
    await assert.rejects(call('/v1/commands', { id: randomUUID(), deadlineMs: 100, command: located('fill', 'slow-focus', { text: 'NO LATE INPUT' }) }), { code: 'command_timeout' });
    await running.stop();
    running = null;
  });
  await t.test('Tab into an iframe completes and releases the command lock', async () => {
    running = await launch(profile, url, evidence);
    call = running.call;
    documentId = (await call('/v1/snapshot')).documentId;
    await call('/v1/commands', { id: randomUUID(), deadlineMs: 1000, command: located('press', 'tab-into-frame', { key: 'Tab' }) });
    assert.equal((await call('/v1/status')).execution, null);
    assert.equal((await run(located('read', 'visible-child'))).result.text, 'AYB');
  });
  console.log(`Evidence: ${evidence}`);
});

test('pointer activation can complete without a synthesized click', async () => {
  await mkdir('artifacts/test-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/test-runs/pointer-menu-'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<button id="menu">Menu</button><pre id="opened"></pre><script>menu.onpointerdown=e=>{e.preventDefault();menu.disabled=true;opened.textContent="open"};</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let app;
  try {
    app = await launch(join(evidence, 'profile'), `http://127.0.0.1:${server.address().port}/`, evidence);
    const { documentId } = await app.call('/v1/status');
    const result = await app.call('/v1/commands', { id: randomUUID(), deadlineMs: 1500,
      command: { action: 'click', documentId, target: { attribute: 'id', value: 'menu' } } });
    assert.equal(result.result.dispatched, true);
    const opened = await app.call('/v1/commands', { id: randomUUID(), command: { action: 'read', documentId, target: { attribute: 'id', value: 'opened' } } });
    assert.equal(opened.result.text, 'open');
  } finally {
    if (app) await app.stop();
    await new Promise(done => server.close(done));
  }
});

test('background input and review collection keep another window focused', { timeout: 20000 }, async () => {
  await mkdir('artifacts/test-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/test-runs/background-'));
  const profile = join(evidence, 'profile');
  const focusPath = join(evidence, 'focus.json');
  const projectId = 'g-p-0123456789abcdef0123456789abcdef';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><div data-app-action-sidebar-project-id="${projectId}"></div>
<form><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></form>
<button id="rewind">Earlier</button><pre id="key"></pre><pre id="sent-trust"></pre><div id="history" data-app-action-timeline-scroll style="height:100px;overflow:auto"><div style="height:600px"></div><div id="messages"></div></div>
<script>
const editor=document.getElementById('prompt-textarea'),scroller=document.getElementById('history');
scroller.scrollTop=scroller.scrollHeight;
editor.onkeydown=e=>document.getElementById('key').textContent=e.key+':'+e.isTrusted;
document.getElementById('rewind').onclick=()=>{scroller.scrollTop=0};
document.querySelector('form').onsubmit=e=>{
 e.preventDefault();document.getElementById('sent-trust').textContent=String(e.isTrusted);const prompt=editor.value;editor.value='';const id=prompt.match(/Review request UUID: ([a-f0-9-]+)/)[1];
 history.replaceState(null,'','/g/${projectId}/c/'+id);
 for(const [role,text] of [['user',prompt],['assistant','answer\\nEND-OF-REVIEW:'+id]]){
  const section=document.createElement('section'),body=document.createElement('div');
  section.dataset.testid='conversation-turn-'+role;body.dataset.messageId=role+'-'+id;body.dataset.messageAuthorRole=role;body.style.whiteSpace='pre-wrap';body.textContent=text;section.append(body);
  if(role==='assistant'){const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='Copy';section.append(copy)}
  document.getElementById('messages').append(section);
 }
 scroller.scrollTop=scroller.scrollHeight;
};
</script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const entry = join(evidence, 'background.mjs');
  await writeFile(entry, `import { app, BrowserWindow } from 'electron';
import { writeFileSync, renameSync } from 'node:fs';
app.once('browser-window-created', (_event, primary) => {
  let other, focuses = 0;
  const record = () => {
    writeFileSync(${JSON.stringify(focusPath + '.tmp')}, JSON.stringify({ focuses, otherFocused: other !== undefined && !other.isDestroyed() && other.isFocused(), primaryFocused: !primary.isDestroyed() && primary.isFocused() }));
    renameSync(${JSON.stringify(focusPath + '.tmp')}, ${JSON.stringify(focusPath)});
  };
  primary.on('focus', () => { focuses++; record(); });
  primary.on('blur', record);
  primary.once('ready-to-show', async () => {
    other = new BrowserWindow({ show: false, width: 1300, height: 1000 });
    other.on('focus', record);
    other.on('blur', record);
    await other.loadURL('data:text/html,<textarea autofocus>Other work</textarea>');
    other.show(); other.focus();
  });
});
await import(${JSON.stringify(new URL('../src/main.mjs', import.meta.url).href)});
`);
  let running;
  try {
    const url = `http://127.0.0.1:${server.address().port}/g/${projectId}/project`;
    running = await launch(profile, url, evidence, entry);
    let focus;
    const deadline = Date.now() + 5000;
    do {
      try { focus = JSON.parse(await readFile(focusPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (focus?.otherFocused && !focus.primaryFocused) break;
      await delay(20);
    } while (Date.now() < deadline);
    assert.equal(focus?.otherFocused, true);
    assert.equal(focus.primaryFocused, false);
    let duplicate;
    try {
      await assert.rejects(async () => { duplicate = await launch(profile, url, evidence); }, /Electron exited 1\n[\s\S]*Naru is already running\./);
    } finally { if (duplicate) await duplicate.stop(); }
    const run = async command => (await running.call('/v1/commands', { id: randomUUID(), deadlineMs: 5000, command })).result;
    const current = async (action, value, extra = {}) => run({ action, documentId: (await running.call('/v1/status')).documentId, target: { attribute: 'id', value }, ...extra });
    await run({ action: 'project.bind', documentId: (await running.call('/v1/status')).documentId });
    const review = await run({ action: 'review.prepare', reviewId: randomUUID(), question: 'Read in the background.', files: [] });
    await run({ action: 'review.submit', reviewId: review.id, documentId: (await running.call('/v1/status')).documentId });
    assert.equal((await current('read', 'sent-trust')).text, 'true');
    await current('click', 'rewind');
    assert.equal((await running.call('/v1/review-ui')).historyAtLatest, false);
    assert.equal((await run({ action: 'review.collect', reviewId: review.id, waitMs: 2000 })).state, 'completed');
    await current('press', 'prompt-textarea', { key: 'Enter' });
    assert.equal((await current('read', 'key')).text, 'Enter:true');
    const after = JSON.parse(await readFile(focusPath, 'utf8'));
    assert.equal(after.focuses, focus.focuses);
    assert.equal(after.otherFocused, true);
    assert.equal(after.primaryFocused, false);
  } finally {
    if (running) await running.stop();
    await new Promise(done => server.close(done));
  }
});

test('focus navigation cannot insert text into the changed document', async () => {
  await mkdir('artifacts/test-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/test-runs/focus-navigation-'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<button id="start">Start</button><textarea id="composer">original</textarea><pre id="inputs">0</pre><script>composer.onfocus=()=>history.replaceState({},"","/other-conversation");composer.oninput=()=>inputs.textContent=String(Number(inputs.textContent)+1);start.focus()</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let app;
  try {
    app = await launch(join(evidence, 'profile'), `http://127.0.0.1:${server.address().port}/`, evidence);
    const documentId = (await app.call('/v1/status')).documentId;
    const run = command => app.call('/v1/commands', { id: randomUUID(), command });
    await run({ action: 'press', key: 'Escape', documentId, target: { attribute: 'id', value: 'start' } });
    await assert.rejects(run({ action: 'fill', documentId, target: { attribute: 'id', value: 'composer' }, text: 'wrong conversation' }), { code: 'stale_document' });
    const current = await app.call('/v1/status');
    assert(current.url.endsWith('/other-conversation'));
    assert.notEqual(current.documentId, documentId);
    for (const [value, expected] of [['composer', 'original'], ['inputs', '0']]) {
      const result = await run({ action: 'read', documentId: current.documentId, target: { attribute: 'id', value } });
      assert.equal(result.result.text, expected);
    }
  } finally {
    if (app) await app.stop();
    await new Promise(done => server.close(done));
  }
});

test('navigation between input preparation and native delivery cannot click the replacement document', async () => {
  await mkdir('artifacts/test-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/test-runs/delivery-navigation-'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<button id="send">Send</button><pre id="count">0</pre><script>send.onclick=()=>count.textContent=String(Number(count.textContent)+1)</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/`;
  const entry = join(evidence, 'navigation.mjs');
  await writeFile(entry, `import { app } from 'electron';
app.on('browser-window-created', (_event, window) => {
  const contents = window.webContents;
  const send = contents.debugger.sendCommand.bind(contents.debugger);
  let navigation;
  contents.debugger.sendCommand = async (method, ...args) => {
    if (method.startsWith('Input.')) {
      navigation ??= contents.loadURL(${JSON.stringify(`${url}replacement`)}).then(() =>
        contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'));
      await navigation;
    }
    return send(method, ...args);
  };
});
await import(${JSON.stringify(new URL('../src/main.mjs', import.meta.url).href)});
`);
  let app;
  try {
    app = await launch(join(evidence, 'profile'), url, evidence, entry);
    const documentId = (await app.call('/v1/status')).documentId;
    const run = command => app.call('/v1/commands', { id: randomUUID(), command });
    await assert.rejects(run({ action: 'click', documentId, target: { attribute: 'id', value: 'send' } }), { code: 'target_changed' });
    const current = await app.call('/v1/status');
    assert.equal(current.url, `${url}replacement`);
    assert.notEqual(current.documentId, documentId);
    const count = await run({ action: 'read', documentId: current.documentId, target: { attribute: 'id', value: 'count' } });
    assert.equal(count.result.text, '0');
  } finally {
    if (app) await app.stop();
    await new Promise(done => server.close(done));
  }
});

test('a delayed pointer handler cannot submit after the command deadline', async () => {
  await mkdir('artifacts/test-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/test-runs/late-pointer-'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<form><button id="send" type="submit">Send</button></form><pre id="count">0</pre><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();count.textContent="1"};send.onpointerdown=()=>{const end=performance.now()+600;while(performance.now()<end){}};</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let app;
  try {
    app = await launch(join(evidence, 'profile'), `http://127.0.0.1:${server.address().port}/`, evidence);
    const { documentId } = await app.call('/v1/status');
    await assert.rejects(app.call('/v1/commands', { id: randomUUID(), deadlineMs: 100,
      command: { action: 'click', documentId, target: { attribute: 'id', value: 'send' } } }), { code: 'command_timeout' });
    await app.call('/v1/snapshot');
    const result = await app.call('/v1/commands', { id: randomUUID(), command: { action: 'read', documentId, target: { attribute: 'id', value: 'count' } } });
    assert.equal(result.result.text, '0');
  } finally {
    if (app) await app.stop();
    await new Promise(done => server.close(done));
  }
});
