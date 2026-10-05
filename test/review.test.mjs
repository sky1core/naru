import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, lstat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import electron from 'electron';
import { connect } from '../src/client.mjs';

const exec = promisify(execFile);
const projectId = 'g-p-0123456789abcdef0123456789abcdef';
const fixture = `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;margin:30px}textarea{width:90%;height:180px}button{padding:12px}section{white-space:pre-wrap}</style>
<div data-app-action-sidebar-project-id="${projectId}"></div><form><textarea id="prompt-textarea"></textarea><button type="submit" data-testid="send-button">Label changes do not matter</button></form>
<button id="finish">Finish existing response</button><button id="revise">Revise current response</button><pre id="count">0</pre><pre id="last-project"></pre><div id="messages"></div>
<script>
const mode=new URL(location.href).searchParams.get('mode');
const editor=document.getElementById('prompt-textarea');
const send=document.querySelector('[data-testid="send-button"]');
const messages=document.getElementById('messages');
const count=document.getElementById('count');document.getElementById('last-project').textContent=localStorage.getItem('last-project')||'';
let counter=Number(localStorage.getItem('count') || '0');count.textContent=counter;
if(localStorage.getItem('messages'))messages.innerHTML=localStorage.getItem('messages');
function section(role,text,id){const turn=document.createElement('section');turn.dataset.testid='conversation-turn-'+id;const body=document.createElement('div');body.dataset.messageAuthorRole=role;body.dataset.messageId=id;body.textContent=text;turn.append(body);messages.append(turn);return body}
function finish(){const answer=Array.from(messages.querySelectorAll('[data-message-author-role="assistant"]')).at(-1);if(!answer)return;answer.textContent='검토 결과\\n  원문 유지 🙂\\nEND-OF-REVIEW:'+messages.dataset.review;document.querySelector('[data-testid="stop-button"]')?.remove();if(!answer.parentElement.querySelector('[data-testid="copy-turn-action-button"]')){const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='변경된 번역 문구';answer.parentElement.append(copy)}if(mode==='search-unit'){for(const body of messages.querySelectorAll('[data-message-id]')){body.dataset.chatgptSearchUnitKey=body.dataset.messageId+':'+body.dataset.messageAuthorRole;body.dataset.chatgptSearchMessageIds=body.dataset.messageId;body.parentElement.dataset.contentSearchTurnKey=body.dataset.messageId;delete body.dataset.messageId;delete body.dataset.messageAuthorRole}}localStorage.setItem('messages',messages.innerHTML);setTimeout(()=>{const marker=document.createElement('div');marker.id='proof-stable';marker.textContent='settled';document.body.append(marker)},700)}
document.getElementById('finish').onclick=finish;document.getElementById('revise').onclick=()=>{const answer=Array.from(messages.querySelectorAll('[data-message-author-role="assistant"]')).at(-1);answer.textContent='수정된 답변\\nEND-OF-REVIEW:'+messages.dataset.review};
if(mode==='login'){const login=document.createElement('h2');login.id='sidebar-login-title';login.textContent='signed out';document.body.append(login)}
if(mode==='ambiguous'){const other=editor.cloneNode(true);document.body.append(other)}
if(['modern-stop','modern-voice','modern-stream-hidden','modern-stream-absent','modern-activity-hidden','modern-activity-absent'].includes(mode)){document.querySelector('form').dataset.chatgptComposer='';document.querySelector('form').dataset.composerPlacement='home';send.type='button';delete send.dataset.testid;send.innerHTML='<svg class="icon-primary-action"></svg>';const url='/g/${projectId}/c/11111111-1111-4111-8111-111111111111';history.replaceState(null,'',url+'?mode='+mode);const row=document.createElement('div');row.setAttribute('role','listitem');row.innerHTML='<span data-thread-title-trigger><a href="'+url+'">任意</a></span>'+(mode==='modern-stop'?'<span role="status">処理</span>':'');const outer=document.createElement('div');outer.setAttribute('role','listitem');outer.innerHTML='<span role="status">Unrelated parent status</span><div role="listitem"><span data-thread-title-trigger><a href="/c/another">other</a></span><span role="status">other active</span></div>';outer.append(row);document.body.append(outer);const hidden=document.createElement('span');hidden.setAttribute('role','status');hidden.hidden=true;row.append(hidden);if(mode.endsWith('-hidden'))outer.hidden=true;if(mode.endsWith('-absent'))outer.remove();if(mode.startsWith('modern-stream-')||mode.startsWith('modern-activity-')){const turn=document.createElement('div');turn.dataset.contentSearchTurnKey='active';turn.innerHTML=mode.startsWith('modern-stream-')?'<div data-markdown-animated data-markdown-text-style="assistant-message">Changing streamed output</div>':'<div role="status" aria-live="polite">Working</div>';messages.append(turn);document.getElementById('finish').onclick=()=>turn.remove()}}
if(mode==='modern-busy'){const turn=document.createElement('div');turn.dataset.contentSearchTurnKey='active';turn.innerHTML='<span role="status" aria-busy="true">Generating</span>';messages.append(turn)}
if(mode==='project-race')send.onpointerdown=()=>history.replaceState(null,'','/');
if(mode==='race')send.onpointerdown=()=>{editor.value='intervening user draft'};
if(mode==='race-mousedown')send.onmousedown=()=>{editor.value='intervening user draft'};
if(mode==='focus-draft')editor.onfocus=()=>{editor.value='restored user draft'};
if(mode==='slow-focus')editor.onfocus=()=>{const until=performance.now()+700;while(performance.now()<until){}};
if(mode==='dynamic-send'){send.remove();editor.oninput=()=>{if(editor.value)setTimeout(()=>document.querySelector('form').append(send),120)}};
if(['modern-send','scope-race','hidden-composer'].includes(mode)){document.querySelector('form').dataset.chatgptComposer='';document.querySelector('form').dataset.composerPlacement='home';delete send.dataset.testid;const decoy=document.createElement('form');decoy.innerHTML='<button type="submit">Unrelated form</button>';decoy.onsubmit=e=>{e.preventDefault();count.textContent='WRONG'};document.body.append(decoy);if(mode==='scope-race')send.onpointerdown=()=>{const duplicate=document.createElement('form');duplicate.dataset.chatgptComposer='';duplicate.dataset.composerPlacement='home';document.body.append(duplicate)}};
if(mode==='hidden-composer'){const hidden=document.querySelector('form').cloneNode(true);hidden.dataset.composerPlacement='thread';hidden.style.display='none';document.body.append(hidden)};
if(mode==='stale-project'){const form=document.querySelector('form');form.dataset.chatgptComposer='';form.dataset.composerPlacement='thread';const owner=document.createElement('div');owner.dataset.mapComposerConversation='outside-conversation';form.before(owner);owner.append(form)};
document.querySelector('form').onsubmit=event=>{event.preventDefault();localStorage.setItem('last-project',mode==='stale-project'?'wrong':'bound');document.getElementById('last-project').textContent=localStorage.getItem('last-project');counter++;localStorage.setItem('count',counter);count.textContent=counter;const prompt=editor.value;editor.value='';const id=prompt.match(/Review request UUID: ([a-f0-9-]+)/)[1];messages.dataset.review=id;if(mode!=='route')history.replaceState(null,'','/g/${projectId}/c/'+id);section('user',prompt,'user-'+id);const answer=section('assistant','partial','answer-'+id);const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='not a selector';document.body.append(stop);
if(mode==='partial'){stop.remove();const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='完成';answer.parentElement.append(copy)}
else if(mode==='error'){stop.remove();const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='fixture upstream failed';answer.parentElement.append(alert)}
else if(mode==='unrelated'){section('user','another prompt','other-user');finish()}
else if(mode==='duplicate'){section('assistant','second answer','second-answer');finish()}
else setTimeout(finish,mode==='slow'?1500:80);if(mode==='route')setTimeout(()=>history.replaceState(null,'','/g/${projectId}/c/'+id),400);if(mode==='temporary-route'){history.replaceState(null,'','/g/${projectId}/c/local-chatgpt%3A'+id);setTimeout(()=>{history.replaceState(null,'','/g/${projectId}/c/'+id);const canonical=document.createElement('div');canonical.id='canonical-route';document.body.append(canonical)},400)}if(mode==='replace-message')setTimeout(()=>{messages.querySelector('[data-message-id="user-'+id+'"]').dataset.messageId='replacement'},400);if(mode==='leave-conversation')setTimeout(()=>messages.replaceChildren(),400);
};
</script>`;

