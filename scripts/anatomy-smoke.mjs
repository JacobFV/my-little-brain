import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.argv[2] || 'http://127.0.0.1:5173');
  await page.getByText('Loading the brain’s anatomy…').waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await page.getByText('The anatomy could not be loaded.').count(), 0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/little-brain-anatomy-cortex.png' });
  await page.getByRole('button', { name: 'Inside', exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: '/tmp/little-brain-anatomy-inside.png' });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Anatomy browser smoke passed; cortical and internal screenshots saved under /tmp.');
} finally { await browser.close(); }
