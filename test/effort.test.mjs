import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, lstat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnElectron } from './electron.mjs';
import { connect } from '../src/client.mjs';

const exec = promisify(execFile);
const projectId = 'g-p-0123456789abcdef0123456789abcdef';
const alternateProjectId = 'g-p-fedcba9876543210fedcba9876543210';
const fixture = (mode) => `<!doctype html><meta charset="utf-8"><style>button,textarea,[role=menuitem]{padding:12px} [role=menu]{background:white;padding:20px} section{white-space:pre-wrap}</style>
<div data-app-action-sidebar-project-id="${projectId}"></div>
<form ${mode === 'legacy' ? '' : 'data-chatgpt-composer data-composer-placement="home"'}><textarea id="prompt-textarea"></textarea><button type="button" data-codex-intelligence-trigger="true" data-selected-reasoning-effort="medium" aria-expanded="false">任意文字</button><button type="submit" data-testid="send-button">번역</button></form><pre id="sent">${''}</pre><div id="messages"></div>
<script>
const mode=${JSON.stringify(mode)};
const threadMode=mode==='thread'||mode.startsWith('retained-');let activePage,inactivePage;
function retainPage(){inactivePage?.remove();inactivePage=activePage.cloneNode(true);inactivePage.dataset.appShellActivePage='false';inactivePage.hidden=true;inactivePage.querySelector('#prompt-textarea').value='Preserved inactive draft';activePage.after(inactivePage)}
const states=mode==='reordered'?['pro','high','none','max','medium']:['none','medium','high','max','pro'];
let index=states.indexOf(mode==='initial-pro'?'pro':'medium');let menu;const trigger=document.querySelector('[data-codex-intelligence-trigger]');
function raw(){return states[index]==='pro'?'medium':states[index]}
function update(){trigger.dataset.selectedReasoningEffort=raw();if(menu){menu.querySelector('[data-maximum]').dataset.maximum=String(states[index]==='pro');menu.querySelector('[role=slider]').setAttribute('aria-valuenow',index)}}
function close(){trigger.setAttribute('aria-expanded','false');menu?.remove();menu=null}
function open(){trigger.setAttribute('aria-expanded','true');menu=document.createElement('div');menu.setAttribute('role','menu');menu.dataset.state='open';menu.innerHTML='<div data-model-picker-view="'+(mode==='advanced'?'advanced':'simple')+'"><button data-model-picker-view-toggle="true"><span data-effort-only="true" data-maximum="false">別</span></button><div role="menuitem" tabindex="0" data-reasoning-slider="true"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0">Anything</span></div></div>';document.body.append(menu);menu.querySelector('[data-model-picker-view-toggle]').onclick=()=>menu.querySelector('[data-model-picker-view]').dataset.modelPickerView='simple';menu.querySelector('[data-reasoning-slider]').onkeydown=e=>{if(e.key==='Escape'){if(mode==='badge-race'){index=states.indexOf('medium');const badge=menu.querySelector('[data-maximum]');const replacement=badge.cloneNode(true);replacement.dataset.maximum='false';badge.replaceWith(replacement)}close();return}if(mode==='stuck'){fetch('/effort-wait');return;}if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();index=Math.max(0,Math.min(4,index+(e.key==='ArrowRight'?1:-1)));update()}};update();if(mode==='ambiguous'){const duplicate=menu.querySelector('[data-reasoning-slider]').cloneNode(true);menu.firstElementChild.append(duplicate)}}
trigger.onclick=()=>menu?close():open();update();
const editor=document.getElementById('prompt-textarea');const send=document.querySelector('[type=submit]');
if(mode==='effort-race')send.onpointerdown=()=>{index=states.indexOf('high');update()};
if(mode==='pro-race')send.onpointerdown=()=>{open();index=states.indexOf('medium');update();close()};
if(mode==='draft-race')trigger.onpointerdown=()=>editor.value='user draft';
document.querySelector('form').onsubmit=e=>{e.preventDefault();localStorage.setItem('sent',states[index]);document.getElementById('sent').textContent=states[index];const prompt=editor.value;editor.value='';if(threadMode){const form=editor.closest('form');let owner=form.closest('[data-map-composer-conversation]');if(!owner){owner=document.createElement('div');owner.dataset.mapComposerConversation='local-scope';owner.style.display='contents';form.before(owner);owner.append(form);form.dataset.composerPlacement='thread';history.replaceState(null,'','/g/${projectId}/c/01234567-89ab-4cde-8123-0123456789ab')}}const id=prompt.match(/Review request UUID: ([a-f0-9-]+)/)[1];if(!threadMode)history.replaceState(null,'','/g/${projectId}/c/'+id);for(const [role,text]of [['user',prompt],['assistant','answer\\nEND-OF-REVIEW:'+id]]){const turn=document.createElement('section');turn.dataset.testid='conversation-turn-'+role;const body=document.createElement('div');body.dataset.messageAuthorRole=role;body.dataset.messageId=role+'-'+id;body.textContent=text;turn.append(body);if(role==='assistant'){const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='Copy';turn.append(copy)}document.getElementById('messages').append(turn)}if(activePage)retainPage()};
if(mode.startsWith('retained-')){activePage=document.createElement('div');activePage.dataset.appShellActivePage='true';const form=editor.closest('form');form.before(activePage);activePage.append(form,document.getElementById('sent'),document.getElementById('messages'));retainPage();if(mode==='retained-ambiguous'){inactivePage.dataset.appShellActivePage='true';inactivePage.hidden=false}if(mode==='retained-race')send.onpointerdown=()=>{activePage.dataset.appShellActivePage='false';activePage.hidden=true;inactivePage.dataset.appShellActivePage='true';inactivePage.hidden=false}};
</script>`;