const modernFixture = `<!doctype html><meta charset="utf-8"><style>[data-search-result-target],[data-markdown-text-style],[data-composer-markdown]{white-space:pre-wrap}[data-composer-markdown]{height:160px;overflow:auto}</style>
<div data-app-action-sidebar-project-id="${projectId}"></div>
<form data-chatgpt-composer data-composer-placement="home"><div data-composer-markdown contenteditable="true"></div><button type="submit">Send</button></form>
<button id="finish">Finish</button><div id="messages"></div>
<script>
let phase=0;let turn;let answer;let footer;let status;
document.querySelector('form').onsubmit=e=>{e.preventDefault();const prompt=document.querySelector('[data-composer-markdown]').innerText;document.querySelector('[data-composer-markdown]').innerText='';const id=prompt.match(/Review request UUID: ([a-f0-9-]+)/)[1];history.replaceState(null,'','/g/${projectId}/c/'+id);turn=document.createElement('div');turn.dataset.contentSearchTurnKey=id;turn.innerHTML='<div data-chatgpt-search-unit-key="'+id+':user" data-chatgpt-search-message-ids="user-'+id+'"><div data-user-message-bubble><div data-search-result-target></div></div><div class="turn-action-controls"><button>Decoy user actions</button></div></div><div data-chatgpt-search-unit-key="'+id+':assistant" data-chatgpt-search-message-ids="answer-'+id+' answer-'+id+'"><div data-markdown-text-style="assistant-message"></div></div>';const body=turn.querySelector('[data-search-result-target]');body.textContent=prompt.replace(/["*\x60~]/g,c=>String.fromCharCode(92)+c);const anchor=document.createElement('a');anchor.dataset.searchResultTarget='';anchor.href='https://example.com/';anchor.style.display='inline-flex';const icon=document.createElement('span');icon.dataset.markdownCopy='exclude';icon.style.display='block';icon.textContent='UI icon decoration';anchor.replaceChildren(icon,document.createTextNode(anchor.href));const at=body.textContent.indexOf(anchor.href);const raw=body.textContent;body.replaceChildren(document.createTextNode(raw.slice(0,at)),anchor,document.createTextNode(raw.slice(at+anchor.href.length)));const tail=body.lastChild;const codeText=String.fromCharCode(92,96)+'code'+String.fromCharCode(92,96);const codeAt=tail.textContent.indexOf(codeText);const code=document.createElement('code');code.textContent='code';tail.replaceWith(document.createTextNode(tail.textContent.slice(0,codeAt)),code,document.createTextNode(tail.textContent.slice(codeAt+codeText.length)));answer=turn.querySelector('[data-markdown-text-style]');answer.textContent='검토 결과\\nEND-OF-REVIEW:'+id;document.getElementById('messages').append(turn)};
document.getElementById('finish').onclick=()=>{phase++;if(phase===1){const nested=document.createElement('div');nested.className='turn-action-controls';nested.innerHTML='<button>Decoy answer content</button>';answer.parentElement.append(nested)}if(phase===2){footer=document.createElement('div');footer.className='turn-action-controls';footer.innerHTML='<button>Completed response action</button>';turn.append(footer);status=document.createElement('span');status.setAttribute('role','status');status.setAttribute('aria-busy','true');status.textContent='Generating';turn.append(status)}if(phase===3){status.remove();footer.hidden=true}if(phase===4){footer.hidden=false}};
</script>`;

const renderedSourceFixture = String.raw`<!doctype html><meta charset="utf-8"><style>[data-search-result-target],[data-markdown-text-style],[data-composer-markdown]{white-space:pre-wrap}[data-composer-markdown]{height:160px;overflow:auto}</style>
<div data-app-action-sidebar-project-id="${projectId}"></div>
<form data-chatgpt-composer data-composer-placement="home"><div data-composer-markdown contenteditable="true"></div><button type="submit">Send</button></form>
<button id="finish">Finish</button><pre id="count">0</pre><div id="messages"></div>
<script>
let turn, answer, status, id;
document.querySelector('form').onsubmit=e=>{
  e.preventDefault();
  const editor=document.querySelector('[data-composer-markdown]');
  const prompt=editor.innerText;editor.innerText='';
  document.getElementById('count').textContent=Number(document.getElementById('count').textContent)+1;
  id=prompt.match(/Review request UUID: ([a-f0-9-]+)/)[1];
  history.replaceState(null,'','/g/${projectId}/c/'+id);
  turn=document.createElement('div');turn.dataset.contentSearchTurnKey=id;
  turn.innerHTML='<div data-chatgpt-search-unit-key="'+id+':user" data-chatgpt-search-message-ids="user-'+id+'"><div data-user-message-bubble><div data-search-result-target class="rich-text-user-turn"><p></p></div></div></div><div data-chatgpt-search-unit-key="'+id+':assistant" data-chatgpt-search-message-ids="answer-'+id+'"><div data-markdown-text-style="assistant-message"></div></div>';
  const slash=String.fromCharCode(92);
  const image='https://example.invalid/image'+slash+slash;
  const rules='https://example.com/rules)으로';
  const raw=prompt.replace(/["*\x60~]/g,c=>slash+c).replace(image,'['+image+']('+image+')')
    .replace(rules,'['+rules+'](https://example.com/rules'+slash+')으로)');
  const literal='@latest'+slash+slash+'n';
  const at=raw.indexOf(literal);
  const span=document.createElement('span');span.dataset.markdownCopy='inline-code';span.textContent=literal;
  turn.querySelector('p').replaceChildren(document.createTextNode(raw.slice(0,at)),span,document.createTextNode(raw.slice(at+literal.length)));
  answer=turn.querySelector('[data-markdown-text-style]');answer.textContent='partial';
  status=document.createElement('span');status.setAttribute('role','status');status.setAttribute('aria-busy','true');status.textContent='Generating';turn.append(status);
  document.getElementById('messages').append(turn);
};
document.getElementById('finish').onclick=()=>{
  status.remove();answer.textContent='검토 결과\nEND-OF-REVIEW:'+id;
  const footer=document.createElement('div');footer.className='turn-action-controls';footer.innerHTML='<button>Complete</button>';turn.append(footer);
};
</script>`;

