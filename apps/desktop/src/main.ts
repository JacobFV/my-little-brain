import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { config } from 'dotenv';
import { allowsBrowserMedia } from './browserPolicy';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

let window: BrowserWindow | null = null;
let server: Server | undefined;
let trustedOrigin = '';
let storageFailureShown = false;
let lastStorageRaw: string | null = null;
let storageReadable = true;
app.setName('My Little Brain');
const dev = !app.isPackaged && process.argv.includes('--dev');
const root = resolve(__dirname, '../../..');
const sameOrigin = (url: string) => {
  try {
    return new URL(url).origin === trustedOrigin;
  } catch {
    return false;
  }
};
const storagePath = () => join(app.getPath('userData'), 'workspace.json');
const trustedSender = (event: Electron.IpcMainEvent) =>
  !!window &&
  event.sender === window.webContents &&
  event.senderFrame === window.webContents.mainFrame &&
  sameOrigin(event.senderFrame.url);

// Chromium storage is origin-scoped; persist app data independently of the ephemeral port.
ipcMain.on('brain:restore-storage', (event) => {
  if (!trustedSender(event) || dev) {
    event.returnValue = null;
    return;
  }
  try {
    lastStorageRaw = existsSync(storagePath()) ? readFileSync(storagePath(), 'utf8') : null;
    const value = lastStorageRaw === null ? {} : JSON.parse(lastStorageRaw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.values(value).some((entry) => typeof entry !== 'string')
    )
      throw new Error('Invalid archive');
    event.returnValue = value;
  } catch {
    storageReadable = false;
    event.returnValue = null;
    dialog.showErrorBox(
      'Workspace could not be restored',
      'The saved workspace file could not be read. It has been left in your app data directory.',
    );
  }
});
ipcMain.on('brain:save-storage', (event, values: unknown) => {
  if (
    !trustedSender(event) ||
    dev ||
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values)
  ) {
    event.returnValue = false;
    return;
  }
  const entries = Object.entries(values);
  if (
    entries.some(
      ([key, value]) =>
        !key.startsWith('little-brain.') ||
        /token|secret|api.?key/i.test(key) ||
        typeof value !== 'string',
    )
  ) {
    event.returnValue = false;
    return;
  }
  const data = JSON.stringify(values);
  if (Buffer.byteLength(data) > 10 * 1024 * 1024) {
    event.returnValue = false;
    return;
  }
  try {
    const disk = existsSync(storagePath()) ? readFileSync(storagePath(), 'utf8') : null;
    if (!storageReadable || disk !== lastStorageRaw)
      throw new Error('Saved data changed outside this window; preserving both copies.');
    writeFileSync(`${storagePath()}.tmp`, data, { mode: 0o600 });
    renameSync(`${storagePath()}.tmp`, storagePath());
    lastStorageRaw = data;
    event.returnValue = true;
  } catch {
    event.returnValue = false;
    if (!storageFailureShown) {
      storageFailureShown = true;
      dialog.showErrorBox(
        'Workspace could not be saved',
        'Your changes are available in this window, but the app data directory could not be written. Export your thoughts before closing.',
      );
    }
  }
});

