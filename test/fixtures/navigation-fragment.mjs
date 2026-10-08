import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Browser } from '../../src/browser.mjs';
import { writePrivateJSON } from '../../src/profile.mjs';
import { startServer } from '../../src/server.mjs';
import { connect } from '../../src/client.mjs';

const root = process.argv[2], profile = join(root, 'profile');
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setPath('sessionData', join(profile, 'chromium'));
let phase = 'app-ready';
const timer = setTimeout(() => { console.error(JSON.stringify({ timeoutPhase: phase })); process.exitCode = 1; app.quit(); }, 35000);

app.whenReady().then(async () => {
  const results = [], requests = [];
  const projectId = 'g-p-0123456789abcdef0123456789abcdef';
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.end(`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><style>body{margin:30px}div{white-space:pre-wrap}</style>
      <div data-app-action-sidebar-project-id="${projectId}"></div>
      <form><textarea id="prompt-textarea"></textarea><input type="file"><button type="submit" data-testid="send-button">Send</button></form>
      <div id="messages"></div><script>globalThis.loadIdentity=${JSON.stringify(randomUUID())}</script>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, home = `${origin}/g/${projectId}/project`;
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
  } });
  window.showInactive();
  window.blur();
  const browser = new Browser(window);
  const api = await startServer({ browser, profile, quit: () => app.quit() });
  writePrivateJSON(join(profile, 'connection.json'), api.descriptor);
  const call = await connect(profile);
  const post = command => call('/v1/commands', { id: randomUUID(), deadlineMs: 5000, command });
  const identity = () => window.webContents.executeJavaScript('globalThis.loadIdentity');
  try {
    for (const [name, current, saved] of [
      ['identical fragment', '#saved', '#saved'],
      ['different fragment', '#old', '#saved'],
      ['fragment added', '', '#saved'],
      ['empty fragment', '#old', '#'],
      ['fragment removed', '#old', ''],
      ['identical query and fragment', '?view=home#saved', '?view=home#saved'],
      ['changed query and fragment', '?view=old#saved', '?view=home#saved'],
      ['identical query', '?view=home', '?view=home'],
      ['plain home', '', ''],
    ]) {
      phase = name;
      await window.loadURL(home + saved);
      const bound = (await post({ action: 'project.bind', documentId: browser.documentId })).result;
      await window.loadURL(home + current);
      const before = { documentId: browser.documentId, loadIdentity: await identity(), requests: requests.length };
      let result, error;
      try { result = (await post({ action: 'project.open' })).result; } catch (failure) { error = failure.code; }
      const afterIdentity = await identity(), persisted = await call('/v1/project');
      results.push({ name: `${name} loads a fresh document and preserves its binding`,
        passed: error === undefined && result?.url === bound.url && result?.documentId !== before.documentId &&
          afterIdentity !== before.loadIdentity && requests.slice(before.requests).includes(new URL(bound.url).pathname + new URL(bound.url).search) &&
          JSON.stringify(persisted) === JSON.stringify(bound), error, url: result?.url, freshDocument: afterIdentity !== before.loadIdentity });
    }

    for (const [name, mutation, expectedError] of [
      ['draft', `document.querySelector('textarea').value='new unsaved draft'`, 'draft_conflict'],
      ['attachment', `const dt=new DataTransfer();dt.items.add(new File(['private'],'private.txt'));document.querySelector('input').files=dt.files`, 'draft_conflict'],
      ['generation', `const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.body.append(stop)`, 'draft_conflict'],
      ['history', `const message=document.createElement('div');message.dataset.messageId='new-message';message.dataset.messageAuthorRole='user';message.textContent='new history';document.querySelector('#messages').append(message)`, 'conversation_changed'],
    ]) {
      phase = `late-${name}`;
      await window.loadURL(home + `?case=${name}#saved`);
      await post({ action: 'project.bind', documentId: browser.documentId });
      const before = { documentId: browser.documentId, loadIdentity: await identity(), requests: requests.length };
      const execute = window.webContents.executeJavaScriptInIsolatedWorld.bind(window.webContents);
      let inject = true, error;
      window.webContents.executeJavaScriptInIsolatedWorld = async (...args) => {
        const result = await execute(...args);
        if (inject && result?.composer && Object.hasOwn(result, 'draft')) {
          inject = false;
          await window.webContents.executeJavaScript(`(()=>{${mutation}})()`);
        }
        return result;
      };
      try { await post({ action: 'project.open' }); } catch (failure) { error = failure.code; }
      finally { window.webContents.executeJavaScriptInIsolatedWorld = execute; }
      const view = await browser.reviewView(), afterIdentity = await identity();
      const preserved = name === 'draft' ? view.draft === 'new unsaved draft'
        : name === 'attachment' ? view.attachments === true : name === 'generation' ? view.busy === true
        : view.messages.some(message => message.text === 'new history');
      results.push({ name: `a late ${name} change prevents fragment navigation without losing work`,
        passed: error === expectedError && preserved && browser.documentId === before.documentId &&
          afterIdentity === before.loadIdentity && requests.length === before.requests, error, preserved });
    }
    await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2));
  } finally {
    window.close(); api.server.closeAllConnections();
    await Promise.all([new Promise(resolve => api.server.close(resolve)), new Promise(resolve => server.close(resolve))]);
    clearTimeout(timer); app.quit();
  }
}).catch(error => { console.error(error); process.exitCode = 1; clearTimeout(timer); app.quit(); });