async function launch(profile, url, evidence) {
  const child = spawnElectron(['.', '--profile', profile, ...(url === undefined ? [] : ['--url', url])], { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(evidence, `electron-${child.pid}.log`));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const closed = once(child, 'close'); closed.then(() => log.end());
  await new Promise((resolveReady, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Electron startup timed out')); }, 30000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('"event":"ready"')) { clearTimeout(timer); resolveReady(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Electron exited ${code}`)); });
  });
  const call = await connect(profile);
  return { call, stop: async () => { await call('/v1/commands', { id: randomUUID(), command: { action: 'quit' } }); await closed; } };
}

test('effort selection through real Electron and CLI', { timeout: 90000 }, async (t) => {
  await mkdir('artifacts/effort-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/effort-runs/run-'));
  const profile = join(evidence, 'profile');
  let mode = 'normal', effortWait;
  const server = createServer((request, response) => {
    if (request.url === '/effort-wait') { effortWait?.resolve(); response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url.includes(alternateProjectId) ? fixture(mode).replaceAll(projectId, alternateProjectId) : fixture(mode));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/g/${projectId}/project`;
  let app = await launch(profile, url, evidence), call = app.call;
  t.after(async () => { await app.stop(); await new Promise(done => server.close(done)); });
  const run = async (command, deadlineMs = 10000) => (await call('/v1/commands', { id: randomUUID(), command, deadlineMs })).result;
  const navigate = async (next) => { mode = next; return run({ action: 'navigate', url }); };
  const prepare = async (effort, id = randomUUID()) => run({ action: 'review.prepare', reviewId: id, question: 'Review', files: [], effort });
  const submit = async (id, deadlineMs) => run({ action: 'review.submit', reviewId: id, documentId: (await call('/v1/status')).documentId }, deadlineMs);
  const sent = async () => (await run({ action: 'read', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'sent' } })).text;
  await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });
  await t.test('an unscoped composer selects and sends the requested Pro effort', async () => {
    await navigate('legacy');
    assert.deepEqual((await call('/v1/review-ui')).composer, { attribute: 'id', value: 'prompt-textarea' });
    const record = await prepare('pro');
    await submit(record.id);
    assert.equal(await sent(), 'pro');
    const result = await run({ action: 'review.collect', reviewId: record.id, waitMs: 1500 });
    assert.equal(result.state, 'completed');
    assert.equal(result.selectedEffort.effort, 'pro');
  });
  await t.test('all semantic efforts select correctly even when slider order changes', async () => {
    for (const effort of ['none', 'medium', 'high', 'max', 'pro']) {
      await navigate('reordered');
      const record = await prepare(effort); await submit(record.id);
      assert.equal(await sent(), effort);
      const result = await run({ action: 'review.collect', reviewId: record.id, waitMs: 1500 });
      assert.equal(result.state, 'completed'); assert.equal(result.effort, effort);
      assert.equal(result.selectedEffort.effort, effort);
    }
  });
  await t.test('advanced menu and Pro-to-Medium preserve exact requested semantics', async () => {
    for (const selected of ['advanced', 'initial-pro']) {
      await navigate(selected); const record = await prepare('medium'); await submit(record.id);
      assert.equal(await sent(), 'medium');
    }
  });
  await t.test('effort is part of persistent review identity', async () => {
    const record = await prepare('high');
    await assert.rejects(prepare('pro', record.id), { code: 'review_conflict' });
  });
  await t.test('changed effort or same-raw-value Pro replacement blocks actual send', async () => {
    for (const selected of ['effort-race', 'pro-race']) {
      await navigate(selected); const record = await prepare('pro');
      await assert.rejects(submit(record.id), { code: 'target_changed' });
      assert.equal(await sent(), '');
      assert.equal((await call(`/v1/reviews/${record.id}`)).state, 'uncertain');
    }
  });
  await t.test('Pro badge replacement while closing cannot send Medium', async () => {
    await navigate('badge-race'); const record = await prepare('pro');
    await assert.rejects(submit(record.id), { code: 'target_changed' });
    assert.equal(await sent(), '');
    assert.equal((await call('/v1/review-ui')).draft, '');
    assert.equal((await call(`/v1/reviews/${record.id}`)).state, 'failed');
    await navigate('normal');await submit(record.id);
    assert.equal(await sent(),'pro');
    assert.equal((await run({action:'review.collect',reviewId:record.id,waitMs:1500})).state,'completed');
  });
  await t.test('ambiguity, no progress, and intervening draft never send', async () => {
    for (const selected of ['ambiguous', 'stuck', 'draft-race']) {
      await navigate(selected); const record = await prepare('max');
      await assert.rejects(submit(record.id, 1800));
      if (selected === 'stuck') {
        await delay(150);
        const failed = await call(`/v1/reviews/${record.id}`);
        assert.equal(failed.state, 'failed');
        assert.equal(failed.lastFailure.phase, 'effort.wait_changed');
        assert.equal(failed.sendAttemptedAt, undefined);
      }
      assert.equal(await sent(), '');
      if (selected === 'draft-race') assert.equal((await call('/v1/review-ui')).draft, 'user draft');
    }
  });
  await t.test('follow-up effort uses the observed thread composer scope', async () => {
    await navigate('thread');const first=await prepare('max');await submit(first.id);
    const previous=await run({action:'review.collect',reviewId:first.id,waitMs:1500});
    const next=await run({action:'review.prepare',reviewId:randomUUID(),question:'Follow up',files:[],effort:'pro',continueFrom:{reviewId:previous.id,promptHash:previous.promptHash,answerHash:previous.answerHash,effort:previous.effort}});
    await submit(next.id);assert.equal(await sent(),'pro');
    assert.equal((await run({action:'review.collect',reviewId:next.id,waitMs:1500})).state,'completed');
    assert.equal((await call('/v1/review-ui')).messages.length,4);
  });
  await t.test('CLI resumes interrupted Pro preparation with all 19 large source files and the same checkpoint', async () => {
    await navigate('stuck');
    const paths = [];
    for (let index = 0; index < 19; index++) {
      const path = join(evidence, `source-${index}.txt`);
      await writeFile(path, `Source ${index}\n${'source原文\n'.repeat(2112)}`);
      paths.push(path);
    }
    const out = join(evidence, 'interrupted.txt');
    effortWait = Promise.withResolvers();
    const first = exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--question', 'Review every original source.',
      '--effort', 'pro', ...paths.flatMap(path => ['--file', path]), '--out', out]).then(
      () => { throw new Error('Interrupted submission unexpectedly completed.'); }, error => error);
    await Promise.race([effortWait.promise, first.then(error => { throw error; }), delay(15000).then(() => { throw new Error('Effort selection was not entered.'); })]);
    const checkpoint = await readFile(`${out}.request.json`, 'utf8');
    const id = JSON.parse(checkpoint).reviewId;
    const before = JSON.parse(await readFile(join(profile, 'reviews', `${id}.json`), 'utf8'));
    assert.equal(before.state, 'preparing');
    assert.equal(before.sendAttemptedAt, undefined);
    assert.equal(before.sources.length, 19);
    assert.ok(before.prompt.length > 360000);
    await app.stop(); await first;
    assert.equal(JSON.parse(await readFile(join(profile, 'reviews', `${id}.json`), 'utf8')).state, 'preparing');
    mode = 'normal'; app = await launch(profile, url, evidence); call = app.call;
    await run({ action: 'navigate', url: url.replace(projectId, alternateProjectId) });
    await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'submit', '--out', out]), error => /project_changed/.test(error.stderr));
    assert.deepEqual((await call(`/v1/reviews/${id}`)).project, before.project);
    assert.equal((await call('/v1/review-ui')).messages.length, 0);
    assert.equal((await call('/v1/review-ui')).draft, '');
    await run({ action: 'navigate', url });
    await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'submit', '--out', out, '--timeout', '5000']);
    const after = await call(`/v1/reviews/${id}`);
    assert.equal(after.state, 'completed'); assert.equal(after.selectedEffort.effort, 'pro');
    assert.equal(after.promptHash, before.promptHash); assert.deepEqual(after.sources, before.sources);
    assert.equal(await readFile(`${out}.request.json`, 'utf8'), checkpoint);
    const messages = (await call('/v1/review-ui')).messages;
    assert.equal(messages.length, 2);
    const transmitted = JSON.parse(messages[0].text.split('\n').find(line => line.startsWith('{')));
    assert.deepEqual(transmitted, JSON.parse(before.prompt.split('\n').find(line => line.startsWith('{'))));
    assert.equal(messages[0].text.split('\n').at(-1), before.prompt.split('\n').at(-1));
    for (let index = 0; index < paths.length; index++) {
      const original = await readFile(paths[index], 'utf8');
      assert.equal(transmitted.files[index].content, original);
      assert.equal(transmitted.files[index].sha256, createHash('sha256').update(original).digest('hex'));
      assert.equal(transmitted.files[index].bytes, Buffer.byteLength(original));
    }
    await submit(id);
    assert.equal((await call('/v1/review-ui')).messages.length, 2);
    assert.match(await readFile(out, 'utf8'), new RegExp(`END-OF-REVIEW:${id}`));
  });
  await t.test('public input cannot forge an effort receipt or bypass dismissal guards', async () => {
    const documentId = (await call('/v1/status')).documentId;
    for (const field of ['effortToken', 'dismissEffortToken']) {
      await assert.rejects(run({ action: 'press', documentId, target: { attribute: 'id', value: 'prompt-textarea' }, key: 'Escape', [field]: randomUUID() }), { code: 'invalid_command' });
    }
  });
  await t.test('CLI prepare/ask persist effort; conflicting or misplaced flags are rejected', async () => {
    await navigate('normal');
    const input = join(evidence, 'input.json'); const out = join(evidence, 'answer.txt');
    await exec(process.execPath, ['src/cli.mjs', 'prepare', '--question', 'Review', '--effort', 'pro', '--out', input]);
    assert.equal(JSON.parse(await readFile(input, 'utf8')).effort, 'pro');
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--request', input, '--out', out, '--timeout', '5000']);
    assert.equal(await sent(), 'pro');
    assert.equal(JSON.parse(await readFile(`${out}.request.json`, 'utf8')).command.effort, 'pro');
    const changedOut = join(evidence, 'changed-effort.txt');
    const checkpoint = JSON.parse(await readFile(`${out}.request.json`, 'utf8'));
    checkpoint.command.effort = 'high';
    await writeFile(`${changedOut}.request.json`, JSON.stringify(checkpoint));
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'collect', '--out', changedOut]), error => /checkpoint_mismatch/.test(error.stderr));
    await assert.rejects(readFile(changedOut), { code: 'ENOENT' });
    for (const args of [['prepare', '--question', 'X', '--effort', 'bogus'], ['ask', '--request', input, '--effort', 'high'], ['collect', '--effort', 'high'], ['status', '--effort', 'high']]) {
      await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, ...args, '--out', join(evidence, randomUUID())]));
    }
  });
});


test('retained pages preserve active review routing and inactive drafts', { timeout: 45000 }, async t => {
  await mkdir('artifacts/effort-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/effort-runs/retained-'));
  const profile = join(evidence, 'profile');
  let mode = 'normal';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixture(mode));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/g/${projectId}/project`;
  const app = await launch(profile, url, evidence), call = app.call;
  t.after(async () => { await app.stop(); await new Promise(done => server.close(done)); });
  const run = async command => (await call('/v1/commands', { id: randomUUID(), command, deadlineMs: 10000 })).result;
  await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });
  const read = async (id, active) => (await run({ action: 'read', documentId: (await call('/v1/status')).documentId,
    target: { attribute: 'id', value: id, scope: { attribute: 'data-app-shell-active-page', value: String(active) } } })).text;
  for (const selected of ['retained-normal', 'retained-ambiguous', 'retained-race']) await t.test(selected, async () => {
    mode = selected; await run({ action: 'navigate', url });
    const first = await run({ action: 'review.prepare', reviewId: randomUUID(), question: 'Review', files: [], effort: 'max' });
    const command = { action: 'review.submit', reviewId: first.id, documentId: (await call('/v1/status')).documentId };
    if (selected !== 'retained-normal') {
      await assert.rejects(run(command), { code: selected === 'retained-race' ? 'target_changed' : 'ambiguous_chatgpt_ui' });
      const record = await call(`/v1/reviews/${first.id}`);
      assert.equal(record.answer, undefined);
      if (selected === 'retained-ambiguous') assert.equal(record.sendAttemptedAt, undefined);
      else {
        assert.equal(await read('sent', true), ''); assert.equal(await read('sent', false), '');
        assert.equal(await read('prompt-textarea', true), 'Preserved inactive draft');
      }
      return;
    }
    await run(command);
    const previous = await run({ action: 'review.collect', reviewId: first.id, waitMs: 1500 });
    assert.equal(previous.state, 'completed'); assert.equal(previous.selectedEffort.effort, 'max');
    assert.equal(await read('prompt-textarea', false), 'Preserved inactive draft');
    const next = await run({ action: 'review.prepare', reviewId: randomUUID(), question: 'Follow up', files: [], effort: 'pro',
      continueFrom: { reviewId: previous.id, promptHash: previous.promptHash, answerHash: previous.answerHash, effort: previous.effort } });
    await run({ action: 'review.submit', reviewId: next.id, documentId: (await call('/v1/status')).documentId });
    const completed = await run({ action: 'review.collect', reviewId: next.id, waitMs: 1500 });
    assert.equal(completed.state, 'completed'); assert.equal(completed.selectedEffort.effort, 'pro');
    assert.equal(await read('sent', true), 'pro'); assert.equal(await read('prompt-textarea', false), 'Preserved inactive draft');
    const view = await call('/v1/review-ui');
    assert.equal(view.messages.length, 4);
    assert.equal((await run({ action: 'read', documentId: (await call('/v1/status')).documentId, target: view.composer })).text, '');
    const requestPath = join(evidence, 'read-active-composer.json');
    await writeFile(requestPath, JSON.stringify({ id: randomUUID(), command: { action: 'read',
      documentId: (await call('/v1/status')).documentId, target: view.composer } }));
    const result = await exec(process.execPath, ['src/cli.mjs', 'run', '--profile', profile, '--file', requestPath]);
    assert.equal(JSON.parse(result.stdout).result.text, '');
    assert.equal((await run({ action: 'review.collect', reviewId: next.id, waitMs: 0 })).state, 'completed');
    assert.equal((await call('/v1/review-ui')).messages.length, 4);
  });
});
