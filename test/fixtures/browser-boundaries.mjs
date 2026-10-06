import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Browser } from '../../src/browser.mjs';
import { Reviews } from '../../src/review.mjs';
import { writePrivateJSON } from '../../src/profile.mjs';
import { redactNavigationWarning } from '../../src/warnings.mjs';
import { startServer } from '../../src/server.mjs';
import { connect } from '../../src/client.mjs';

process.prependListener('warning', redactNavigationWarning);

const root = process.argv[2], profile = join(root, 'profile');
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setPath('sessionData', join(profile, 'chromium'));
let phase = 'app-ready';
let activeBrowser;
const step = name => { phase = name; console.log(JSON.stringify({ phase })); };
const timer = setTimeout(() => {
  console.error(JSON.stringify({ timeoutPhase: phase, input: activeBrowser?.diagnostics().lastInput }));
  app.quit();
}, 90000);

app.whenReady().then(async () => {
  step('fixture-start');
  const results = [];
  const fixture = `<!doctype html><meta charset="utf-8"><style>body{margin:40px}textarea{width:600px;height:100px}button{width:160px;height:60px}pre{white-space:pre-wrap}</style>
    <form><textarea id="prompt-textarea"></textarea><input type="file" id="upload"><button type="submit" data-testid="send-button">Send</button></form><div id="messages"></div>
    <script>globalThis.received=null;globalThis.eventLog=[];const send=document.querySelector('button');
    send.onpointerdown=()=>{const dt=new DataTransfer();dt.items.add(new File(['unselected attachment'],'private.txt'));document.querySelector('#upload').files=dt.files;};
    for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])send.addEventListener(type,e=>eventLog.push({type,trusted:e.isTrusted}));
    document.querySelector('form').onsubmit=e=>{e.preventDefault();globalThis.received=[...document.querySelector('#upload').files].map(f=>f.name);};</script>`;
  const server = createServer((req, res) => {
    if (req.url.startsWith('/abort')) { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(fixture);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, projectId = 'g-p-0123456789abcdef0123456789abcdef';
  const project = { version: 1, id: projectId, origin, url: `${origin}/g/${projectId}/project` };
  writePrivateJSON(join(profile, 'project.json'), project);
  const window = new BrowserWindow({ width: 1000, height: 700, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webSecurity: true,
    preload: new URL('../../src/input-guard.cjs', import.meta.url).pathname,
  } });
  const browser = new Browser(window);
  activeBrowser = browser;
  ipcMain.on('chatgpt-relay-frame-guard', (event, type, token) => { event.returnValue = browser.guardFrame(event.sender, event.senderFrame, type, token); });
  const api = await startServer({ browser, profile, quit: () => app.quit() });
  writePrivateJSON(join(profile, 'connection.json'), api.descriptor);
  const call = await connect(profile);
  try {
    step('initial-load');
    await window.loadURL(project.url);
    step('late-attachment');
    const before = await browser.reviewView();
    const reviewId = randomUUID();
    await call('/v1/commands', { id: randomUUID(), command: { action: 'review.prepare', reviewId, question: 'intended review', files: [] } });
    let error;
    step('attachment-pointer');
    try { await call('/v1/commands', { id: randomUUID(), deadlineMs: 10000,
      command: { action: 'review.submit', reviewId, documentId: browser.documentId } }); }
    catch (failure) { error = failure.code; }
    step('attachment-result');
    const received = await window.webContents.executeJavaScript('globalThis.received');
    const events = await window.webContents.executeJavaScript('globalThis.eventLog');
    results.push({ name: 'an attachment added during pointer delivery prevents submission',
      passed: before.attachments === false && (await browser.reviewView()).attachments === true && received === null && error === 'target_changed' && events.some(e => e.trusted), received, error, events });

    step('link-identity');
    await window.loadURL(`${origin}/g/${projectId}/c/${randomUUID()}`);
    const reviews = new Reviews(profile, browser);
    let record = reviews.prepare({ reviewId: randomUUID(), question: 'Review https://source.example/path', files: [] });
    record = reviews.save(record, { origin, project, baselineIds: [], startURL: window.webContents.getURL(), state: 'submitted' });
    await window.webContents.executeJavaScript(`(()=>{const prompt=${JSON.stringify(record.prompt)},needle='https://source.example/path',at=prompt.indexOf(needle);
      const msg=document.createElement('div');msg.dataset.messageId='user';msg.dataset.messageAuthorRole='user';const body=document.createElement('pre');body.dataset.testid='collapsible-user-message-content';
      body.append(document.createTextNode(prompt.slice(0,at)));const link=document.createElement('a');link.id='source-link';link.href=needle;link.textContent=needle;
      body.append(link,document.createTextNode(prompt.slice(at+needle.length)));msg.append(body);document.querySelector('#messages').append(msg);})()`);
    const original = reviews.identifyRequest(record, await browser.reviewView());
    await window.webContents.executeJavaScript(`document.querySelector('#source-link').href='https://changed.example/path'`);
    error = undefined;
    try { reviews.identifyRequest(record, await browser.reviewView()); } catch (failure) { error = failure.code; }
    results.push({ name: 'the rendered link destination must match its source URL', passed: Boolean(original) && error === 'review_content_mismatch', error });

    await window.webContents.executeJavaScript(`(()=>{const old=document.querySelector('[data-testid="collapsible-user-message-content"]');
      const body=document.createElement('div');body.dataset.testid='collapsible-user-message-content';body.style.whiteSpace='pre-wrap';body.append(...old.childNodes);old.replaceWith(body);
      const link=document.querySelector('#source-link');link.href='https://source.example/path';const code=document.createElement('code');link.replaceWith(code);code.append(link);})()`);
    error = undefined;
    try { reviews.identifyRequest(record, await browser.reviewView()); } catch (failure) { error = failure.code; }
    results.push({ name: 'display-only inline code preserves an unchanged link', passed: error === undefined, error });

    for (const wrapper of [false, true]) for (const inlineCode of [false, true]) for (const changed of [false, true]) {
      let linked = reviews.prepare({ reviewId: randomUUID(), question: 'Review https://source.example/path now.', files: [] });
      linked = reviews.save(linked, { origin, project, baselineIds: [], baselineHistory: [], startURL: window.webContents.getURL(), state: 'submitted' });
      await window.webContents.executeJavaScript(`(()=>{const prompt=${JSON.stringify(linked.prompt)},needle='https://source.example/path',at=prompt.indexOf(needle);
        const messages=document.querySelector('#messages');messages.replaceChildren();
        const turn=document.createElement('section');turn.dataset.testid='conversation-turn-user';messages.append(turn);
        const user=document.createElement('div');user.dataset.messageId='user';user.dataset.messageAuthorRole='user';user.style.whiteSpace='pre-wrap';turn.append(user);
        const body=${wrapper}?document.createElement('div'):user;if(${wrapper}){body.dataset.testid='collapsible-user-message-content';user.append(body);}
        const link=document.createElement('a');link.href=${JSON.stringify(changed ? 'https://changed.example/path' : 'https://source.example/path')};link.textContent=needle;
        let displayed=link;if(${inlineCode}){displayed=document.createElement('code');displayed.append(link);}
        body.append(document.createTextNode(prompt.slice(0,at)),displayed,document.createTextNode(prompt.slice(at+needle.length)));
        const response=document.createElement('section');response.dataset.testid='conversation-turn-assistant';messages.append(response);
        const answer=document.createElement('div');answer.dataset.messageId='answer';answer.dataset.messageAuthorRole='assistant';answer.style.whiteSpace='pre-wrap';
        answer.textContent='answer\\nEND-OF-REVIEW:'+${JSON.stringify(linked.id)};
        const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='Copy';response.append(answer,copy);})()`);
      const view = await browser.reviewView();
      let state;
      error = undefined;
      try { state = (await call('/v1/commands', { id: randomUUID(), deadlineMs: 5000,
        command: { action: 'review.collect', reviewId: linked.id, waitMs: 1000 } })).result.state; }
      catch (failure) { error = failure.code; }
      const user = view.messages[0], start = linked.prompt.indexOf('https://source.example/path');
      results.push({ name: `${wrapper ? 'wrapped' : 'bare'} ${inlineCode ? 'inline code' : 'text'} ${changed ? 'rejects a changed' : 'accepts an original'} link through HTTP collect`,
        passed: user.text === linked.prompt && JSON.stringify(user.links) === JSON.stringify([{ start, end: start + 'https://source.example/path'.length,
          href: changed ? 'https://changed.example/path' : 'https://source.example/path' }]) &&
          JSON.stringify(user.inlineCode) === JSON.stringify(inlineCode ? [{ start, end: start + 'https://source.example/path'.length }] : []) &&
          (changed ? error === 'review_content_mismatch' : state === 'completed'), state, error, links: user.links, inlineCode: user.inlineCode });
    }

    step('rendering');
    const urlCases = [];
    for (const punctuation of ['.', '?', ';']) {
      const url = `https://source.example/file${punctuation}`;
      for (const label of [url, url.slice(0, -1)]) urlCases.push({
        name: `${punctuation} preserved after a displayed link`, content: url, label, rejected: false });
    }
    for (const [name, content, labels] of [
      ['adjacent quotation', 'Read ("docs"https://source.example/file) now.',
        ['https://source.example/file', 'https://source.example/file)']],
      ['particle and quoted word', "Read 'https://source.example/file'를'확인' 하세요.",
        ['https://source.example/file', "https://source.example/file'를'확인"]],
      ['internal apostrophe', "Read 'https://source.example/a-'b.' now.", ["https://source.example/a-'b."]],
      ['container HTML', '> Read <span\n> title="`">label</span> `https://source.example/file.` now.', ['https://source.example/file.']],
      ['backticks in address', 'Read "https://source.example/a`b`c." now.', ['https://source.example/a`b`c.']],
      ['Unicode apostrophe', "Read 'https://source.example/한글'한글.' now.", ["https://source.example/한글'한글."]],
      ['code fence', ['```js', 'const marker = "```";', 'const url = "https://source.example/file.";', '```'].join('\n'),
        ['https://source.example/file.']],
      ['nested parentheses', 'Read https://source.example/(one(two))/three now.', ['https://source.example/(one(two))/three']],
    ]) for (const label of labels) urlCases.push({ name, content, label, rejected: false });
    for (const changed of [false, true]) {
      urlCases.push({ name: `${changed ? 'changed' : 'exact'} inline code after a URL backtick`,
        content: 'Read https://source.example/a`b and `ok` now.', label: 'https://source.example/a`b', rejected: changed,
        inlineCode: { source: '`ok`', text: changed ? 'changed' : 'ok' } });
      const statement = "const url = 'https://source.example/file.';";
      urlCases.push({ name: `${changed ? 'changed' : 'exact'} displayed inline source code`,
        content: 'Read `' + statement + '` now.', label: 'https://source.example/file', rejected: changed,
        inlineCode: { source: '`' + statement + '`', text: changed ? statement.replace('const', 'let') : statement } });
    }
    const address = 'https://example.com/a';
    for (const changed of [false, true]) {
      for (const [name, content, label] of [
        ['escaped wrapper label', address + '](b)', address + '\\](b)'],
        ['wrapper internal partial match', address + '](' + address + ')', address + '](' + address + ')'],
      ]) {
        const displayed = '[' + label + '](' + content + (changed ? '#changed' : '') + ')';
        urlCases.push({ name: `${changed ? 'changed' : 'exact'} ${name}`, content, label: displayed,
          replacement: { from: content, to: displayed }, literal: true, rejected: changed });
      }
      urlCases.push({ name: `${changed ? 'changed' : 'exact'} link ending inside displayed backslashes`,
        content: address + '\\tail', label: address + '\\'.repeat(2),
        replacement: { from: address + '\\'.repeat(2), to: address + '\\'.repeat(4) },
        href: new URL(address + '\\'.repeat(changed ? 2 : 1)).href, rejected: changed });
    }
    for (const mode of ['text', 'pre-code']) for (const scenario of urlCases) {
      if (scenario.inlineCode && mode === 'pre-code') continue;
      let linked = reviews.prepare({ reviewId: randomUUID(), question: 'Review source', files: [{ path: 'source.txt',
        content: scenario.content, bytes: Buffer.byteLength(scenario.content), sha256: createHash('sha256').update(scenario.content).digest('hex') }] });
      linked = reviews.save(linked, { origin, project, baselineIds: [], baselineHistory: [], startURL: window.webContents.getURL(), state: 'submitted' });
      let expectedText = scenario.inlineCode ? linked.prompt.replace(scenario.inlineCode.source, scenario.inlineCode.text) : linked.prompt;
      if (scenario.replacement) expectedText = expectedText.replace(scenario.replacement.from, scenario.replacement.to);
      await window.webContents.executeJavaScript(`(()=>{const prompt=${JSON.stringify(expectedText)},label=${JSON.stringify(scenario.label)},at=prompt.indexOf(label),inline=${JSON.stringify(scenario.inlineCode ?? null)};
        const messages=document.querySelector('#messages');messages.replaceChildren();
        const turn=document.createElement('section');turn.dataset.testid='conversation-turn-user';messages.append(turn);
        const user=document.createElement('div');user.dataset.messageId='user';user.dataset.messageAuthorRole='user';user.style.whiteSpace='pre-wrap';turn.append(user);
        let body=user;if(${JSON.stringify(mode)}==='pre-code'){const pre=document.createElement('pre');body=document.createElement('code');pre.append(body);user.append(pre);}
        const link=${Boolean(scenario.literal)}?document.createTextNode(label):document.createElement('a');
        if(!${Boolean(scenario.literal)}){link.href=${JSON.stringify(scenario.href ?? scenario.label)};link.textContent=label;}
        const appendRange=(node,start,end)=>{if(at>=start&&at+label.length<=end)node.append(document.createTextNode(prompt.slice(start,at)),link,document.createTextNode(prompt.slice(at+label.length,end)));
          else node.append(document.createTextNode(prompt.slice(start,end)));};
        if(inline){const start=prompt.indexOf(inline.text),end=start+inline.text.length,code=document.createElement('code');
          appendRange(body,0,start);appendRange(code,start,end);body.append(code);appendRange(body,end,prompt.length);
        }else body.append(document.createTextNode(prompt.slice(0,at)),link,document.createTextNode(prompt.slice(at+label.length)));
        const response=document.createElement('section');response.dataset.testid='conversation-turn-assistant';messages.append(response);
        const answer=document.createElement('div');answer.dataset.messageId='answer';answer.dataset.messageAuthorRole='assistant';answer.style.whiteSpace='pre-wrap';
        answer.textContent='answer\\nEND-OF-REVIEW:'+${JSON.stringify(linked.id)};
        const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';copy.textContent='Copy';response.append(answer,copy);})()`);
      const view = await browser.reviewView();
      let state;
      error = undefined;
      try { state = (await call('/v1/commands', { id: randomUUID(), deadlineMs: 5000,
        command: { action: 'review.collect', reviewId: linked.id, waitMs: 1000 } })).result.state; }
      catch (failure) { error = failure.code; }
      results.push({ name: `${mode} ${scenario.name} through HTTP collect`,
        passed: view.messages[0].text === expectedText && (scenario.rejected ? error === 'review_content_mismatch' : state === 'completed'), state, error });
    }

    step('error-ownership');
    for (const layout of ['legacy', 'search-unit']) for (const owner of ['user', 'assistant']) {
      await window.webContents.executeJavaScript(`(()=>{const messages=document.querySelector('#messages');messages.replaceChildren();
        const turn=document.createElement('section');turn.dataset.contentSearchTurnKey='turn';messages.append(turn);
        for(const role of ['user','assistant']){const node=document.createElement('div');
          if(${JSON.stringify(layout)}==='legacy'){node.dataset.messageId=role;node.dataset.messageAuthorRole=role;}
          else{node.dataset.chatgptSearchUnitKey='turn:'+role;node.dataset.chatgptSearchMessageIds=role;}
          node.style.whiteSpace='pre-wrap';node.textContent=role==='user'?${JSON.stringify(record.prompt)}:'incomplete answer';
          if(role===${JSON.stringify(owner)}){const alert=document.createElement('div');alert.role='alert';alert.textContent='Synthetic error';
            const body=document.createElement('pre');body.textContent=node.textContent;node.textContent='';
            if(role==='user')body.dataset.testid='collapsible-user-message-content';else body.dataset.markdownTextStyle='assistant-message';
            node.append(body,alert);}
          turn.append(node);}})()`);
      const view = await browser.reviewView();
      error = undefined;
      try { reviews.assertPrevious(record, view); } catch (failure) { error = failure.code; }
      results.push({ name: `${layout} assigns an error only to its ${owner} message`,
        passed: view.messages.find(message => message.role === owner)?.error === 'Synthetic error' &&
          view.messages.find(message => message.role !== owner)?.error === '' &&
          (owner === 'user' ? error === 'response_failed' : error === undefined), error });
    }

    step('project-navigation');
    await window.loadURL(`${origin}/g/${projectId}/c/${randomUUID()}`);
    const opened = await call('/v1/commands', { id: randomUUID(), deadlineMs: 10000, command: { action: 'project.open' } });
    results.push({ name: 'an unchanged empty conversation can open a fresh project document', passed: opened.result.url === project.url });
    step('draft-navigation');
    await window.loadURL(`${origin}/g/${projectId}/c/${randomUUID()}`);
    const execute = window.webContents.executeJavaScriptInIsolatedWorld.bind(window.webContents);
    let inject = true;
    window.webContents.executeJavaScriptInIsolatedWorld = async (...args) => {
      const result = await execute(...args);
      if (inject && result?.composer && Object.hasOwn(result, 'draft')) {
        inject = false;
        await window.webContents.executeJavaScript(`document.querySelector('textarea').value='new unsaved draft'`);
      }
      return result;
    };
    error = undefined;
    try { await call('/v1/commands', { id: randomUUID(), deadlineMs: 10000, command: { action: 'project.open' } }); }
    catch (failure) { error = failure.code; }
    window.webContents.executeJavaScriptInIsolatedWorld = execute;
    const after = await browser.reviewView();
    results.push({ name: 'automatic navigation preserves a draft created after its snapshot',
      passed: error === 'draft_conflict' && after.draft === 'new unsaved draft' && after.url !== project.url, error, draft: after.draft });

    step('navigation-error');
    try { await call('/v1/commands', { id: randomUUID(), deadlineMs: 10000,
      command: { action: 'navigate', url: origin + '/abort?token=PRIVATE_QUERY_SAMPLE' } }); }
    catch (failure) { results.push({ name: 'navigation errors omit the query from their public message',
      passed: failure.code === 'navigation_failed' && !failure.message.includes('PRIVATE_QUERY_SAMPLE') &&
        !JSON.stringify(failure.record).includes('PRIVATE_QUERY_SAMPLE'), error: failure.code, message: failure.message }); }
    step('results');
    await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    window.close(); api.server.closeAllConnections();
    await Promise.all([new Promise(resolve => api.server.close(resolve)), new Promise(resolve => server.close(resolve))]);
    clearTimeout(timer); app.quit();
  }
}).catch(error => { console.error(error); clearTimeout(timer); app.quit(); });
