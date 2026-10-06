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
const fixture = `<!doctype html><meta charset="utf-8"><style>textarea{width:90%;height:140px}section{white-space:pre-wrap}button{padding:8px}</style>
<div data-app-action-sidebar-project-id="${projectId}"></div>
<div id="thread"><form data-chatgpt-composer data-composer-placement="home"><textarea id="prompt-textarea"></textarea><button type="submit">任意の翻訳</button></form></div>
<button id="older-window">older window</button><button id="answer-window">answer window</button><button id="page-window">page window</button><button id="delete-earlier">delete earlier</button><button id="render-style">render style</button><button id="change-earlier-user">change earlier user</button><button id="broken-receipt">broken receipt</button><button id="cover">cover</button><button id="uncover">uncover</button><button id="change-answer">change</button><button id="interleave">interleave</button><button id="race">race</button><button id="partial">partial</button><pre id="count"></pre><pre id="received-files"></pre><div id="history" data-app-action-timeline-scroll style="height:240px;overflow:auto"><div id="messages"></div></div>
<script>
const editor=document.getElementById('prompt-textarea'),form=editor.closest('form'),messages=document.getElementById('messages'),thread=document.getElementById('thread');
let conversation=location.pathname.split('/c/')[1];
let partial=false;let renderEscapes=localStorage.getItem('render-escapes')!=='false';
let olderWindow=false;let answerWindow=false;let brokenReceipt=false;let historyLoaded=false;let historyDelay=0;let loadingHistory=false;const historyScroller=document.getElementById('history');
let turns=conversation?JSON.parse(localStorage.getItem(conversation)||'[]'):[];
const count=document.getElementById('count');count.textContent=localStorage.getItem('count')||'0';
function render(){document.getElementById('received-files').textContent=JSON.stringify(turns.filter(m=>m.role==='user'&&m.text.startsWith('Review request UUID: ')).flatMap(m=>JSON.parse(m.text.split('\\n').find(line=>line.startsWith('{'))).files));messages.replaceChildren();let turnIndex=-1;for(const [messageIndex,m] of turns.entries()){if(m.role==='user')turnIndex++;if(olderWindow&&messageIndex>=2||answerWindow&&messageIndex===0)continue;if(!historyLoaded&&localStorage.getItem('page-window-'+conversation)==='true'&&messageIndex<turns.length-4)continue;const section=document.createElement('section'),body=document.createElement('div');section.dataset.testid='conversation-turn-'+m.id;section.dataset.contentSearchTurnKey='fallback-turn-'+turnIndex;body.dataset.messageId=m.id;body.dataset.messageAuthorRole=m.role;body.textContent=m.role==='user'&&renderEscapes?m.text.replace(/["*\x60~]/g,c=>String.fromCharCode(92)+c):m.text;section.append(body);if(m.role==='assistant'){const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='任意';section.append(copy)}messages.append(section)}if(olderWindow){const spacer=document.createElement('div');spacer.style.height='600px';messages.append(spacer)}if(conversation){form.dataset.composerPlacement='thread';thread.dataset.mapComposerConversation='local-scope-'+conversation;localStorage.setItem(conversation,JSON.stringify(turns))}}
render();historyScroller.scrollTop=historyScroller.scrollHeight;historyScroller.onscroll=()=>{if((olderWindow||answerWindow)&&historyScroller.scrollTop+historyScroller.clientHeight>=historyScroller.scrollHeight){olderWindow=false;answerWindow=false;render();historyScroller.scrollTop=historyScroller.scrollHeight;return}if(historyScroller.scrollTop===0&&!historyLoaded&&localStorage.getItem('page-window-'+conversation)==='true'){if(!loadingHistory){loadingHistory=true;setTimeout(()=>{historyLoaded=true;loadingHistory=false;historyDelay=0;render()},historyDelay)}}else if(historyLoaded&&historyScroller.scrollTop+historyScroller.clientHeight>=historyScroller.scrollHeight){historyLoaded=false;render();historyScroller.scrollTop=historyScroller.scrollHeight}};
document.getElementById('older-window').onclick=()=>{olderWindow=true;render();historyScroller.scrollTop=0};document.getElementById('answer-window').onclick=()=>{answerWindow=true;render();const spacer=document.createElement('div');spacer.style.height='600px';messages.prepend(spacer);historyScroller.scrollTop=0};document.getElementById('page-window').onclick=()=>{localStorage.setItem('page-window-'+conversation,'true');historyDelay=2500;historyLoaded=false;render();historyScroller.scrollTop=historyScroller.scrollHeight};document.getElementById('delete-earlier').onclick=()=>{turns.splice(0,2);render()};
document.getElementById('render-style').onclick=()=>{renderEscapes=!renderEscapes;localStorage.setItem('render-escapes',renderEscapes);render()};
document.getElementById('change-earlier-user').onclick=()=>{turns.find(m=>m.role==='user').text=turns.find(m=>m.role==='user').text.replace('OLDER','TAMPERED');render()};
document.getElementById('broken-receipt').onclick=()=>{brokenReceipt=true};
document.getElementById('cover').onclick=()=>{editor.oninput=()=>{editor.oninput=null;const rect=form.querySelector('[type=submit]').getBoundingClientRect();const cover=document.createElement('div');cover.id='obstruction';cover.style.cssText='position:fixed;z-index:9999;background:red;left:'+rect.x+'px;top:'+rect.y+'px;width:'+rect.width+'px;height:'+rect.height+'px';document.body.append(cover)}};
document.getElementById('uncover').onclick=()=>{document.getElementById('obstruction')?.remove();editor.oninput=null};
document.getElementById('partial').onclick=()=>{partial=!partial};
document.getElementById('change-answer').onclick=()=>{turns.at(-1).text='edited answer';render()};
document.getElementById('interleave').onclick=()=>{turns.push({id:crypto.randomUUID(),role:'user',text:'another question'});render()};
document.getElementById('race').onclick=()=>{form.querySelector('[type=submit]').onpointerdown=()=>{turns.at(-1).text='changed during pointerdown';render()}};
form.onsubmit=e=>{e.preventDefault();const prompt=editor.value;editor.value='';const id=prompt.match(/Review request UUID: ([a-f0-9-]+)/)[1];const payload=JSON.parse(prompt.split('\\n').find(line=>line.startsWith('{')));if(!conversation){conversation=crypto.randomUUID();history.replaceState(null,'','/g/${projectId}/c/'+conversation)}turns.push({id:'u-'+id,role:'user',text:prompt});let answer=partial?'unfinished':'context: '+turns.filter(t=>t.role==='user').map(t=>JSON.parse(t.text.split('\\n').find(line=>line.startsWith('{'))).question).join(' | ');if(payload.part&&payload.part.index<payload.part.total)answer='PART-RECEIVED:'+payload.part.index+'/'+payload.part.total+':'+id;if((brokenReceipt||payload.question==='BROKEN-FIRST')&&payload.part){answer='received but omitted the markers';brokenReceipt=false}if(!partial&&!answer.startsWith('received but omitted'))answer+='\\nEND-OF-REVIEW:'+id;turns.push({id:'a-'+id,role:'assistant',text:answer});count.textContent=Number(count.textContent)+1;localStorage.setItem('count',count.textContent);historyLoaded=false;render();historyScroller.scrollTop=historyScroller.scrollHeight};
</script>`;
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


