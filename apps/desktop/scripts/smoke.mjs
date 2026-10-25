import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executablePath = resolve(
  process.argv[2] || 'apps/desktop/release/linux-arm64-unpacked/@little-braindesktop',
);
const dataDir = await mkdtemp(join(tmpdir(), 'little-brain-desktop-smoke-'));
const options = {
  executablePath,
  args: ['--no-sandbox'],
  env: {
    ...process.env,
    XDG_CONFIG_HOME: dataDir,
    ELECTRON_RUN_AS_NODE: '',
    OPENAI_API_KEY: '',
    OPENAI_ACCESS_TOKEN: '',
  },
  timeout: 30_000,
};
let app;
try {
  app = await electron.launch(options);
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.ok(userData.startsWith(dataDir));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const result = await page.evaluate(async () => ({
    origin: location.origin,
    bridge: typeof window.brainDesktop?.close,
    node: typeof window.require,
    health: await fetch('/api/health').then((response) => response.json()),
    anatomy: await fetch('/anatomy/manifest.json').then((response) => response.json()),
    cortexBytes: await fetch('/anatomy/cortex-l.bin')
      .then((response) => response.arrayBuffer())
      .then((buffer) => buffer.byteLength),
  }));
  assert.match(result.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(result.bridge, 'function');
  assert.equal(result.node, 'undefined');
  assert.equal(result.health.ok, true);
  assert.ok(result.anatomy.meshes.length >= 18);
  assert.equal(
    result.cortexBytes,
    result.anatomy.meshes.find((mesh) => mesh.name === 'cortex-l').bytes,
  );
  assert.equal(
    await page.evaluate(() =>
      window.brainDesktop.openBrowser('file:///etc/passwd').then(
        () => false,
        () => true,
      ),
    ),
    true,
  );
  const mainPreferences = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
  );
  assert.equal(mainPreferences, false);
  await page.evaluate(() => localStorage.setItem('little-brain.smoke', 'restored'));
  // Serve deterministic HTTPS content in the newly-created isolated session. This exercises
  // the real bridge/window/navigation path without depending on public network availability.
  await app.evaluate(async ({ app, session }) => {
    await session.defaultSession.cookies.set({
      url: 'https://example.com',
      name: 'app-private-test',
      value: 'sentinel',
    });
    app.on('session-created', (isolated) => {
      isolated.protocol.handle(
        'https',
        () =>
          new Response(
            '<!doctype html><title>Isolated browser fixture</title><p>Browser ready</p><input aria-label="Test input"><button onclick="this.textContent=&quot;Clicked&quot;">Click me</button>',
            { headers: { 'content-type': 'text/html' } },
          ),
      );
    });
  });
  const browserOpened = app.waitForEvent('window');
  await page.evaluate(() => {
    window.browserFrames = [];
    window.stopBrowserFrames = window.brainDesktop.onPluginInteraction((event) =>
      window.browserFrames.push(event),
    );
  });
  const opened = await page.evaluate(() =>
    window.brainDesktop.openBrowser('https://example.com', { interactionId: 'smoke-manual' }),
  );
  assert.equal(opened.id, 'smoke-manual');
  assert.equal(
    await page.evaluate(
      (id) =>
        window.brainDesktop.browserAction({ instanceId: id, action: 'read' }).then(
          () => false,
          () => true,
        ),
      opened.id,
    ),
    true,
  );
  await page.waitForFunction(() =>
    window.browserFrames.some(
      (event) =>
        event.id === 'smoke-manual' && event.imageUrl?.startsWith('data:image/jpeg;base64,'),
    ),
  );

  const isolatedPage = await browserOpened;
  await isolatedPage.waitForLoadState('domcontentloaded');
  const isolatedState = await isolatedPage.evaluate(() => ({
    origin: location.origin,
    node: typeof window.require,
    bridge: typeof window.brainDesktop,
    workspace: localStorage.getItem('little-brain.smoke'),
    cookies: document.cookie,
  }));
  assert.equal(isolatedState.origin, 'https://example.com');
  assert.equal(isolatedState.node, 'undefined');
  assert.equal(isolatedState.bridge, 'undefined');
  assert.equal(isolatedState.workspace, null);
  assert.equal(isolatedState.cookies, '');
  const isolatedSecurity = await app.evaluate(({ BrowserWindow, session }) => {
    const isolated = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith('https://example.com'),
    );
    const preferences = isolated.webContents.getLastWebPreferences();
    return {
      separateSession: isolated.webContents.session !== session.defaultSession,
      sandbox: preferences.sandbox,
      nodeIntegration: preferences.nodeIntegration,
      contextIsolation: preferences.contextIsolation,
      preload: preferences.preload,
    };
  });
  assert.equal(isolatedSecurity.separateSession, true);
  assert.equal(isolatedSecurity.sandbox, true);
  assert.equal(isolatedSecurity.nodeIntegration, false);
  assert.equal(isolatedSecurity.contextIsolation, true);
  assert.ok(!isolatedSecurity.preload);
  assert.equal(
    await page.evaluate(
      (id) =>
        window.brainDesktop.manualBrowserAction({ instanceId: id, action: 'read' }).then(
          () => false,
          () => true,
        ),
      opened.id,
    ),
    true,
  );
  await page.evaluate((id) => window.brainDesktop.setBrowserFocused(id, true), opened.id);
  const manualSnapshot = JSON.parse(
    await page.evaluate(
      (id) => window.brainDesktop.manualBrowserAction({ instanceId: id, action: 'read' }),
      opened.id,
    ),
  );
  assert.ok(manualSnapshot.screenshot.width > 512);
  const manualInput = manualSnapshot.controls.find((control) => control.label === 'Test input');
  await page.evaluate(
    ({ id, x, y }) =>
      window.brainDesktop.manualBrowserAction({ instanceId: id, action: 'click', x, y }),
    { id: opened.id, x: manualInput.x, y: manualInput.y },
  );
  await page.evaluate(
    (id) =>
      window.brainDesktop.manualBrowserAction({
        instanceId: id,
        action: 'type',
        text: 'manual input',
      }),
    opened.id,
  );
  await page.evaluate(
    (id) =>
      window.brainDesktop.manualBrowserAction({ instanceId: id, action: 'key', key: 'Backspace' }),
    opened.id,
  );
  assert.equal(await isolatedPage.locator('input').inputValue(), 'manual inpu');
  const media = await page.evaluate(
    (id) => window.brainDesktop.setBrowserMedia(id, { audio: true, microphone: true }),
    opened.id,
  );
  assert.deepEqual(media, { audio: true, microphone: true, camera: false });
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().startsWith('https://example.com'))
        .webContents.isAudioMuted(),
    ),
    false,
  );
  await page.evaluate((id) => window.brainDesktop.setBrowserFocused(id, false), opened.id);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().startsWith('https://example.com'))
        .webContents.isAudioMuted(),
    ),
    true,
  );
  await isolatedPage.close();
  await page.waitForFunction(() =>
    window.browserFrames.some(
      (event) => event.id === 'smoke-manual' && event.status === 'complete',
    ),
  );
  const controlledOpened = app.waitForEvent('window');
  const controlled = await page.evaluate(() =>
    window.brainDesktop.openBrowser('https://example.com', {
      allowControl: true,
      interactionId: 'smoke-control',
    }),
  );
  const controlledPage = await controlledOpened;
  const snapshot = JSON.parse(
    await page.evaluate(
      (id) => window.brainDesktop.browserAction({ instanceId: id, action: 'read' }),
      controlled.id,
    ),
  );
  assert.equal(snapshot.screenshot.width, 512);
  const input = snapshot.controls.find((control) => control.label === 'Test input');
  await page.evaluate(
    ({ id, x, y }) => window.brainDesktop.browserAction({ instanceId: id, action: 'click', x, y }),
    { id: controlled.id, x: input.x, y: input.y },
  );
  await page.evaluate(
    (id) =>
      window.brainDesktop.browserAction({ instanceId: id, action: 'type', text: 'fixture text' }),
    controlled.id,
  );
  assert.equal(await controlledPage.locator('input').inputValue(), 'fixture text');
  assert.equal(
    await page.evaluate(
      (id) =>
        window.brainDesktop
          .browserAction({ instanceId: id, action: 'navigate', url: 'file:///etc/passwd' })
          .then(
            () => false,
            () => true,
          ),
      controlled.id,
    ),
    true,
  );
  await controlledPage.close();
  await page.evaluate(() => window.stopBrowserFrames());

  await page.waitForTimeout(1500);
  const storage = JSON.parse(await readFile(join(userData, 'workspace.json'), 'utf8'));
  assert.equal(storage['little-brain.smoke'], 'restored');
  await app.close();
  app = await electron.launch(options);
  const restored = await app.firstWindow();
  await restored.waitForLoadState('domcontentloaded');
  assert.equal(
    await restored.evaluate(() => localStorage.getItem('little-brain.smoke')),
    'restored',
  );
  console.log(
    'Packaged desktop passed: bundled API/web/anatomy, isolated preload and HTTPS browser, durable workspace across launches.',
  );
} finally {
  await app?.close();
}