const fencedSourceFixture = String.raw`<!doctype html><meta charset="utf-8"><style>p,pre,[data-markdown-text-style],[data-composer-markdown]{white-space:pre-wrap}[data-composer-markdown]{height:160px;overflow:auto}</style>
<div data-app-action-sidebar-project-id="PROJECT_ID"></div>
<form data-chatgpt-composer data-composer-placement="home"><div data-composer-markdown contenteditable="true"></div><button type="submit">Send</button></form>
<button id="tamper">Change source</button><button id="remove-array">Remove array bracket</button><button id="insert-newline">Insert source newline</button><pre id="count">0</pre><div id="messages"></div>
<script>
document.querySelector('form').onsubmit=e=>{
  e.preventDefault();
  const editor=document.querySelector('[data-composer-markdown]');const prompt=editor.innerText;editor.innerText='';
  const id=prompt.match(/Review request UUID: ([a-f0-9-]+)/)[1];
  history.replaceState(null,'','/g/PROJECT_ID/c/'+id);
  document.getElementById('count').textContent=Number(document.getElementById('count').textContent)+1;
  const turn=document.createElement('div');turn.dataset.contentSearchTurnKey=id;
  turn.innerHTML='<div data-chatgpt-search-unit-key="'+id+':user" data-chatgpt-search-message-ids="user-'+id+'"><div data-user-message-bubble><div data-search-result-target class="rich-text-user-turn"></div></div></div><div data-chatgpt-search-unit-key="'+id+':assistant" data-chatgpt-search-message-ids="answer-'+id+'"><div data-markdown-text-style="assistant-message"></div></div><div class="turn-action-controls"><button>Complete</button></div>';
  const body=turn.querySelector('[data-search-result-target]');
  const opening=new RegExp('^('+String.fromCharCode(96)+'{3,})json\\n','m').exec(prompt);
  if(opening){
    const start=opening.index+opening[0].length;const end=prompt.indexOf('\n'+opening[1]+'\n',start);
    const prefix=document.createElement('p');prefix.textContent=prompt.slice(0,opening.index).replace(/\n$/,'');
    const code=document.createElement('code');code.textContent=prompt.slice(start,end);
    const pre=document.createElement('pre');pre.append(code);
    const suffix=document.createElement('p');suffix.textContent=prompt.slice(end+opening[1].length+2);
    if('CODE_LAYOUT'==='copy-block'){
      const block=document.createElement('div');block.dataset.markdownCopy='code-block';
      const controls=document.createElement('div');controls.dataset.markdownCopy='exclude';controls.textContent='json Copy';
      const scroller=document.createElement('div');
      const syntax=document.createElement('span');syntax.textContent=code.textContent;code.replaceChildren(syntax);
      scroller.append(code);block.append(controls,scroller);
      body.replaceChildren(document.createTextNode(prefix.textContent+'\n'),block,document.createTextNode('\n'+suffix.textContent));
    }else body.replaceChildren(prefix,pre,suffix);
  }else body.textContent=prompt.replace('"files":[','"files":\n');
  turn.querySelector('[data-markdown-text-style]').textContent='answer\nEND-OF-REVIEW:'+id;
  document.getElementById('messages').append(turn);
};
document.getElementById('tamper').onclick=()=>{const code=document.querySelector('code');code.textContent=code.textContent.replace('KEEP_VALUE','CHANGED_VALUE')};
document.getElementById('remove-array').onclick=()=>{const code=document.querySelector('code');code.textContent=code.textContent.replace('"files":[','"files":')};
document.getElementById('insert-newline').onclick=()=>{const code=document.querySelector('code');code.textContent=code.textContent.replace('KEEP_VALUE','KEEP\n_VALUE')};
</script>`.replaceAll('PROJECT_ID', projectId);