test('multipart and follow-up use the same conversation through Electron and CLI', {timeout:120000}, async t => {
  await mkdir('artifacts/continuation-runs',{recursive:true});
  const evidence=await mkdtemp(resolve('artifacts/continuation-runs/run-'));
  const profile=join(evidence,'profile');
  let initialHistory = null;
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(initialHistory
    ? fixture.replace('</script>', `if(conversation){
        if(${JSON.stringify(initialHistory)}==='busy-container'){
          const parked=[...messages.childNodes];messages.replaceChildren();
          const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Generating';document.body.append(stop);
          setTimeout(()=>{messages.append(...parked);setTimeout(()=>stop.remove(),100)},250);
        }else{
          historyScroller.remove();
          const first=${JSON.stringify(initialHistory)}==='assistant-first'?messages.querySelector('[data-message-author-role="assistant"]').parentElement:null;
          if(first)document.body.append(first);
          setTimeout(()=>{if(first)messages.append(first);document.body.append(historyScroller)},250);
        }
      }</script>`)
    : fixture)});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  let app=await launch(profile,`${origin}/g/${projectId}/project`,evidence);
  let call=app.call;
  const run=async command=>(await call('/v1/commands',{id:randomUUID(),command})).result;
  t.after(async()=>{if(app)await app.stop();await new Promise(done=>server.close(done))});
  await run({action:'project.bind',documentId:(await call('/v1/status')).documentId});
  const cli=(...args)=>exec(process.execPath,['src/cli.mjs','--profile',profile,...args]);
  const ask=async (name,...args)=>{const out=join(evidence,name+'.txt');await cli('ask','--question',name,'--out',out,'--timeout','5000',...args);return out};
  const checkpoint=async out=>JSON.parse(await readFile(out+'.request.json','utf8'));
  const click=async id=>run({action:'click',documentId:(await call('/v1/status')).documentId,target:{attribute:'id',value:id}});
  const count=async()=>(await run({action:'read',documentId:(await call('/v1/status')).documentId,target:{attribute:'id',value:'count'}})).text;
  const home=async()=>run({action:'navigate',url:`${origin}/g/${projectId}/project`});
  const record=async out=>call(`/v1/reviews/${(await checkpoint(out)).reviewId}`);
  const rejected=async (pattern,...args)=>assert.rejects(cli(...args),error=>pattern.test(error.stderr));
  let first,second,third;
  await t.test('part contract rejects missing links, impossible indices and misplaced flags before sending',async()=>{
    for(const args of [['ask','--part','2/3'],['ask','--part','0/2'],['ask','--part','3/2'],['ask','--part','1/1'],['status','--part','1/2'],['collect','--continue-from','missing']]) {
      await assert.rejects(cli(...args,'--question','invalid','--out',join(evidence,randomUUID())));
    }
    for(const part of [{index:2,total:3},{index:0,total:2},{index:3,total:2}]) {
      await assert.rejects(run({action:'review.prepare',reviewId:randomUUID(),question:'invalid',files:[],part}),{code:'invalid_command'});
    }
    assert.equal(await count(),'0');
  });
  await t.test('all ordered parts arrive in one conversation, final reply retains earlier context',async()=>{
    first=await ask('FIRST','--part','1/3');
    const url=(await call('/v1/status')).url;
    assert.match(url,/\/c\//);
    assert.match(await readFile(first,'utf8'),/PART-RECEIVED:1\/3:/);
    const source=join(evidence,'part-source.txt');
    const original='\ufeff자료 \r\n 그대로 🙂';await writeFile(source,original);
    second=await ask('SECOND','--part','2/3','--continue-from',first,'--base-dir',evidence,'--file','part-source.txt');
    assert.equal((await record(second)).sources[0].sha256,createHash('sha256').update(original).digest('hex'));
    third=await ask('THIRD','--part','3/3','--continue-from',second);
    assert.equal((await call('/v1/status')).url,url);
    assert.match(await readFile(third,'utf8'),/FIRST \| SECOND \| THIRD/);
    assert.equal((await call('/v1/review-ui')).messages.length,6);
    assert.notEqual((await call('/v1/review-ui')).messages[0].text,(await record(first)).prompt);
    assert.equal(await count(),'3');
  });
  if(!third)return;
  await t.test('ordinary continuation safely reopens the recorded thread and survives an app restart',async()=>{
    await app.stop();app=null;app=await launch(profile,undefined,evidence);call=app.call;
    const follow=await ask('FOLLOW','--continue-from',third);
    assert.match(await readFile(follow,'utf8'),/FIRST \| SECOND \| THIRD \| FOLLOW/);
    assert.equal(await count(),'4');
    const cp=await checkpoint(follow);
    await run({action:'review.submit',reviewId:cp.reviewId,documentId:(await call('/v1/status')).documentId});
    assert.equal(await count(),'4');
  });

  await t.test('older request rendering changes survive collection and reopened continuation while changed source is rejected',async()=>{
    await home();const first=await ask('OLDER');const second=join(evidence,'render-pending.txt');
    await rejected(/review_pending/,'ask','--question','PREVIOUS','--continue-from',first,'--out',second,'--timeout','0');
    const before=await count();await click('render-style');
    await cli('collect','--out',second,'--timeout','3000');
    assert.equal(await count(),before);
    await app.stop();app=null;app=await launch(profile,undefined,evidence);call=app.call;
    const third=await ask('AFTER-REOPEN','--continue-from',second);
    assert.match(await readFile(third,'utf8'),/OLDER \| PREVIOUS \| AFTER-REOPEN/);
    assert.equal(Number(await count()),Number(before)+1);
    await click('change-earlier-user');
    await rejected(/review_content_mismatch|conversation_changed/,'ask','--question','must not send','--continue-from',third,'--out',join(evidence,'changed-older.txt'));
    assert.equal(Number(await count()),Number(before)+1);
    await click('render-style');
  });

  await t.test('a newer hidden question prevents continuation from an older rendered viewport',async()=>{
    await home();const out=await ask('VISIBLE-OLDER');
    await click('interleave');await click('older-window');
    assert.equal((await call('/v1/review-ui')).messages.length,2);
    const before=await count();const rejectedOut=join(evidence,'hidden-interleave.txt');
    await rejected(/conversation_changed/,'ask','--question','must not send','--continue-from',out,'--out',rejectedOut,'--deadline','1500');
    const failed=await record(rejectedOut);
    assert.equal(failed.sendAttemptedAt,undefined);
    assert.equal((await call('/v1/review-ui')).draft,'');
    assert.equal(await count(),before);
  });
  await t.test('collection recovers its own first request when only the response is rendered',async()=>{
    await home();const out=join(evidence,'hidden-own-request.txt');
    await rejected(/review_pending/,'ask','--question','Recover own request.','--out',out,'--timeout','0');
    const sent=await record(out);assert.equal(sent.state,'submitted');
    const before=await count();await click('answer-window');
    const viewport=(await call('/v1/review-ui')).messages;
    assert.equal(viewport.length,1);assert.equal(viewport[0].role,'assistant');
    await cli('collect','--out',out,'--timeout','3000');
    assert((await readFile(out,'utf8')).endsWith(`END-OF-REVIEW:${sent.id}`));
    assert.equal(await count(),before);
  });

  await t.test('a paged conversation keeps its complete lineage while real removal is rejected',async()=>{
    await home();const a=await ask('PAGE-A');const b=await ask('PAGE-B','--continue-from',a);
    const c=await ask('PAGE-C','--continue-from',b);await click('page-window');
    assert.equal((await call('/v1/review-ui')).messages.length,4);
    const before=Number(await count());
    const d=await ask('PAGE-D','--continue-from',c);
    assert.equal((await record(d)).baselineHistory.length,6);
    const e=await ask('PAGE-E','--continue-from',d);
    assert.equal((await record(e)).baselineHistory.length,8);
    assert.equal((await call('/v1/review-ui')).messages.length,4);
    assert.equal(Number(await count()),before+2);
    await click('delete-earlier');
    await rejected(/conversation_changed|command_timeout/,'ask','--question','must not send','--continue-from',e,'--out',join(evidence,'removed-earlier.txt'),'--deadline','2500');
    const settledAt=Date.now()+2000;
    while((await call('/v1/status')).execution&&Date.now()<settledAt)await delay(100);
    assert.equal((await call('/v1/status')).execution,null);
    assert.equal(Number(await count()),before+2);
  });
  await t.test('skipped parts, changed totals and stale parents do not send',async()=>{
    await home();const out=await ask('SEQ','--part','1/3');const before=await count();
    for(const args of [['--part','3/3'],['--part','2/4'],[],['--part','1/3']]) {
      await rejected(/part_sequence|invalid|cli_error/,'ask','--question','wrong','--continue-from',out,'--out',join(evidence,randomUUID()),...args);
    }
    assert.equal(await count(),before);
    const next=await ask('SEQ2','--part','2/3','--continue-from',out);
    await rejected(/conversation_changed|continuation_used/,'ask','--question','duplicate second','--part','2/3','--continue-from',out,'--out',join(evidence,randomUUID()));
    assert.equal(Number(await count()),Number(before)+1);
    const cp=await checkpoint(next);const changed={...cp.command,continueFrom:{...cp.command.continueFrom,answerHash:'0'.repeat(64)}};
    await assert.rejects(run(changed),{code:'review_conflict'});
  });
  await t.test('changed output, checkpoint and answer DOM cannot be continued',async()=>{
    await home();const out=await ask('AUTHENTIC');const before=await count();
    const fake=join(evidence,'fake.txt');const cp=await checkpoint(out);
    await writeFile(fake+'.request.json',JSON.stringify(cp));await writeFile(fake,'tampered answer');
    await rejected(/continuation_mismatch/,'ask','--question','follow','--continue-from',fake,'--out',join(evidence,randomUUID()));
    cp.profile=join(evidence,'different-profile');await writeFile(fake+'.request.json',JSON.stringify(cp));
    await rejected(/checkpoint_mismatch/,'ask','--question','follow','--continue-from',fake,'--out',join(evidence,randomUUID()));
    await click('change-answer');
    await rejected(/conversation_changed/,'ask','--question','follow','--continue-from',out,'--out',join(evidence,randomUUID()));
    assert.equal(await count(),before);
  });
  await t.test('intervening turns and a changed history during trusted pointer delivery never send',async()=>{
    for(const mode of ['interleave','race']) {
      await home();const out=await ask(mode);const before=await count();await click(mode);
      const next=join(evidence,mode+'-blocked.txt');
      await rejected(/conversation_changed|target_changed/,'ask','--question','blocked follow','--continue-from',out,'--out',next);
      assert.equal(await count(),before);
      if(mode==='race') {
        const cp=await checkpoint(next);assert.equal((await call(`/v1/reviews/${cp.reviewId}`)).state,'uncertain');
        await run({action:'review.submit',reviewId:cp.reviewId,documentId:(await call('/v1/status')).documentId});
        assert.equal(await count(),before);
      }
    }
  });
  await t.test('current drafts survive an attempted reopen of the previous conversation',async()=>{
    await home();const out=await ask('KEEP');await home();const before=await count();
    await run({action:'fill',documentId:(await call('/v1/status')).documentId,target:{attribute:'id',value:'prompt-textarea'},text:'private draft'});
    await rejected(/draft_conflict/,'ask','--question','follow','--continue-from',out,'--out',join(evidence,randomUUID()));
    assert.equal((await call('/v1/review-ui')).draft,'private draft');assert.equal(await count(),before);
  });
  await t.test('timeout receipt is collected without resending and only then permits the next part',async()=>{
    await home();const out=join(evidence,'pending-part.txt');
    await rejected(/review_pending/,'ask','--question','pending','--part','1/2','--out',out,'--timeout','0');
    const before=await count();
    await rejected(/continuation_not_ready/,'ask','--question','too soon','--part','2/2','--continue-from',out,'--out',join(evidence,randomUUID()));
    await cli('collect','--out',out,'--timeout','3000');assert.equal(await count(),before);
    await ask('RESUMED','--part','2/2','--continue-from',out);assert.equal(Number(await count()),Number(before)+1);
  });
  await t.test('ordinary follow-up can recover a stable incomplete reply without resending its input',async()=>{
    await home();const out=await ask('RECOVERY-START');await click('partial');
    const pending=join(evidence,'incomplete.txt');
    await rejected(/review_pending/,'ask','--question','INCOMPLETE','--continue-from',out,'--out',pending,'--timeout','0');
    await assert.rejects(readFile(pending),{code:'ENOENT'});const before=await count();await click('partial');
    const result=await ask('RECOVER','--continue-from',pending);
    assert.match(await readFile(result,'utf8'),/RECOVERY-START \| INCOMPLETE \| RECOVER/);
    assert.equal(Number(await count()),Number(before)+1);
  });
  await t.test('prepared continuation preserves parent proof and rejects forged internal history controls',async()=>{
    await home();const out=await ask('OFFLINE-PARENT');const prepared=join(evidence,'continuation.json');
    await cli('prepare','--question','OFFLINE-FOLLOW','--continue-from',out,'--out',prepared);
    const input=JSON.parse(await readFile(prepared,'utf8'));assert.equal(input.continueFrom.reviewId,(await checkpoint(out)).reviewId);
    await cli('ask','--request',prepared,'--out',join(evidence,'offline-follow.txt'),'--timeout','3000');
    const status=await call('/v1/status');
    await assert.rejects(run({action:'click',documentId:status.documentId,target:{attribute:'id',value:'race'},expectedHistory:'[]'}),{code:'invalid_command'});
  });
  await t.test('a consumed parent cannot create another continuation even after leaving its conversation',async()=>{
    await home();const out=await ask('ONCE');const parent=await record(out);await ask('ONLY-CHILD','--continue-from',out);await home();
    await assert.rejects(run({action:'review.prepare',reviewId:randomUUID(),question:'duplicate',files:[],continueFrom:{reviewId:parent.id,promptHash:parent.promptHash,answerHash:parent.answerHash}}),{code:'continuation_used'});
  });
  await t.test('pre-dispatch obstruction preserves the exact draft and resumes the same request without consuming its parent',async()=>{
    await home();const out=await ask('OBSTRUCTED-PARENT');await click('cover');const before=await count();
    const next=join(evidence,'obstructed.txt');
    await rejected(/target_obscured/,'ask','--question','PRESERVE-DRAFT','--continue-from',out,'--out',next);
    const failed=await record(next);assert.equal(failed.state,'failed');assert.equal(failed.sendAttemptedAt,undefined);
    assert.equal((await record(out)).continuedBy,undefined);
    const draft=(await call('/v1/review-ui')).draft;const lines=failed.prompt.split('\n');
    assert.equal(draft,[...lines.slice(0,2),'```json',lines[2],'```',...lines.slice(3)].join('\n'));
    assert.equal(await count(),before);await click('uncover');
    assert.equal((await call('/v1/review-ui')).draft,draft);
    await cli('submit','--out',next,'--timeout','3000');
    assert.equal((await record(next)).id,failed.id);assert.equal(Number(await count()),Number(before)+1);
  });
  await t.test('an incomplete intermediate receipt is recovered in place without resending material or skipping a part',async()=>{
    await home();const first=await ask('RECOVER-PART1','--part','1/3');await click('broken-receipt');
    const second=join(evidence,'broken-part2.txt');
    await rejected(/review_pending/,'ask','--question','RECOVER-PART2','--part','2/3','--continue-from',first,'--out',second,'--timeout','0');
    await assert.rejects(readFile(second),{code:'ENOENT'});const before=await count();
    await rejected(/continuation_not_ready/,'ask','--question','cannot skip','--part','3/3','--continue-from',second,'--out',join(evidence,randomUUID()));
    const recovered=await ask('RECOVER-RECEIPT','--part','2/3','--continue-from',second);
    assert.match(await readFile(recovered,'utf8'),/PART-RECEIVED:2\/3:/);
    const final=await ask('RECOVER-FINAL','--part','3/3','--continue-from',recovered);
    assert.match(await readFile(final,'utf8'),/RECOVER-PART1 \| RECOVER-PART2 \| RECOVER-RECEIPT \| RECOVER-FINAL/);
    assert.equal(Number(await count()),Number(before)+2);
  });
  await t.test('first-part receipt repair accepts an explicit 1/TOTAL link and rejects resending source files',async()=>{
    await home();const out=join(evidence,'broken-first.txt');
    const source=join(evidence,'do-not-resend.txt');await writeFile(source,'already sent material');
    await rejected(/review_pending/,'ask','--question','BROKEN-FIRST','--part','1/2','--out',out,'--base-dir',evidence,'--file','do-not-resend.txt','--timeout','0');
    const before=await count();
    await rejected(/part_recovery_material/,'ask','--question','recover','--part','1/2','--continue-from',out,'--base-dir',evidence,'--file','do-not-resend.txt','--out',join(evidence,randomUUID()));
    assert.equal(await count(),before);
    const receipt=await ask('REPAIRED-FIRST','--part','1/2','--continue-from',out);
    assert.match(await readFile(receipt,'utf8'),/PART-RECEIVED:1\/2:/);
    await ask('AFTER-REPAIRED-FIRST','--part','2/2','--continue-from',receipt);
    const sentFiles=JSON.parse((await run({action:'read',documentId:(await call('/v1/status')).documentId,target:{attribute:'id',value:'received-files'}})).text);
    assert.equal(sentFiles.length,1);assert.equal(sentFiles[0].content,'already sent material');
    assert.equal(Number(await count()),Number(before)+2);
  });
  await t.test('collection and continuation wait for history that appears after the composer', async () => {
    for (const mode of ['complete-container', 'busy-container', 'assistant-first']) {
      await home();
      const question = `LOADING-HISTORY-${mode}`, out = join(evidence, `loading-history-${mode}.txt`);
      await rejected(/review_pending/, 'ask', '--question', question, '--out', out, '--timeout', '0');
      assert.equal((await record(out)).state, 'submitted');
      const before = Number(await count());
      await home();
      initialHistory = mode;
      try {
        await cli('collect', '--out', out, '--timeout', '5000');
        assert.equal((await record(out)).state, 'completed');
        assert((await readFile(out, 'utf8')).includes(question));
        assert.equal(Number(await count()), before);
        if (mode !== 'busy-container') {
          await home();
          const next = `AFTER-LOADING-${mode}`, follow = await ask(next, '--continue-from', out);
          assert((await readFile(follow, 'utf8')).includes(`${question} | ${next}`));
          assert.equal(Number(await count()), before + 1);
        }
      } finally {
        initialHistory = null;
      }
    }
  });
  console.log('Continuation evidence: '+evidence);
});
