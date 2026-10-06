import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';
import { Browser } from './browser.mjs';
import { startServer } from './server.mjs';
import { defaultProfile, prepareProfile, writePrivateJSON } from './profile.mjs';
import { readProject } from './project.mjs';
import { permissionDetails, permissionPolicy } from './permissions.mjs';
import { isWebURL } from './protocol.mjs';
import { redactNavigationWarning } from './warnings.mjs';

process.prependListener('warning', redactNavigationWarning);

function reportError(event, message, error) {
  const record = { event, message };
  if (typeof error?.code === 'string' && /^(ERR_[A-Z0-9_]{1,64}|E[A-Z0-9]{1,31})$/.test(error.code)) record.code = error.code;
  if (Number.isInteger(error?.errno) && error.errno < 0 && error.errno >= -2147483648) record.errno = error.errno;
  console.error(JSON.stringify(record));
}

process.on('uncaughtException', (error) => {
  reportError('uncaught_exception', 'Unexpected application exception.', error);
  app.exit(1);
});
process.on('unhandledRejection', (error) => {
  reportError('unhandled_rejection', 'Unexpected application rejection.', error);
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
  app.setPath('userData', prepareProfile(join(app.getPath('appData'), 'Naru')));
  if (!app.requestSingleInstanceLock()) {
    console.error('Naru is already running.');
    app.exit(1);
  } else {
    app.setPath('userData', profile);
    app.setPath('sessionData', join(profile, 'chromium'));
    app.whenReady().then(async () => {
    const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webSecurity: true, backgroundThrottling: false,
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
    window.webContents.session.setPermissionCheckHandler((_contents, permission, origin, details) => {
      const scope = permission === 'media' ? { mediaTypes: [details?.mediaType] } : details;
      return permissions.get(permission, origin, scope) === true;
    });
    window.webContents.session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (!isWebURL(details?.requestingUrl) || !contents || contents.isDestroyed()) return callback(false);
      const decision = permissions.get(permission, details.requestingUrl, details);
      if (decision !== undefined) return callback(decision);
      const owner = BrowserWindow.fromWebContents(contents);
      if (!owner || owner.isDestroyed()) return callback(false);
      console.error(JSON.stringify({ event: 'permission_request', permission, origin: new URL(details.requestingUrl).origin }));
      const result = await dialog.showMessageBox(owner, { type: 'question', title: 'Naru',
        message: `${new URL(details.requestingUrl).origin} 요청: ${permission}`, detail: permissionDetails(permission, details).description,
        buttons: ['거부', '이번 실행 동안 허용'], defaultId: 0, cancelId: 0 });
      const allowed = result.response === 1 && !contents.isDestroyed();
      permissions.set(permission, details.requestingUrl, allowed, details);
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
    app.on('window-all-closed', () => app.quit());
    window.on('closed', () => app.quit());
    const { server, descriptor } = await startServer({ browser, profile, quit: () => app.quit() });
    const descriptorPath = join(profile, 'connection.json');
    writePrivateJSON(descriptorPath, descriptor);
    app.on('will-quit', () => {
      server.close();
      try { unlinkSync(descriptorPath); } catch (error) { if (error.code !== 'ENOENT') reportError('connection_cleanup_failed', 'Connection cleanup failed.', error); }
    });
    try { await window.loadURL(initialURL); }
    catch (error) { reportError('initial_navigation_failed', 'Initial navigation failed.', error); }
    console.log(JSON.stringify({ event: 'ready', origin: descriptor.origin, profile }));
    }).catch((error) => {
      reportError('initialization_failed', 'Application initialization failed.', error);
      app.exit(1);
    });
  }
}