async function launch(profile, url, evidence) {
  const child = spawn(electron, ['.', '--profile', profile, ...(url === undefined ? [] : ['--url', url])], { stdio: ['ignore', 'pipe', 'pipe'] });
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

test('review workflow through the real Electron API and CLI against an isolated external page', { timeout: 90000 }, async (t) => {
  await mkdir('artifacts/review-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/review-runs/run-'));
  const profile = join(evidence, 'profile');
  let fixtureMode = 'normal';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixtureMode === 'modern-actions' ? modernFixture : fixture.replace("const mode=new URL(location.href).searchParams.get('mode');", `const mode=${JSON.stringify(fixtureMode)};`));
    if (fixtureMode === 'stale-project') fixtureMode = 'normal';
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let app = await launch(profile, `${origin}/g/${projectId}/project?mode=normal`, evidence);
  let call = app.call;
  const run = async command => (await call('/v1/commands', { id: randomUUID(), command })).result;
  const navigate = async mode => { fixtureMode = mode; return run({ action: 'navigate', url: `${origin}/g/${projectId}/project?mode=${mode}&unique=${randomUUID()}` }); };
  const prepare = async (extra = {}) => run({ action: 'review.prepare', reviewId: randomUUID(), question: '원문 전체를 확인해 주세요.', files: [], ...extra });
  const submit = async id => run({ action: 'review.submit', reviewId: id, documentId: (await call('/v1/status')).documentId });
  const collect = async (id, waitMs = 2500) => run({ action: 'review.collect', reviewId: id, waitMs });
  const count = async () => (await run({ action: 'read', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'count' } })).text;
  t.after(async () => { if (app) await app.stop(); await new Promise(resolveClose => server.close(resolveClose)); });

  const unbound = await prepare();
  await assert.rejects(submit(unbound.id), { code: 'project_required' });
  assert.equal(await count(), '0');
  await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });

  await t.test('offline preparation preserves source bytes and does not require a running profile', async () => {
    const source = join(evidence, 'source.txt');
    const text = '\ufeff첫 줄\r\n\r\n  공백\t"</script>" 🙂\n';
    await writeFile(source, text);
    const prepared = join(evidence, 'prepared.json');
    await exec(process.execPath, ['src/cli.mjs', '--profile', join(evidence, 'not-running'), 'prepare', '--base-dir', evidence, '--question', '  question\n', '--file', 'source.txt', '--out', prepared]);
    const command = JSON.parse(await readFile(prepared, 'utf8'));
    assert.equal(command.files[0].content, text);
    assert.equal(command.question, '  question\n');
    assert.equal(command.files[0].path, 'source.txt');
    assert.equal(command.files[0].sha256, createHash('sha256').update(text).digest('hex'));
    assert.equal((await lstat(prepared)).mode & 0o777, 0o600);
    const answer = join(evidence, 'answer.txt');
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--request', prepared, '--out', answer, '--timeout', '5000']);
    assert.equal(await readFile(answer, 'utf8'), `검토 결과\n  원문 유지 🙂\nEND-OF-REVIEW:${command.reviewId}`);
    const record = await call(`/v1/reviews/${command.reviewId}`);
    assert.equal(record.state, 'completed');
    assert.equal(record.sources[0].sha256, command.files[0].sha256);
    const before = await count();
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--request', prepared, '--out', answer]), error => /output_exists/.test(error.stderr));
    assert.equal(await count(), before);
  });

  await t.test('request identity is persistent and repeat submit never dispatches twice', async () => {
    await navigate('normal');
    const review = await prepare();
    const before = Number(await count());
    await submit(review.id); await submit(review.id);
    assert.equal(Number(await count()), before + 1);
    const completed = await collect(review.id);
    assert.equal(completed.state, 'completed');
    await assert.rejects(prepare({ reviewId: review.id, question: 'changed' }), { code: 'review_conflict' });
    await app.stop(); app = null;
    app = await launch(profile, undefined, evidence); call = app.call;
    assert.equal((await call('/v1/project')).id, projectId);
    assert.equal((await call('/v1/status')).url, (await call('/v1/project')).url);
    assert.equal((await submit(review.id)).state, 'completed');
    assert.equal((await collect(review.id, 0)).answer, completed.answer);
    assert.equal(Number(await count()), before + 1);
  });

  await t.test('an empty composer can reveal its send control only after input', async () => {
    await navigate('dynamic-send');
    const review = await prepare();
    const before = Number(await count());
    assert.equal((await call('/v1/review-ui')).send, null);
    await submit(review.id);
    assert.equal(Number(await count()), before + 1);
    assert.equal((await collect(review.id)).state, 'completed');
  });

  await t.test('send control belongs to the unique composer form, including during delivery', async () => {
    await navigate('hidden-composer');
    const review = await prepare();
    const before = Number(await count());
    await submit(review.id);
    assert.equal(Number(await count()), before + 1);
    assert.equal((await collect(review.id)).state, 'completed');
    await navigate('scope-race');
    const raced = await prepare();
    const beforeRace = await count();
    await assert.rejects(submit(raced.id), { code: 'target_changed' });
    assert.equal(await count(), beforeRace);
  });

  await t.test('project binding persists and an outside conversation cannot receive the review', async () => {
    await navigate('normal');
    const bound = await call('/v1/project');
    assert.equal(bound.id, projectId);
    await run({ action: 'navigate', url: `${origin}/?mode=normal` });
    const review = await prepare();
    await submit(review.id);
    const completed = await collect(review.id);
    assert.equal(completed.project.id, projectId);
    assert.match(completed.startURL, new RegExp('/g/' + projectId + '/project'));
    assert.equal((await call('/v1/project')).id, projectId);
    await run({ action: 'navigate', url: `${origin}/?mode=normal` });
    await run({ action: 'fill', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'prompt-textarea' }, text: 'private draft outside project' });
    const conflict = await prepare();
    await assert.rejects(submit(conflict.id), { code: 'draft_conflict' });
    assert.equal((await call('/v1/review-ui')).draft, 'private draft outside project');
    assert.equal(new URL((await call('/v1/status')).url).pathname, '/');
    await navigate('project-race');
    const raced = await prepare(); const before = await count();
    await assert.rejects(submit(raced.id), { code: 'target_changed' });
    assert.equal(await count(), before);
  });

  await t.test('a stale outside composer under the bound project URL is never used', async () => {
    await navigate('stale-project');
    const review = await prepare();
    await submit(review.id);
    const last = await run({ action: 'read', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'last-project' } });
    assert.equal(last.text, 'bound');
    assert.equal((await collect(review.id)).state, 'completed');
  });

  await t.test('guest, ambiguous targets and existing drafts never send or overwrite', async () => {
    for (const [mode, code] of [['login', 'login_required'], ['ambiguous', 'ambiguous_chatgpt_ui'], ['modern-busy', 'generation_active']]) {
      await navigate(mode);
      const review = await prepare(); const before = await count();
      await assert.rejects(submit(review.id), { code });
      assert.equal((await call(`/v1/reviews/${review.id}`)).state, 'prepared');
      assert.equal(await count(), before);
    }
    await navigate('normal');
    await run({ action: 'fill', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'prompt-textarea' }, text: 'user draft' });
    const review = await prepare(); const before = await count();
    await assert.rejects(submit(review.id), { code: 'draft_conflict' });
    assert.equal((await call('/v1/review-ui')).draft, 'user draft');
    assert.equal(await count(), before);
  });

  await t.test('a changed draft during trusted click is blocked and retained as uncertain', async () => {
    for (let iteration = 0; iteration < 20; iteration++) {
    await navigate(iteration % 2 === 0 ? 'race' : 'race-mousedown');
    const review = await prepare(); const before = await count();
    await assert.rejects(submit(review.id), { code: 'target_changed' });
    assert.equal(await count(), before);
    assert.equal((await call(`/v1/reviews/${review.id}`)).state, 'uncertain');
    assert.equal((await submit(review.id)).state, 'uncertain');
    assert.equal(await count(), before);
    }
  });

  await t.test('preflight failure can be explicitly submitted with its original checkpoint', async () => {
    await navigate('login');
    const out = join(evidence, 'after-preflight.txt'); const before = Number(await count());
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--question', 'same request', '--out', out]), error => /login_required/.test(error.stderr));
    const checkpoint = JSON.parse(await readFile(`${out}.request.json`, 'utf8'));
    assert.equal((await call(`/v1/reviews/${checkpoint.reviewId}`)).state, 'prepared');
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'doctor']), error => JSON.parse(error.stdout).problem.code === 'login_required');
    assert.equal(Number(await count()), before);
    await navigate('normal');
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'submit', '--out', out, '--timeout', '3000']);
    assert((await readFile(out, 'utf8')).endsWith(`END-OF-REVIEW:${checkpoint.reviewId}`));
    assert.equal(Number(await count()), before + 1);
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'collect', '--out', out, '--question', 'new input']), error => /invalid_arguments/.test(error.stderr));
  });

  await t.test('focus-time user draft restoration must not be overwritten or sent', async () => {
    await navigate('focus-draft'); const before = await count(); const review = await prepare();
    await assert.rejects(submit(review.id), { code: 'draft_conflict' });
    assert.equal((await call('/v1/review-ui')).draft, 'restored user draft');
    assert.equal(await count(), before);
  });

  await t.test('conflicting input cannot collect a previous answer into a new output', async () => {
    await navigate('normal'); const review = await prepare(); await submit(review.id); await collect(review.id);
    const out = join(evidence, 'conflicting.txt');
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--id', review.id, '--question', 'different input', '--out', out]), error => /review_conflict/.test(error.stderr));
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'collect', '--out', out]), error => /checkpoint_mismatch/.test(error.stderr));
    await assert.rejects(lstat(out), { code: 'ENOENT' });
  });

  await t.test('busy preparation resumes from original input checkpoint without a new review', async () => {
    await navigate('normal');
    const status = await call('/v1/status');
    const pending = run({ action: 'wait', documentId: status.documentId, target: { attribute: 'id', value: 'never-present' }, state: 'present', timeoutMs: 1200 }).catch(error => error);
    const until = Date.now() + 2000;
    while ((await call('/v1/status')).execution === null) { assert(Date.now() < until); await delay(50); }
    const out = join(evidence, 'busy-preparation.txt');
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--question', 'recover identical input', '--out', out]), error => /busy/.test(error.stderr));
    const checkpoint = JSON.parse(await readFile(`${out}.request.json`, 'utf8'));
    await assert.rejects(call(`/v1/reviews/${checkpoint.reviewId}`), { code: 'review_missing' });
    assert.equal((await pending).code, 'wait_timeout');
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'submit', '--out', out, '--timeout', '3000']);
    assert((await readFile(out, 'utf8')).endsWith(`END-OF-REVIEW:${checkpoint.reviewId}`));
    assert((await call(`/v1/reviews/${checkpoint.reviewId}`)).prompt.includes('recover identical input'));
  });

  await t.test('explicit review execution deadline prevents late fill and send', async () => {
    await navigate('slow-focus'); const before = await count();
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--question', 'expire', '--out', join(evidence, 'deadline.txt'), '--deadline', '100']), error => /command_timeout/.test(error.stderr));
    await call('/v1/review-ui');
    const until = Date.now() + 3000;
    while ((await call('/v1/status')).execution !== null) { assert(Date.now() < until); await delay(100); }
    assert.equal(await count(), before);
    assert.equal((await call('/v1/review-ui')).draft, '');
  });

  await t.test('partial output is never saved; collect reuses the original checkpoint without resending', async () => {
    await navigate('partial');
    const out = join(evidence, 'late.txt'); const before = Number(await count());
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--question', 'wait', '--out', out, '--timeout', '50']), error => /review_pending/.test(error.stderr));
    await assert.rejects(lstat(out), { code: 'ENOENT' });
    const checkpoint = JSON.parse(await readFile(`${out}.request.json`, 'utf8'));
    assert.equal((await collect(checkpoint.reviewId, 0)).observation.state, 'response_incomplete');
    await run({ action: 'click', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'finish' } });
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'collect', '--out', out, '--timeout', '3000']);
    assert((await readFile(out, 'utf8')).endsWith(`END-OF-REVIEW:${checkpoint.reviewId}`));
    assert.equal(Number(await count()), before + 1);
  });

  await t.test('short collection deadlines retain completion observation across requests', async () => {
    await navigate('normal');
    const out = join(evidence, 'short-collection.txt');
    await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--question', 'short collection', '--out', out, '--timeout', '0']), error => /review_pending/.test(error.stderr));
    const checkpoint = JSON.parse(await readFile(`${out}.request.json`, 'utf8'));
    await run({ action: 'wait', documentId: (await call('/v1/status')).documentId, target: { attribute: 'data-testid', value: 'stop-button' }, state: 'absent', timeoutMs: 3000 });
    await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'collect', '--out', out, '--deadline', '200', '--timeout', '1800']);
    assert((await readFile(out, 'utf8')).endsWith(`END-OF-REVIEW:${checkpoint.reviewId}`));
  });

  await t.test('answer changes reset observation even between collection calls', async () => {
    await navigate('normal'); const review = await prepare(); await submit(review.id);
    await run({ action: 'wait', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'proof-stable' }, state: 'present', timeoutMs: 3000 });
    assert((await call('/v1/review-ui')).stableForMs >= 600);
    await run({ action: 'click', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'revise' } });
    const pending = await collect(review.id, 0);
    assert.notEqual(pending.state, 'completed');
    assert.equal(pending.observation.state, 'candidate');
    assert((await collect(review.id)).answer.startsWith('수정된 답변'));
  });

  await t.test('conversation URL creation preserves the exact review message binding', async () => {
    await navigate('route'); const review = await prepare(); const submitted = await submit(review.id);
    assert.equal(submitted.conversationURL, `${origin}/g/${projectId}/c/${review.id}`);
    assert.equal(submitted.userMessageId, `user-${review.id}`);
    const result = await collect(review.id);
    assert.equal(result.state, 'completed');
    assert.equal(result.conversationURL, `${origin}/g/${projectId}/c/${review.id}`);
    assert.equal(result.userMessageId, `user-${review.id}`);
  });

  await t.test('submission waits for the canonical URL and collection never sends the temporary conversation twice', async () => {
    await navigate('temporary-route'); const review = await prepare();
    const before = Number(await count());
    const submitted = await submit(review.id);
    assert.equal(submitted.conversationURL, `${origin}/g/${projectId}/c/${review.id}`);
    assert.equal(submitted.userMessageId, `user-${review.id}`);
    assert.equal((await collect(review.id)).state, 'completed');
    await submit(review.id);
    assert.equal(Number(await count()), before + 1);
    assert.equal((await call(`/v1/reviews/${review.id}`)).promptHash, review.promptHash);
  });

  for (const mode of ['replace-message', 'leave-conversation']) {
    await t.test(`${mode} cannot replace the bound review message`, async () => {
      await navigate(mode); const review = await prepare(); await submit(review.id);
      await assert.rejects(collect(review.id), { code: 'conversation_changed' });
      assert.notEqual((await call(`/v1/reviews/${review.id}`)).state, 'completed');
    });
  }

  await t.test('failed, ambiguous or interleaved replies are not accepted as the review result', async () => {
    for (const [mode, code] of [['error', 'response_failed'], ['duplicate', 'ambiguous_response'], ['unrelated', 'conversation_changed']]) {
      await navigate(mode); const review = await prepare(); await submit(review.id);
      await assert.rejects(collect(review.id), { code });
      assert.notEqual((await call(`/v1/reviews/${review.id}`)).state, 'completed');
    }
  });

  await t.test('source digests and public schemas reject altered content and arbitrary UI channels', async () => {
    await assert.rejects(prepare({ files: [{ path: 'data.txt', content: 'text', sha256: '0'.repeat(64), bytes: 4 }] }), { code: 'source_mismatch' });
    await assert.rejects(prepare({ files: [{ path: '../secret', content: '', sha256: createHash('sha256').update('').digest('hex'), bytes: 0 }] }), { code: 'invalid_source_path' });
    await assert.rejects(run({ action: 'review.submit', reviewId: randomUUID(), documentId: randomUUID(), selector: 'text=Send' }), { code: 'invalid_command' });
    await assert.rejects(run({ action: 'click', documentId: randomUUID(), target: { attribute: 'text', value: 'Send' } }), { code: 'invalid_command' });
  });
  await t.test('oversized API input never creates a review record', async () => {
    const reviewId = randomUUID();
    await assert.rejects(prepare({ reviewId, question: 'x'.repeat(8 * 1024 * 1024) }), { code: 'body_too_large' });
    await assert.rejects(call(`/v1/reviews/${reviewId}`), { code: 'review_missing' });
  });
  await t.test('search-unit message IDs correlate the answer without localized labels', async () => {
    await navigate('search-unit');
    const review = await prepare(); await submit(review.id);
    const result = await collect(review.id);
    assert.equal((await call('/v1/review-ui')).layout, 'search-unit');
    assert.equal(result.state, 'completed');
    assert.equal(result.userMessageId, `user-${review.id}`);
    assert.equal(result.responseId, `answer-${review.id}`);
  });
  await t.test('idle voice actions and unrelated conversation statuses are not active generation', async () => {
    await navigate('modern-voice');
    assert.equal((await call('/v1/review-ui')).busy, false);
  });
  await t.test('current conversation status blocks submit and project navigation without a localized label', async () => {
    await navigate('modern-stop');
    const review = await prepare(); const before = await count();
    assert.equal((await call('/v1/review-ui')).busy, true);
    await assert.rejects(submit(review.id), { code: 'generation_active' });
    await assert.rejects(run({ action: 'project.open' }), { code: 'draft_conflict' });
    assert.equal(await count(), before);
    assert.equal(new URL((await call('/v1/status')).url).searchParams.get('mode'), 'modern-stop');
  });
  await t.test('streaming and tool activity remain protected when the current sidebar row is hidden or absent', async () => {
    for (const mode of ['modern-stream-hidden', 'modern-stream-absent', 'modern-activity-hidden', 'modern-activity-absent']) {
      await navigate(mode);
      const review = await prepare(); const before = await count();
      assert.equal((await call('/v1/review-ui')).busy, true, mode);
      await assert.rejects(submit(review.id), { code: 'generation_active' });
      await assert.rejects(run({ action: 'project.open' }), { code: 'draft_conflict' });
      assert.equal(await count(), before);
      const documentId = (await call('/v1/status')).documentId;
      await run({ action: 'click', documentId, target: { attribute: 'id', value: 'finish' } });
      assert.equal((await call('/v1/review-ui')).busy, false, mode);
    }
  });
  await t.test('modern response actions exclude user, answer-content and hidden controls and remain blocked while busy', async () => {
    await navigate('modern-actions');
    const files = Array.from({ length: 19 }, (_, index) => {
      const content = ('source `code` **bold** ~tilde~ "quote" \\n \\* 🙂\r\n').repeat(450);
      return { path: `source-${index}.txt`, content, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) };
    });
    const review = await prepare({ files, question: 'Read https://example.com/ and `code` exactly.' }); await submit(review.id);
    const view = await call('/v1/review-ui');
    assert(review.prompt.length > 360000);
    assert.notEqual(view.messages[0].text, review.prompt);
    assert.equal(view.composer.attribute, 'data-composer-markdown');
    for (let phase = 0; phase < 4; phase++) {
      const pending = await collect(review.id, 700);
      assert.notEqual(pending.state, 'completed');
      assert.equal(pending.observation.state, 'generating');
      await run({ action: 'click', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'finish' } });
    }
    const result = await collect(review.id);
    assert.equal(result.state, 'completed');
    assert.equal(result.responseId, `answer-${review.id}`);
    assert.equal(result.answer, `검토 결과\nEND-OF-REVIEW:${review.id}`);
  });
  console.log(`Review evidence: ${evidence}`);
});

