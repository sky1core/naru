import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';
import { Browser } from './browser.mjs';
import { startServer } from './server.mjs';
import { defaultProfile, prepareProfile, writePrivateJSON } from './profile.mjs';
import { readProject } from './project.mjs';
import { permissionPolicy } from './permissions.mjs';
import { isWebURL } from './protocol.mjs';

process.on('uncaughtException', (error) => {
  console.error(error);
  app.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  app.exit(1);
});

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  profile: { type: 'string', default: defaultProfile },
  url: { type: 'string' },
  help: { type: 'boolean', default: false },
} });

if (values.help) {
  console.log('npm start -- [--profile <directory>] [--url <http(s) URL>]');
  app.exit(0);
} else {
  const profile = prepareProfile(values.profile);
  const project = readProject(profile);
  const initialURL = values.url !== undefined ? values.url : project !== null ? project.url : 'https://chatgpt.com/';
  if (!isWebURL(initialURL)) throw new Error('Initial URL must be HTTP(S) without credentials.');
  app.setName('Naru');
  app.setPath('userData', profile);
  app.setPath('sessionData', join(profile, 'chromium'));
  if (!app.requestSingleInstanceLock()) {
    console.error('An instance already owns this profile.');
    app.exit(1);
  } else {
    app.whenReady().then(async () => {
    const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webSecurity: true,
      preload: fileURLToPath(new URL('./input-guard.cjs', import.meta.url)) };
    const window = new BrowserWindow({ width: 1180, height: 820, title: 'Naru', webPreferences: preferences });
    const browser = new Browser(window);
    ipcMain.on('chatgpt-relay-frame-guard', (event, type, token) => {
      event.returnValue = browser.guardFrame(event.sender, event.senderFrame, type, token);
    });
    const protect = (contents) => {
      contents.on('will-navigate', (event, url) => { if (!isWebURL(url)) event.preventDefault(); });
      contents.on('will-redirect', (event, url) => { if (!isWebURL(url)) event.preventDefault(); });
      contents.on('will-attach-webview', (event) => event.preventDefault());
      contents.setWindowOpenHandler(({ url }) => isWebURL(url)
        ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: preferences } }
        : { action: 'deny' });
      contents.on('did-create-window', (child) => protect(child.webContents));
    };
    protect(window.webContents);
    const permissions = permissionPolicy();
    window.webContents.session.setPermissionCheckHandler((_contents, permission, origin) => permissions.get(permission, origin) === true);
    window.webContents.session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (!isWebURL(details.requestingUrl) || !contents || contents.isDestroyed()) return callback(false);
      const decision = permissions.get(permission, details.requestingUrl);
      if (decision !== undefined) return callback(decision);
      const owner = BrowserWindow.fromWebContents(contents);
      if (!owner || owner.isDestroyed()) return callback(false);
      console.error(JSON.stringify({ event: 'permission_request', permission, origin: new URL(details.requestingUrl).origin }));
      const result = await dialog.showMessageBox(owner, { type: 'question', title: 'Naru',
        message: `${new URL(details.requestingUrl).origin} 요청: ${permission}`, buttons: ['거부', '이번 실행 동안 허용'], defaultId: 0, cancelId: 0 });
      const allowed = result.response === 1 && !contents.isDestroyed();
      permissions.set(permission, details.requestingUrl, allowed);
      callback(allowed);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Naru', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'Browser', submenu: [
        { label: '뒤로', accelerator: 'Alt+Left', click: () => { if (window.webContents.navigationHistory.canGoBack()) window.webContents.navigationHistory.goBack(); } },
        { label: '앞으로', accelerator: 'Alt+Right', click: () => { if (window.webContents.navigationHistory.canGoForward()) window.webContents.navigationHistory.goForward(); } },
        { role: 'reload' }, { role: 'togglefullscreen' },
      ] },
    ]));
    app.on('second-instance', () => { window.show(); window.focus(); });
    app.on('window-all-closed', () => app.quit());
    window.on('closed', () => app.quit());
    const { server, descriptor } = await startServer({ browser, profile, quit: () => app.quit() });
    const descriptorPath = join(profile, 'connection.json');
    writePrivateJSON(descriptorPath, descriptor);
    app.on('will-quit', () => {
      server.close();
      try { unlinkSync(descriptorPath); } catch (error) { if (error.code !== 'ENOENT') console.error(error); }
    });
    try { await window.loadURL(initialURL); }
    catch (error) { console.error(JSON.stringify({ event: 'initial_navigation_failed', message: error.message })); }
    console.log(JSON.stringify({ event: 'ready', origin: descriptor.origin, profile }));
    }).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  }
}
