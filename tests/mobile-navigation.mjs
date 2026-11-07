// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Real WebKit/Chromium with touch and mobile viewport emulation. No audio is
// started: this checks navigation/layout, not physical iOS/Android audio support.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? path.resolve(args[args.indexOf(name) + 1]) : fallback;
const playwright = option('--playwright', process.env.PLAYWRIGHT_MODULE || path.join(root, 'node_modules/playwright/index.mjs'));
const chrome = option('--chrome', process.env.CHROME_PATH);
const assets = option('--assets', path.join(root, 'dist'));
const shots = option('--screenshots', path.join(root, 'out/mobile-navigation'));
const mime = {'.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2','.wasm':'application/wasm', '.json':'application/json'};
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const server = http.createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!requestPath.startsWith('/test-preview/')) throw Error('Outside preview');
    const pathname = requestPath.slice('/test-preview'.length);
    const file = path.resolve(assets, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    if (!file.startsWith(assets + path.sep)) throw Error('Invalid path');
    const content = await fs.readFile(file);
    response.writeHead(200, {'Content-Type':mime[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy':csp, 'Cache-Control':'no-store'});
    response.end(content);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/test-preview/`;
const tabs = ['message', 'password', 'clear', 'advanced'];
const errors = [], results = [], browsers = [];

async function checkLayout(page, label) {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => ['Inter','Michroma'].every(name => [...document.fonts].some(face => face.family === name && face.status === 'loaded'))), true, `${label}: local display font loads`);
  const layout = await page.evaluate(() => ({
    width:innerWidth, overflow:document.documentElement.scrollWidth > innerWidth,
    headerTop:document.querySelector('#site-header').getBoundingClientRect().top,
    headerBottom:document.querySelector('#site-header').getBoundingClientRect().bottom,
    height:innerHeight,
    tabs:[...document.querySelectorAll('#site-nav button, #site-nav a')].map(node => {
      const rect = node.getBoundingClientRect();
      return {id:node.id, x:rect.x, right:rect.right, y:rect.y, width:rect.width, height:rect.height, clipped:node.scrollWidth > node.clientWidth};
    }),
  }));
  assert.equal(layout.overflow, false, `${label}: no horizontal overflow`);
  assert.ok(Math.abs(layout.headerTop) < 1, `${label}: site header stays at the top`);
  assert.ok(layout.headerBottom < layout.height, `${label}: header leaves room for content`);
  assert.equal(layout.tabs.length, 4);
  for (const tab of layout.tabs) {
    assert.ok(tab.width >= 44 && tab.height >= 44, `${label}: ${tab.id} has a 44px touch target`);
    assert.ok(tab.x >= 0 && tab.right <= layout.width + 1, `${label}: ${tab.id} fits`);
    assert.equal(tab.clipped, false, `${label}: ${tab.id} text fits`);
    assert.ok(Math.abs(tab.y - layout.tabs[0].y) < 1, `${label}: all tabs on one row`);
  }
}

async function selectTab(page, mode) {
  await page.locator(`#mode-${mode}`).tap();
  assert.equal(await page.locator(`#mode-${mode}`).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.mode-tabs [aria-selected="true"]').count(), 1);
  assert.equal(await page.locator('#advanced-options').isVisible(), mode === 'advanced');
  assert.equal(await page.locator('#transfer-panel').isVisible(), mode !== 'advanced');
}

try {
  const {chromium, webkit, devices} = await import(pathToFileURL(playwright));
  const android = await chromium.launch({executablePath:chrome, headless:true}); browsers.push(android);
  const iphone = await webkit.launch({headless:true}); browsers.push(iphone);
  await fs.mkdir(shots, {recursive:true});
  const cases = [
    {name:'iphone-se', browser:iphone, options:devices['iPhone SE']},
    {name:'iphone-13', browser:iphone, options:devices['iPhone 13']},
    {name:'iphone-375', browser:iphone, options:{...devices['iPhone SE'], viewport:{width:375,height:667}, screen:{width:375,height:667}}},
    {name:'iphone-landscape', browser:iphone, options:devices['iPhone 13 landscape']},
    {name:'android-pixel-7', browser:android, options:devices['Pixel 7']},
    {name:'android-galaxy-s9', browser:android, options:{...devices['Galaxy S9+'], viewport:{width:360,height:740}, screen:{width:360,height:740}}},
    {name:'android-landscape', browser:android, options:devices['Pixel 7 landscape']},
  ];
  for (const entry of cases) {
    assert.ok(entry.options, `${entry.name} emulation descriptor exists`);
    const context = await entry.browser.newContext(entry.options);
    await context.addInitScript(() => {
      window.__mediaRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        window.__mediaRequests++;
        throw new Error('Navigation must not request microphone access');
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${entry.name}: ${error.message}`));
    await page.goto(url+'?view=web');
    await page.locator('#mode-message[aria-selected="true"]').waitFor();
    assert.equal(await page.locator('.mode-tabs button:visible').count(), 4);
    await checkLayout(page, entry.name);
    await page.locator('#auto-text').fill('Keep this message while I adjust settings.');
    await selectTab(page, 'advanced');
    await page.waitForFunction(() => !document.querySelector('#crypto-capability').textContent.includes('Checking'));
    const compact = await page.locator('#crypto-profile option[value=x25519]').isEnabled();
    await page.locator('#crypto-profile').selectOption(compact ? 'x25519' : 'p256');
    await page.screenshot({path:path.join(shots, `${entry.name}-advanced.png`)});
    await selectTab(page, 'message');
    assert.equal(await page.locator('#auto-text').inputValue(), 'Keep this message while I adjust settings.');
    assert.equal(await page.locator('#crypto-profile').inputValue(), compact ? 'x25519' : 'p256');
    for (const mode of tabs) {
      await selectTab(page, mode);
      await checkLayout(page, `${entry.name}/${mode}`);
      const smallFields = await page.locator('input:visible:not([type=checkbox]):not([type=range]), textarea:visible, select:visible').evaluateAll(nodes => nodes.filter(node => Number.parseFloat(getComputedStyle(node).fontSize) < 16).map(node => node.id));
      assert.deepEqual(smallFields, [], `${entry.name}/${mode}: form text avoids iOS focus zoom`);
      for (const field of await page.locator('select:visible').all()) {
        assert.ok((await field.boundingBox()).height >= 44, `${entry.name}/${mode}: select has a 44px touch target`);
      }
      await page.screenshot({path:path.join(shots, `${entry.name}-${mode}.png`)});
    }
    await selectTab(page, 'password');
    await page.locator('#auto-password').fill('Dummy-mobile-secret');
    await selectTab(page, 'advanced');
    assert.equal(await page.locator('#auto-password').inputValue(), '', 'Advanced clears hidden password draft');
    await selectTab(page, 'password');
    assert.equal(await page.locator('#auto-start').isDisabled(), true, 'Cleared sender must not silently become receiver');
    await page.locator('#receive-instead').tap();
    assert.equal(await page.locator('#auto-start').textContent(), 'Start receiving');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const nav = await page.locator('.mode-tabs').boundingBox();
    assert.ok(nav.y >= 0 && nav.y + nav.height <= entry.options.viewport.height, 'Tabs stay on screen after scrolling');
    await selectTab(page, 'advanced');
    const title = await page.locator('#advanced-title').boundingBox();
    const sticky = await page.locator('.mode-tabs').boundingBox();
    assert.ok(title.y >= sticky.y + sticky.height && title.y < entry.options.viewport.height, 'Advanced opens at its beginning after a deep scroll');
    for (const mode of ['message', 'password', 'clear', 'advanced']) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await selectTab(page, mode);
      const heading = await page.locator(mode === 'advanced' ? '#advanced-title' : '#compose-title').boundingBox();
      const tabsBox = await page.locator('.mode-tabs').boundingBox();
      assert.ok(heading.y >= tabsBox.y + tabsBox.height && heading.y < entry.options.viewport.height, `${mode} opens at its beginning after deep scroll`);
    }
    for (const [filename, control, destination] of [
      ['pki-demo.html', '#mode-showcase', 'message'],
      ['manual.html', 'a[href="manual.html"]', 'password'],
      ['communication.html', 'a[href="communication.html"]', 'clear'],
    ]) {
      await selectTab(page, 'advanced');
      await page.locator(control).tap();
      await page.waitForURL(`**/${filename}`);
      assert.equal(await page.locator('#site-nav a[aria-current="page"]').textContent(), 'Advanced');
      assert.match(await page.locator('#site-header').textContent(), /Advanced/);
      assert.match(await page.locator('#site-header a.quiet-link').textContent(), /Back to Advanced/);
      await checkLayout(page, `${entry.name}/${filename}`);
      const heading = await page.locator('h1').boundingBox();
      const header = await page.locator('#site-header').boundingBox();
      assert.ok(heading.y >= header.y + header.height, `${filename}: heading is not hidden behind header`);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await checkLayout(page, `${entry.name}/${filename}/scrolled`);
      const back = await page.locator('#site-header a.quiet-link').boundingBox();
      assert.ok(back.y >= 0 && back.y + back.height <= entry.options.viewport.height, 'Back remains on screen');
      await page.screenshot({path:path.join(shots, `${entry.name}-${filename.replace('.html','')}.png`)});
      assert.equal(await page.evaluate(() => window.__mediaRequests), 0);
      await page.locator('#site-header a.quiet-link').tap();
      await page.waitForURL('**/?advanced=1');
      await page.locator('#mode-advanced[aria-selected="true"]').waitFor();
      assert.equal(await page.locator('#mode-showcase').isVisible(), true, 'Back returns to Advanced contents');
      // Each subpage also links directly to a normal transfer mode. Keep the
      // hidden preview prefix, select the right mode and start with no draft.
      await page.locator(control).tap();
      await page.waitForURL(`**/${filename}`);
      await page.locator(`#site-nav a[href="./?mode=${destination}"]`).tap();
      await page.waitForURL(url + `?mode=${destination}`);
      await page.locator(`#mode-${destination}[aria-selected="true"]`).waitFor();
      assert.equal(await page.locator('#auto-start').textContent(), 'Start receiving');
      assert.equal(await page.locator('#auto-password').inputValue(), '');
      assert.equal(await page.evaluate(() => window.__mediaRequests), 0);
    }
    await selectTab(page, 'message');
    assert.equal(await page.locator('#auto-text').inputValue(), '', 'Navigation back does not restore draft');
    results.push({name:entry.name, viewport:entry.options.viewport, compactSupported:compact});
    console.log(`PASS ${entry.name}: persistent navigation on all four pages, mode links and Back, settings/privacy, no overflow or microphone.`);
    await context.close();
  }
  // Keyboard users can reach every panel without tabbing through hidden content.
  const context = await android.newContext();
  const page = await context.newPage();
  await page.goto(url+'?view=web');
  await page.locator('#mode-message').focus();
  for (const [key, mode] of [['ArrowRight','password'], ['End','advanced'], ['Home','message'], ['ArrowLeft','advanced']]) {
    await page.keyboard.press(key);
    assert.equal(await page.locator(`#mode-${mode}`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator(`#mode-${mode}`).evaluate(node => document.activeElement === node), true);
  }
  await context.close();
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(shots, 'results.json'), JSON.stringify({scope:'Mobile emulation, not physical devices', cases:results}, null, 2) + '\n');
  console.log('PASS desktop keyboard tab navigation; no browser errors.');
} finally {
  for (const browser of browsers) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