test('rendered source is verified and collected without resending through real Electron and CLI', { timeout: 30000 }, async t => {
  await mkdir('artifacts/review-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/review-runs/rendered-source-'));
  const profile = join(evidence, 'profile');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderedSourceFixture);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let app;
  t.after(async () => {
    try { if (app) await app.stop(); }
    finally { await new Promise(done => server.close(done)); }
  });
  app = await launch(profile, `http://127.0.0.1:${server.address().port}/g/${projectId}/project`, evidence);
  const call = app.call;
  const run = async command => (await call('/v1/commands', { id: randomUUID(), command })).result;
  await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });
  const content = 'nested {"url":"https://example.invalid/image"}\nRead [rules](https://example.com/rules)으로 next; tool@latest\\n.';
  await writeFile(join(evidence, 'source.txt'), content);
  const out = join(evidence, 'answer.txt');
  await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--base-dir', evidence,
    '--file', 'source.txt', '--question', 'Review every source character.', '--out', out, '--timeout', '0']), error => /review_pending/.test(error.stderr));
  const checkpoint = JSON.parse(await readFile(out + '.request.json', 'utf8'));
  const submitted = await call(`/v1/reviews/${checkpoint.reviewId}`);
  assert.equal(submitted.state, 'submitted');
  const view = await call('/v1/review-ui');
  assert.equal(view.layout, 'search-unit');
  assert.equal(view.busy, true);
  assert.equal(view.messages[0].id, submitted.userMessageId);
  assert.equal(view.messages[0].inlineCode.length, 1);
  assert.notEqual(view.messages[0].text, submitted.prompt);
  await assert.rejects(lstat(out), { code: 'ENOENT' });
  await run({ action: 'click', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'finish' } });
  await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'collect', '--out', out, '--timeout', '3000']);
  const completed = await call(`/v1/reviews/${checkpoint.reviewId}`);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.userMessageId, submitted.userMessageId);
  assert.equal(completed.promptHash, createHash('sha256').update(submitted.prompt).digest('hex'));
  assert.equal(completed.sources[0].sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(completed.answer, `검토 결과\nEND-OF-REVIEW:${checkpoint.reviewId}`);
  assert.equal(await readFile(out, 'utf8'), completed.answer);
  assert.equal((await run({ action: 'read', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'count' } })).text, '1');
});