type BrowserSession = {
  browser: BrowserWindow;
  allowControl: boolean;
  startedAt: number;
  label: string;
  failed: boolean;
  focused: boolean;
  media: { audio: boolean; microphone: boolean; camera: boolean };
  mediaOrigin: string;
};
const browserWindows = new Map<string, BrowserSession>();
const safeBrowserUrl = (value: string) => {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Use an HTTPS address without embedded credentials.');
  return parsed;
};
function emitBrowser(
  id: string,
  entry: BrowserSession,
  status: 'active' | 'complete' | 'error',
  imageUrl?: string,
) {
  if (window && !window.isDestroyed() && sameOrigin(window.webContents.getURL()))
    window.webContents.send('brain:plugin-interaction', {
      id,
      pluginId: 'browser',
      kind: 'browser',
      label: entry.label,
      status,
      imageUrl,
      startedAt: entry.startedAt,
      allowControl: entry.allowControl,
      focused: entry.focused,
      media: entry.media,
      viewport: entry.browser.isDestroyed() ? undefined : entry.browser.getContentBounds(),
    });
}
ipcMain.handle('brain:open-browser', async (event, target: unknown, options: unknown) => {
  if (!trustedSender(event as unknown as Electron.IpcMainEvent) || typeof target !== 'string')
    throw new Error('Untrusted browser request.');
  if (browserWindows.size >= 8) throw new Error('Close a browser session before opening another.');
  const destination = safeBrowserUrl(target);
  const requestedId =
    options && typeof options === 'object' && 'interactionId' in options
      ? options.interactionId
      : undefined;
  const id =
    typeof requestedId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(requestedId)
      ? requestedId
      : crypto.randomUUID();
  if (browserWindows.has(id)) throw new Error('This browser interaction already exists.');
  const isolated = session.fromPartition(`brain-browser-${id}`);
  isolated.on('will-download', (event) => event.preventDefault());
  const allowControl =
    !!options &&
    typeof options === 'object' &&
    'allowControl' in options &&
    options.allowControl === true;
  const browser = new BrowserWindow({
    width: 1100,
    height: 800,
    title: allowControl
      ? 'Little Brain · brain-controlled browser'
      : 'Little Brain · isolated browser',
    backgroundColor: '#f9f3f5',
    webPreferences: {
      session: isolated,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  const entry: BrowserSession = {
    browser,
    allowControl,
    startedAt: Date.now(),
    label: destination.hostname,
    failed: false,
    focused: false,
    media: { audio: false, microphone: false, camera: false },
    mediaOrigin: destination.origin,
  };
  browser.webContents.setAudioMuted(true);
  const mediaAllowed = (contents: Electron.WebContents | null, origin: string, type: string) =>
    allowsBrowserMedia(
      entry,
      contents === browser.webContents,
      contents?.getURL() ?? '',
      origin,
      type,
    );
  isolated.setPermissionRequestHandler((contents, permission, callback, details) => {
    const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    callback(
      permission === 'media' &&
        types.length > 0 &&
        types.every((type) => mediaAllowed(contents, details.requestingUrl, type)),
    );
  });
  isolated.setPermissionCheckHandler(
    (contents, permission, origin, details) =>
      permission === 'media' && mediaAllowed(contents, origin, details.mediaType ?? ''),
  );
  browser.webContents.on('did-navigate', (_event, url) => {
    const destination = new URL(url);
    const origin = destination.origin;
    entry.label = destination.hostname;
    if (entry.mediaOrigin !== origin) {
      entry.mediaOrigin = origin;
      entry.media = { audio: false, microphone: false, camera: false };
      browser.webContents.setAudioMuted(true);
      emitBrowser(id, entry, 'active');
    }
  });
  browserWindows.set(id, entry);
  emitBrowser(id, entry, 'active');
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event: Electron.Event, url: string) => {
    try {
      safeBrowserUrl(url);
    } catch {
      event.preventDefault();
    }
  };
  browser.webContents.on('will-navigate', guard);
  browser.webContents.on('will-redirect', guard);
  browser.webContents.on('will-attach-webview', (event) => event.preventDefault());
  let capturing = false;
  let lastCapture = 0;
  const capture = async () => {
    if (
      capturing ||
      browser.isDestroyed() ||
      entry.failed ||
      Date.now() - lastCapture < (entry.focused ? 120 : 1000)
    )
      return;
    lastCapture = Date.now();
    capturing = true;
    try {
      const frame = await browser.webContents.capturePage();
      if (!browser.isDestroyed() && !frame.isEmpty())
        emitBrowser(
          id,
          entry,
          'active',
          `data:image/jpeg;base64,${frame
            .resize({ width: Math.min(entry.focused ? 1200 : 512, frame.getSize().width) })
            .toJPEG(65)
            .toString('base64')}`,
        );
    } catch {
      /* The page may be navigating or closing. */
    } finally {
      capturing = false;
    }
  };
  const timer = setInterval(() => {
    void capture();
  }, 125);
  browser.on('closed', () => {
    clearInterval(timer);
    browserWindows.delete(id);
    if (!entry.failed) emitBrowser(id, entry, 'complete');
    void isolated.clearStorageData();
  });
  browser.webContents.on('render-process-gone', () => {
    entry.failed = true;
    emitBrowser(id, entry, 'error');
  });
  try {
    await browser.loadURL(destination.href);
    void capture();
    return { id, instanceId: id, allowControl };
  } catch {
    entry.failed = true;
    emitBrowser(id, entry, 'error');
    browser.close();
    throw new Error('The isolated browser could not load that address.');
  }
});
async function performBrowserAction(
  event: Electron.IpcMainInvokeEvent,
  request: unknown,
  manual = false,
) {
  if (
    !trustedSender(event as unknown as Electron.IpcMainEvent) ||
    !request ||
    typeof request !== 'object'
  )
    throw new Error('Untrusted browser request.');
  const command = request as Record<string, unknown>;
  const entry =
    typeof command.instanceId === 'string' ? browserWindows.get(command.instanceId) : undefined;
  if (!entry || entry.browser.isDestroyed()) throw new Error('This browser session is closed.');
  if (manual && !entry.focused)
    throw new Error('Focus this browser object before using its controls.');
  if (!manual && !entry.allowControl)
    throw new Error('Brain control was not enabled for this browser session.');
  const contents = entry.browser.webContents;
  const bounds = entry.browser.getContentBounds();
  if (command.action === 'navigate') {
    if (typeof command.url !== 'string') throw new Error('A URL is required.');
    await contents.loadURL(safeBrowserUrl(command.url).href);
  } else if (command.action === 'click') {
    const x = command.x,
      y = command.y;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= bounds.width ||
      y >= bounds.height
    )
      throw new Error('Click coordinates must be inside this browser viewport.');
    entry.browser.focus();
    contents.focus();
    contents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      x: Math.round(x),
      y: Math.round(y),
    });
    contents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      x: Math.round(x),
      y: Math.round(y),
    });
  } else if (command.action === 'type') {
    if (typeof command.text !== 'string' || command.text.length > 4000)
      throw new Error('Type at most 4000 characters.');
    entry.browser.focus();
    contents.focus();
    await contents.insertText(command.text);
  } else if (command.action === 'scroll') {
    if (typeof command.deltaY !== 'number' || !Number.isFinite(command.deltaY))
      throw new Error('A finite scroll distance is required.');
    entry.browser.focus();
    contents.focus();
    contents.sendInputEvent({
      type: 'mouseWheel',
      x: Math.floor(bounds.width / 2),
      y: Math.floor(bounds.height / 2),
      deltaY: Math.max(-1000, Math.min(1000, command.deltaY)),
      deltaX: 0,
    });
  } else if (command.action === 'key' && manual) {
    const allowed = [
      'Enter',
      'Tab',
      'Escape',
      'Backspace',
      'Delete',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ];
    if (
      typeof command.key !== 'string' ||
      (!allowed.includes(command.key) && !/^[a-zA-Z0-9]$/.test(command.key))
    )
      throw new Error('Unsupported keyboard key.');
    const modifiers = Array.isArray(command.modifiers) ? command.modifiers : [];
    if (modifiers.some((value) => !['shift', 'control', 'alt', 'meta'].includes(value)))
      throw new Error('Unsupported keyboard modifier.');
    const keyCode = command.key.replace('Arrow', '');
    entry.browser.focus();
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  } else if (command.action !== 'read') throw new Error('Unsupported browser action.');
  const result = await contents.executeJavaScript(
    `JSON.stringify({url:location.href,title:document.title,text:document.body?.innerText.slice(0,12000),viewport:{width:innerWidth,height:innerHeight},screenshot:{width:Math.min(${entry.focused ? 1200 : 512},innerWidth),height:Math.round(innerHeight*Math.min(${entry.focused ? 1200 : 512},innerWidth)/innerWidth)},controls:Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]')).slice(0,100).map(element=>{const rect=element.getBoundingClientRect();return {tag:element.tagName,label:(element.getAttribute('aria-label')||element.textContent||element.getAttribute('placeholder')||'').slice(0,150),x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2),visible:rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight}})})`,
  );
  if (window && !window.isDestroyed()) window.focus();
  return result;
}
ipcMain.handle('brain:browser-action', (event, request) => performBrowserAction(event, request));
ipcMain.handle('brain:manual-browser-action', (event, request) =>
  performBrowserAction(event, request, true),
);
function requestedBrowser(event: Electron.IpcMainInvokeEvent, id: unknown) {
  if (!trustedSender(event as unknown as Electron.IpcMainEvent))
    throw new Error('Untrusted browser request.');
  const entry = typeof id === 'string' ? browserWindows.get(id) : undefined;
  if (!entry || entry.browser.isDestroyed()) throw new Error('This browser session is closed.');
  return entry;
}
function unfocusBrowser(id: string, entry: BrowserSession) {
  const capturingMedia = entry.media.microphone || entry.media.camera;
  entry.focused = false;
  entry.browser.webContents.setBackgroundThrottling(true);
  entry.media = { audio: false, microphone: false, camera: false };
  entry.browser.webContents.setAudioMuted(true);
  if (capturingMedia) entry.browser.webContents.reload();
  emitBrowser(id, entry, 'active');
}
ipcMain.handle('brain:set-browser-focused', (event, id: unknown, focused: unknown) => {
  const entry = requestedBrowser(event, id);
  if (typeof focused !== 'boolean') throw new Error('A focus state is required.');
  if (focused) {
    for (const [otherId, other] of browserWindows)
      if (other !== entry && other.focused) unfocusBrowser(otherId, other);
    entry.focused = true;
    entry.browser.webContents.setBackgroundThrottling(false);
  } else unfocusBrowser(id as string, entry);
  emitBrowser(id as string, entry, 'active');
});
ipcMain.handle('brain:show-browser', (event, id: unknown) => {
  const entry = requestedBrowser(event, id);
  entry.browser.show();
  entry.browser.focus();
});
ipcMain.handle('brain:set-browser-media', (event, id: unknown, value: unknown) => {
  const entry = requestedBrowser(event, id);
  if (!entry.focused || !value || typeof value !== 'object')
    throw new Error('Focus the browser before changing media access.');
  const previous = { ...entry.media };
  for (const key of ['audio', 'microphone', 'camera'] as const)
    if (key in value && typeof (value as Record<string, unknown>)[key] !== 'boolean')
      throw new Error('Media switches must be boolean.');
  for (const key of ['audio', 'microphone', 'camera'] as const)
    if (key in value) entry.media[key] = (value as Record<string, boolean>)[key];
  entry.mediaOrigin = safeBrowserUrl(entry.browser.webContents.getURL()).origin;
  entry.browser.webContents.setAudioMuted(!entry.media.audio);
  // Reload terminates any existing tracks immediately when an explicit device grant is removed.
  if ((previous.microphone && !entry.media.microphone) || (previous.camera && !entry.media.camera))
    entry.browser.webContents.reload();
  emitBrowser(id as string, entry, 'active');
  return { ...entry.media };
});
async function start() {
  config({ path: app.isPackaged ? join(app.getPath('userData'), '.env') : join(root, '.env') });
  let url = 'http://localhost:5173';
  if (!dev) {
    const resources = app.isPackaged ? process.resourcesPath : join(root, 'apps');
    const serverPath = app.isPackaged
      ? join(resources, 'server/index.js')
      : join(resources, 'server/dist/index.js');
    // Preserve native import so the bundled ESM server works from CommonJS main.
    const { startServer } = await import(pathToFileURL(serverPath).href);
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      staticDir: app.isPackaged ? join(resources, 'web') : join(resources, 'web/dist'),
    });
    const address = server!.address();
    if (!address || typeof address === 'string')
      throw new Error('Local server did not bind a TCP port.');
    url = `http://127.0.0.1:${address.port}`;
  }
  trustedOrigin = new URL(url).origin;
  const trustedContents = (contents: Electron.WebContents | null) =>
    !!contents && contents === window?.webContents && sameOrigin(contents.getURL());
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    callback(
      trustedContents(contents) &&
        permission === 'media' &&
        sameOrigin(details.requestingUrl) &&
        mediaTypes.length > 0 &&
        mediaTypes.every((type) => type === 'audio' || type === 'video'),
    );
  });
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      trustedContents(contents) &&
      permission === 'media' &&
      sameOrigin(requestingOrigin) &&
      (details.mediaType === 'audio' || details.mediaType === 'video'),
  );
  createWindow(url);
  app.on('activate', () => {
    if (!window) createWindow(url);
  });
}

function createWindow(url: string) {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'My Little Brain',
    backgroundColor: '#f7f8f5',
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (!sameOrigin(target)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (!sameOrigin(target)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = null;
  });
  void window.loadURL(url).catch((error) => {
    dialog.showErrorBox('Could not open My Little Brain', String(error));
    app.quit();
  });
}

for (const channel of ['brain:minimize', 'brain:toggle-maximize', 'brain:close']) {
  ipcMain.on(channel, (event) => {
    if (!window || !trustedSender(event)) return;
    if (channel === 'brain:minimize') window.minimize();
    if (channel === 'brain:toggle-maximize')
      window.isMaximized() ? window.unmaximize() : window.maximize();
    if (channel === 'brain:close') window.close();
  });
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  server?.close();
  server?.closeAllConnections();
});
void app
  .whenReady()
  .then(start)
  .catch((error) => {
    dialog.showErrorBox('My Little Brain could not start', String(error));
    app.quit();
  });
