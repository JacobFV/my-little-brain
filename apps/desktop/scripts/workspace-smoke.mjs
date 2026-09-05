import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const dataDir = await mkdtemp(join(tmpdir(), 'little-brain-workspace-ui-'));
const app = await electron.launch({
  executablePath: resolve(
    process.argv[2] || 'apps/desktop/release/linux-arm64-unpacked/@little-braindesktop',
  ),
  args: ['--no-sandbox'],
  env: {
    ...process.env,
    XDG_CONFIG_HOME: dataDir,
    ELECTRON_RUN_AS_NODE: '',
    OPENAI_API_KEY: '',
    OPENAI_ACCESS_TOKEN: '',
  },
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ app }) =>
    app.on('session-created', (isolated) =>
      isolated.protocol.handle(
        'https',
        () =>
          new Response(
            '<!doctype html><html><head><title>Browser interaction test</title><style>body{font:20px system-ui;background:#fff4fa;padding:40px}input{display:block;padding:15px;margin:25px 0;width:330px}button{padding:16px}</style></head><body><h1>A little browser</h1><p>This is a local test fixture, with no external actions.</p><input aria-label="Fixture note" placeholder="Write a tiny thought"><button>Ready</button></body></html>',
            { headers: { 'content-type': 'text/html' } },
          ),
      ),
    ),
  );
  console.log('UI smoke: opening Connections');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('textbox', { name: 'Browser address' }).fill('https://example.com');
  const opened = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  const browser = await opened;
  console.log('UI smoke: browser window opened');
  await browser.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().startsWith('http://127.0.0.1'))
      .focus(),
  );
  const object = page.getByRole('button', {
    name: /example\.com: active\. Open or drag to move\./,
  });
  await expect(object).toBeVisible({ timeout: 30000 });
  console.log('UI smoke: owned 3D object visible');
  const beforeDrag = await object.boundingBox();
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    beforeDrag.x + beforeDrag.width / 2 - 45,
    beforeDrag.y + beforeDrag.height / 2 + 25,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect(page.getByRole('dialog', { name: 'example.com focused view' })).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await object.boundingBox()).x - beforeDrag.x))
    .toBeGreaterThan(5);
  console.log('UI smoke: drag completed');
  const clickBounds = await object.boundingBox();
  await page.mouse.click(
    clickBounds.x + clickBounds.width / 2,
    clickBounds.y + clickBounds.height / 2,
  );
  const focused = page.getByRole('dialog', { name: 'example.com focused view' });
  await expect(focused).toBeVisible();
  console.log('UI smoke: focused tablet visible');
  await expect(
    focused.getByRole('img', { name: 'Live display of your isolated browser session' }),
  ).toBeVisible();
  await expect(focused.getByRole('button', { name: 'Audio off', exact: true })).toBeEnabled();
  const screen = focused.getByLabel(
    'Browser display. Click to interact; use Keyboard for touch typing.',
  );
  const [bounds, target] = await Promise.all([
    screen.boundingBox(),
    browser.getByRole('textbox', { name: 'Fixture note' }).boundingBox(),
  ]);
  const viewport = await browser.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const scale = Math.min(bounds.width / viewport.width, bounds.height / viewport.height);
  const x =
    bounds.x + (bounds.width - viewport.width * scale) / 2 + (target.x + target.width / 2) * scale;
  const y =
    bounds.y +
    (bounds.height - viewport.height * scale) / 2 +
    (target.y + target.height / 2) * scale;
  await page.mouse.click(x, y);
  await focused.getByRole('button', { name: 'Keyboard', exact: true }).click();
  await focused
    .getByRole('textbox', { name: 'Text to type into browser' })
    .fill('A little thought from the tablet');
  await focused.getByRole('button', { name: 'Type text into browser' }).click();
  await expect(browser.getByRole('textbox', { name: 'Fixture note' })).toHaveValue(
    'A little thought from the tablet',
  );
  await focused.getByRole('button', { name: 'Audio off', exact: true }).click();
  await expect(focused.getByRole('button', { name: 'Audio on', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({ path: '/tmp/little-brain-focused-browser.png' });
  await focused.getByRole('button', { name: 'Close focused view' }).click();
  await expect(focused).toHaveCount(0);
  await expect(object).toBeVisible();
  const muted = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().startsWith('https://example.com'))
      .webContents.isAudioMuted(),
  );
  assert.equal(muted, true);
  await browser.close();
  await expect(object).toHaveCount(0, { timeout: 10000 });
  console.log(
    'Packaged App UI passed: Connections creates owned browser object; object opens focused tablet; screenshot click and keyboard type into real isolated page; audio toggles; close restores plane and mutes. Screenshot: /tmp/little-brain-focused-browser.png',
  );
} catch (error) {
  try {
    await (await app.firstWindow()).screenshot({ path: '/tmp/little-brain-ui-failure.png' });
  } catch {}
  throw error;
} finally {
  await app.close();
}