for (const layout of ['pre', 'copy-block']) test(`JSON source is preserved through ${layout} rendering and the original v2 checkpoint`, { timeout: 30000 }, async t => {
  await mkdir('artifacts/review-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/review-runs/fenced-source-'));
  const profile = join(evidence, 'profile');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fencedSourceFixture.replace('CODE_LAYOUT', layout));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let app;
  t.after(async () => {
    try { if (app) await app.stop(); }
    finally { await new Promise(done => server.close(done)); }
  });
  const url = `http://127.0.0.1:${server.address().port}/g/${projectId}/project`;
  app = await launch(profile, url, evidence);
  const call = app.call;
  const run = async command => (await call('/v1/commands', { id: randomUUID(), command })).result;
  await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });
  const content = '\ufeffKEEP_VALUE [one](https://example.com/one)·[two](https://example.com/two) `````` \\n\r\n🙂\n';
  await writeFile(join(evidence, 'source.txt'), content);
  const prepared = join(evidence, 'prepared.json');
  await exec(process.execPath, ['src/cli.mjs', 'prepare', '--base-dir', evidence, '--file', 'source.txt', '--question', 'Read the whole source.', '--out', prepared]);
  const input = JSON.parse(await readFile(prepared, 'utf8'));
  const out = join(evidence, 'answer.txt');
  await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--request', prepared, '--out', out, '--timeout', '3000']);
  const checkpoint = JSON.parse(await readFile(out + '.request.json', 'utf8'));
  const completed = await call(`/v1/reviews/${input.reviewId}`);
  assert.equal(checkpoint.version, 2);
  assert.deepEqual(checkpoint.command, input);
  assert.equal(checkpoint.promptHash, completed.promptHash);
  const view = await call('/v1/review-ui');
  assert.equal(view.messages[0].text, completed.prompt);
  assert.equal(JSON.parse(view.messages[0].text.split('\n')[2]).files[0].content, content);
  assert.equal(completed.sources[0].sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(await readFile(out, 'utf8'), completed.answer);
  assert.equal((await run({ action: 'read', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'count' } })).text, '1');

  for (const mutation of ['tamper', 'remove-array', 'insert-newline']) {
    await run({ action: 'navigate', url });
    const changed = await run({ ...input, reviewId: randomUUID() });
    await run({ action: 'review.submit', reviewId: changed.id, documentId: (await call('/v1/status')).documentId });
    await run({ action: 'click', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: mutation } });
    await assert.rejects(run({ action: 'review.collect', reviewId: changed.id, waitMs: 0 }), { code: 'review_content_mismatch' });
    await run({ action: 'review.submit', reviewId: changed.id, documentId: (await call('/v1/status')).documentId });
    assert.notEqual((await call(`/v1/reviews/${changed.id}`)).state, 'completed');
    assert.equal((await run({ action: 'read', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'count' } })).text, '1');
  }
});

const restartFixture = String.raw`<!doctype html><meta charset="utf-8"><style>section{white-space:pre-wrap}textarea{width:80%;height:150px}</style>
<div data-app-action-sidebar-project-id="PROJECT_ID"></div>
<form><textarea id="prompt-textarea"></textarea><input id="attachment" type="file"><button type="submit" data-testid="send-button">Send</button></form>
<button id="finish">Finish</button><button id="draft">Draft</button><button id="attach">Attach</button><button id="busy">Generate</button><button id="clear">Clear fixture work</button>
<pre id="count"></pre><pre id="saved"></pre><div id="messages"></div>
<script>
const mode=new URL(location.href).searchParams.get('mode');
const editor=document.getElementById('prompt-textarea'),messages=document.getElementById('messages'),file=document.getElementById('attachment');
const count=document.getElementById('count');count.textContent=localStorage.getItem('count')||'0';
const stored=localStorage.getItem(location.pathname);if(stored!==null)messages.innerHTML=stored;
function section(role,text,id){const turn=document.createElement('section');turn.dataset.testid='conversation-turn-'+id;const body=document.createElement('div');body.dataset.messageAuthorRole=role;body.dataset.messageId=id;body.textContent=text;turn.append(body);messages.append(turn);return body}
function persist(){localStorage.setItem(location.pathname,messages.innerHTML);document.getElementById('saved').textContent=messages.innerHTML}
function busy(){if(!document.querySelector('[data-testid="stop-button"]')){const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Generating';document.body.append(stop)}}
document.getElementById('draft').onclick=()=>{editor.value='private unsent draft 🙂'};
document.getElementById('attach').onclick=()=>{const transfer=new DataTransfer();transfer.items.add(new File(['private attachment bytes'],'private.txt',{type:'text/plain'}));file.files=transfer.files};
document.getElementById('busy').onclick=busy;
document.getElementById('clear').onclick=()=>{editor.value='';file.value='';document.querySelector('[data-testid="stop-button"]')?.remove()};
document.getElementById('finish').onclick=()=>{
  const user=messages.querySelector('[data-message-author-role="user"]'),answer=messages.querySelector('[data-message-author-role="assistant"]');
  const id=user.textContent.match(/Review request UUID: ([a-f0-9-]+)/)[1];answer.textContent='saved answer\n  exact bytes 🙂\nEND-OF-REVIEW:'+id;
  const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='Complete';answer.parentElement.append(copy);
  document.querySelector('[data-testid="stop-button"]')?.remove();persist();
};
document.querySelector('form').onsubmit=event=>{
  event.preventDefault();const prompt=editor.value;editor.value='';const id=prompt.match(/Review request UUID: ([a-f0-9-]+)/)[1];
  count.textContent=Number(count.textContent)+1;localStorage.setItem('count',count.textContent);
  history.replaceState(null,'','/g/PROJECT_ID/c/'+(mode==='temporary'?'local-chatgpt%3A':'')+id);
  section('user',prompt,'user-'+id);section('assistant','partial','answer-'+id);busy();persist();
};
if(location.pathname.endsWith('/c/other'))section('user','another conversation body','other-user');
if(location.pathname.includes('/c/local-chatgpt')){const id=messages.querySelector('[data-message-author-role="user"]').textContent.match(/Review request UUID: ([a-f0-9-]+)/)[1];history.replaceState(null,'','/g/PROJECT_ID/c/'+id);persist()}
const fault='FAULT';
if(fault==='missing')messages.replaceChildren();
if(fault==='identity')messages.querySelector('[data-message-author-role="user"]').dataset.messageId='replacement';
if(fault==='body')messages.querySelector('[data-message-author-role="user"]').textContent+=' changed source';
if(fault==='baseline'){const body=section('user','unexpected earlier turn','earlier-user');messages.prepend(body.parentElement)}
if(fault==='interleaved')section('user','unexpected later turn','later-user');
if(fault==='copied-route')history.replaceState(null,'','/g/PROJECT_ID/c/copied');
</script>`;

test('collect recovery after default restart preserves conversation identity and user work through real API and CLI', { timeout: 90000 }, async t => {
  await mkdir('artifacts/review-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/review-runs/restart-'));
  const profile = join(evidence, 'profile');
  const alternateId = 'g-p-fedcba9876543210fedcba9876543210';
  const loads = [];
  let fault = '';
  const server = createServer((request, response) => {
    const path = request.url.split('?')[0];
    if (path.startsWith('/g/')) loads.push(path);
    const recovering = path.includes('/c/') && !path.endsWith('/other');
    if (recovering && ['redirect', 'project-redirect'].includes(fault)) {
      response.writeHead(302, { Location: fault === 'redirect' ? `/g/${projectId}/c/other` : `/g/${alternateId}/project` });
      response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(restartFixture.replaceAll('PROJECT_ID', path.includes(alternateId) ? alternateId : projectId)
      .replace("const fault='FAULT';", `const fault=${JSON.stringify(recovering ? fault : '')};`));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = `${origin}/g/${projectId}/project`;
  let app;
  t.after(async () => {
    try { if (app) await app.stop(); }
    finally { await new Promise(done => server.close(done)); }
  });
  app = await launch(profile, home, evidence);
  let call = app.call;
  const run = async (command, deadlineMs = 5000) => (await call('/v1/commands', { id: randomUUID(), deadlineMs, command })).result;
  const click = async value => run({ action: 'click', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value } });
  const read = async value => (await run({ action: 'read', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value } })).text;
  const navigate = url => run({ action: 'navigate', url });
  const collect = (reviewId, waitMs = 2500) => run({ action: 'review.collect', reviewId, waitMs });
  const submitted = async () => {
    await navigate(home);
    await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });
    const record = await run({ action: 'review.prepare', reviewId: randomUUID(), question: 'Preserve all review bytes.', files: [] });
    return run({ action: 'review.submit', reviewId: record.id, documentId: (await call('/v1/status')).documentId });
  };
  await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });

  for (const mode of ['normal', 'temporary']) {
    await t.test(`${mode} saved conversation opens after restart and CLI collect never resends`, async () => {
      await navigate(`${home}?mode=${mode}`);
      await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });
      const before = Number(await read('count'));
      const out = join(evidence, `restart-${mode}.txt`);
      await assert.rejects(exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--question', 'Recover the original request.',
        '--out', out, '--deadline', mode === 'temporary' ? '3000' : '5000', '--timeout', '0']), error => new RegExp(mode === 'temporary' ? 'command_timeout' : 'review_pending').test(error.stderr));
      const checkpointBytes = await readFile(`${out}.request.json`, 'utf8');
      const checkpoint = JSON.parse(checkpointBytes);
      const sent = await call(`/v1/reviews/${checkpoint.reviewId}`);
      assert.equal(sent.state, mode === 'temporary' ? 'uncertain' : 'submitted');
      assert.equal(sent.userMessageId, `user-${sent.id}`);
      assert.equal(Number(await read('count')), before + 1);
      await click('finish');
      const answer = (await call('/v1/review-ui')).messages.find(message => message.role === 'assistant').text;
      assert((await read('saved')).includes(answer));
      await assert.rejects(lstat(out), { code: 'ENOENT' });
      await app.stop(); app = null;
      app = await launch(profile, undefined, evidence); call = app.call;
      assert.equal((await call('/v1/status')).url, `${home}?mode=${mode}`);
      assert.deepEqual((await call('/v1/review-ui')).messages, []);
      if (mode === 'temporary') await navigate(`${origin}/g/${projectId}/c/other`);
      await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'collect', '--out', out, '--timeout', '5000']);
      const completed = await call(`/v1/reviews/${sent.id}`);
      assert.equal(completed.state, 'completed');
      assert.equal(completed.answer, answer);
      assert.equal(await readFile(out, 'utf8'), answer);
      assert.equal(completed.answerHash, createHash('sha256').update(answer).digest('hex'));
      assert.equal(completed.conversationURL, `${origin}/g/${projectId}/c/${sent.id}`);
      assert.equal((await call('/v1/status')).url, completed.conversationURL);
      for (const key of ['id', 'prompt', 'promptHash', 'userMessageId', 'sendAttemptedAt', 'sources', 'project', 'baselineHistory']) {
        assert.deepEqual(completed[key], sent[key]);
      }
      assert.equal(await readFile(`${out}.request.json`, 'utf8'), checkpointBytes);
      assert.equal(Number(await read('count')), before + 1);
    });
  }

  await t.test('recovery cannot leave drafts, attachments or active generation on home or another conversation', async () => {
    const record = await submitted(); await click('finish');
    const saved = await call(`/v1/reviews/${record.id}`);
    const count = await read('count');
    for (const url of [home, `${origin}/g/${projectId}/c/other`]) {
      await navigate(url);
      for (const [control, code] of [['draft', 'draft_conflict'], ['attach', 'attachments_present'], ['busy', 'generation_active']]) {
        await click(control);
        const before = await call('/v1/review-ui');
        const loadCount = loads.length;
        await assert.rejects(collect(record.id, 0), { code });
        const after = await call('/v1/review-ui');
        for (const key of ['url', 'draft', 'attachments', 'busy', 'messages']) assert.deepEqual(after[key], before[key]);
        assert.equal(loads.length, loadCount);
        assert.deepEqual(await call(`/v1/reviews/${record.id}`), saved);
        assert.equal(await read('count'), count);
        await click('clear');
      }
    }
    assert.equal((await collect(record.id)).state, 'completed');
    assert.equal(await read('count'), count);
  });

  await t.test('collection in the current conversation preserves draft and attachment while generation finishes', async () => {
    const record = await submitted(); const count = await read('count');
    await click('draft'); await click('attach');
    const before = await call('/v1/review-ui'); const loadCount = loads.length;
    assert.equal((await collect(record.id, 0)).observation.state, 'generating');
    await click('finish');
    assert.equal((await collect(record.id)).state, 'completed');
    const after = await call('/v1/review-ui');
    assert.equal(after.url, before.url); assert.equal(after.draft, before.draft); assert.equal(after.attachments, true);
    assert.equal(loads.length, loadCount); assert.equal(await read('count'), count);
    await click('clear');
  });

  await t.test('reopened conversations still reject missing, replaced, changed and unrelated messages', async () => {
    const record = await submitted(); await click('finish'); const count = await read('count');
    const saved = await call(`/v1/reviews/${record.id}`);
    for (const [change, code] of [['missing', 'conversation_changed'], ['identity', 'conversation_changed'], ['body', 'review_content_mismatch'],
      ['baseline', 'conversation_changed'], ['interleaved', 'conversation_changed'], ['copied-route', 'conversation_changed'], ['redirect', 'conversation_changed'], ['project-redirect', 'project_changed']]) {
      await navigate(home); fault = change;
      await assert.rejects(collect(record.id), { code });
      fault = '';
      assert.deepEqual(await call(`/v1/reviews/${record.id}`), saved);
      assert.equal(await read('count'), count);
    }
    await navigate(`${origin}/g/${alternateId}/project`);
    await run({ action: 'project.bind', documentId: (await call('/v1/status')).documentId });
    const loadCount = loads.length;
    await assert.rejects(collect(record.id), { code: 'project_changed' });
    assert.equal(loads.length, loadCount);
    assert.deepEqual(await call(`/v1/reviews/${record.id}`), saved);
    assert.equal(await read('count'), count);
  });
});

test('default review execution survives a page load longer than the ordinary command deadline', { timeout: 60000 }, async t => {
  await mkdir('artifacts/review-runs', { recursive: true });
  const evidence = await mkdtemp(resolve('artifacts/review-runs/deadline-'));
  const profile = join(evidence, 'profile');
  let delayNextHome = false;
  const server = createServer((_request, response) => {
    const send = () => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixture); };
    if (delayNextHome) { delayNextHome = false; setTimeout(send, 31000); }
    else send();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/g/${projectId}/project`;
  const app = await launch(profile, url, evidence);
  t.after(async () => { await app.stop(); await new Promise(done => server.close(done)); });
  const call = app.call;
  await call('/v1/commands', { id: randomUUID(), command: { action: 'project.bind', documentId: (await call('/v1/status')).documentId } });
  delayNextHome = true;
  const out = join(evidence, 'review.txt');
  await exec(process.execPath, ['src/cli.mjs', '--profile', profile, 'ask', '--question', 'Read the original source.', '--out', out, '--timeout', '5000']);
  const checkpoint = JSON.parse(await readFile(out + '.request.json', 'utf8'));
  const record = await call(`/v1/reviews/${checkpoint.reviewId}`);
  assert.equal(record.state, 'completed');
  assert.equal(await readFile(out, 'utf8'), record.answer);
  const sent = await call('/v1/commands', { id: randomUUID(), command: { action: 'read', documentId: (await call('/v1/status')).documentId, target: { attribute: 'id', value: 'count' } } });
  assert.equal(sent.result.text, '1');
});
