// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Browser/layout checks and a synthetic PCM display fixture. This does not
// claim physical iPhone/Android audio or end-to-end modem transfer coverage.
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
const shots = option('--screenshots', path.join(root, 'out/audio-visuals'));
const views = ['tones', 'scope', 'spectrum', 'peaks'];
const modes = ['message', 'password', 'clear', 'advanced'];
const mime = {'.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2','.wasm':'application/wasm', '.json':'application/json'};
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

// The fixture has no media devices, AudioContext, renderer or app hooks. It
// supplies the same bounded PCM frame contract as the live audio side tap.
const fixtureHTML = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Audio visual fixture</title><link rel="stylesheet" href="fixture.css"><link rel="stylesheet" href="audio-visuals.css"><body><main><h1>Synthetic PCM display fixture</h1><p>No microphone or audio output is opened.</p></main><aside id="audio-visuals" aria-label="Live audio views"></aside><script type="module" src="fixture.mjs"></script></body></html>';
const fixtureScript = `
import {createAudioVisuals} from './audio-visuals.mjs';
const settings = {active:false, playing:false, profile:'nearby', sampleRate:48000, amplitude:0.25, frequency:1000, outputFrequency:2100, pattern:null};
const input = new Float32Array(2048), output = new Float32Array(2048);
let reads = 0;
const visual = createAudioVisuals(document.querySelector('#audio-visuals'), {
  getActive:() => settings.active,
  getProfile:() => settings.profile,
  readFrame:() => {
    reads++;
    if (!settings.active) return null;
    const frequencies = settings.pattern ? settings.pattern[Math.floor(reads / 6) % settings.pattern.length] : [settings.frequency];
    for (let i = 0; i < input.length; i++) {
      input[i] = settings.amplitude * frequencies.reduce((sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * i / settings.sampleRate), 0) / frequencies.length;
      output[i] = settings.playing ? settings.amplitude * Math.sin(2 * Math.PI * settings.outputFrequency * i / settings.sampleRate) : 0;
    }
    return {...settings, input, output};
  },
});
window.fixture = {
  set(values, refresh = true) { Object.assign(settings, values); if (refresh) visual.refresh({profile:settings.profile}); },
  state:() => visual.getState(),
  reads:() => reads,
  clear() { settings.active = false; input.fill(0); output.fill(0); visual.clear(); },
  destroy() { settings.active = false; input.fill(0); output.fill(0); visual.destroy(); },
};
`;
const virtualFiles = {
  '/test-preview/fixture.html':['text/html', fixtureHTML],
  '/test-preview/fixture.mjs':['text/javascript', fixtureScript],
  '/test-preview/fixture.css':['text/css', 'html{color-scheme:dark}body{margin:0;background:#121820;color:#eee;font:16px system-ui}main{padding:24px}'],
};
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let type, content;
    if (virtualFiles[pathname]) [type, content] = virtualFiles[pathname];
    else {
      if (!pathname.startsWith('/test-preview/')) throw Error('Outside preview');
      const relative = pathname.slice('/test-preview'.length);
      const file = path.resolve(assets, '.' + (relative.endsWith('/') ? relative + 'index.html' : relative));
      if (!file.startsWith(assets + path.sep)) throw Error('Invalid path');
      type = mime[path.extname(file)] || 'application/octet-stream';
      content = await fs.readFile(file);
    }
    response.writeHead(200, {'Content-Type':type, 'Content-Security-Policy':csp, 'Cache-Control':'no-store'});
    response.end(content);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/test-preview/`;
const browsers = [], errors = [], results = [];

async function guardMedia(context) {
  await context.addInitScript(() => {
    window.__visualMedia = {microphone:0, audioContexts:0};
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      window.__visualMedia.microphone++;
      throw Error('Visual controls must not request microphone access');
    };
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      if (!window[name]) continue;
      window[name] = new Proxy(window[name], {construct() {
        window.__visualMedia.audioContexts++;
        throw Error('Visual controls must not create an AudioContext');
      }});
    }
  });
}

async function noMedia(page, label) {
  assert.deepEqual(await page.evaluate(() => window.__visualMedia), {microphone:0, audioContexts:0}, `${label}: visual interaction never opens audio`);
}

function metadataOnly(state, label) {
  assert.ok(state && typeof state === 'object', `${label}: exposes visual metadata`);
  const visit = (value, name) => {
    assert.equal(Array.isArray(value) || ArrayBuffer.isView(value), false, `${label}: ${name} contains no sample arrays`);
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        assert.equal(/^(pcm|input|output|samples|buffer|dbfs)$/i.test(key), false, `${label}: ${key} is not public audio data`);
        visit(child, `${name}.${key}`);
      }
    }
  };
  visit(state, 'visuals');
  assert.ok(JSON.stringify(state).length < 4096, `${label}: metadata stays bounded`);
}

async function canvasSignature(page) {
  return page.locator('#audio-visual-canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619);
    return `${canvas.width}x${canvas.height}:${hash >>> 0}`;
  });
}

async function canvasPixels(page) {
  return page.locator('#audio-visual-canvas').evaluate(canvas => ({
    width:canvas.width, height:canvas.height,
    data:Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data),
  }));
}

async function assertIdlePixels(page, baseline, label) {
  const current = await canvasPixels(page);
  assert.equal(current.width, baseline.width, `${label}: idle canvas width`);
  assert.equal(current.height, baseline.height, `${label}: idle canvas height`);
  // Canvas text antialiasing can differ by 1–2/255 after a backing-store
  // resize. This tolerance still rejects any retained waveform/history pixels.
  const different = current.data.filter((value, index) => Math.abs(value - baseline.data[index]) > 3).length;
  assert.equal(different, 0, `${label}: previous audio history is erased`);
}

async function waitForNewPixels(page, previous, label) {
  await page.waitForFunction(old => {
    const canvas = document.querySelector('#audio-visual-canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619);
    return `${canvas.width}x${canvas.height}:${hash >>> 0}` !== old;
  }, previous, {timeout:3000}).catch(error => { throw Error(`${label}: PCM change did not change visible pixels`, {cause:error}); });
}

async function samplingStopped(page, label) {
  // Let any already queued frame finish, then cross several normal display ticks.
  await page.waitForTimeout(60);
  const before = await page.evaluate(() => window.fixture.reads());
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.fixture.reads()), before, `${label}: PCM sampling stops`);
}

async function checkDockLayout(page, label, expanded = true) {
  const result = await page.evaluate(() => {
    const dock = document.querySelector('#audio-visuals');
    const rect = dock.getBoundingClientRect();
    return {
      viewport:{width:innerWidth, height:innerHeight},
      overflow:document.documentElement.scrollWidth > innerWidth,
      dock:{x:rect.x, y:rect.y, right:rect.right, bottom:rect.bottom, height:rect.height, position:getComputedStyle(dock).position},
      controls:[...dock.querySelectorAll('button')].filter(node => node.getClientRects().length).map(node => {
        const box = node.getBoundingClientRect();
        return {id:node.id, x:box.x, right:box.right, y:box.y, bottom:box.bottom, width:box.width, height:box.height};
      }),
    };
  });
  assert.equal(result.overflow, false, `${label}: no horizontal overflow`);
  assert.equal(result.dock.position, 'fixed', `${label}: dock stays fixed`);
  assert.ok(result.dock.x >= -1 && result.dock.right <= result.viewport.width + 1, `${label}: dock fits viewport`);
  assert.ok(Math.abs(result.dock.bottom - result.viewport.height) < 2, `${label}: dock touches the visible bottom`);
  assert.ok(result.dock.y >= 0 && result.dock.height >= 44, `${label}: dock remains visible`);
  assert.equal(result.controls.length, expanded ? 5 : 1, `${label}: only relevant visual controls are visible`);
  for (const control of result.controls) {
    assert.ok(control.width >= 44 && control.height >= 44, `${label}: ${control.id} has a 44px touch target`);
    assert.ok(control.x >= -1 && control.right <= result.viewport.width + 1, `${label}: ${control.id} fits horizontally`);
    assert.ok(control.y >= result.dock.y - 1 && control.bottom <= result.dock.bottom + 1, `${label}: ${control.id} fits inside the dock`);
  }
  return result;
}

async function checkFooter(page, label) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const boxes = await page.evaluate(() => ({
    footer:document.querySelector('footer').getBoundingClientRect().toJSON(),
    dock:document.querySelector('#audio-visuals').getBoundingClientRect().toJSON(),
    header:document.querySelector('#site-header').getBoundingClientRect().toJSON(),
  }));
  assert.ok(boxes.footer.bottom <= boxes.dock.top + 1, `${label}: last page content can scroll above the dock`);
  assert.ok(boxes.footer.top >= boxes.header.bottom - 1, `${label}: last page content remains readable below the fixed header`);
}

async function appCase(browser, name, options) {
  const context = await browser.newContext(options);
  try {
    await guardMedia(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    await page.goto(url+'?view=web');
    await page.locator('#audio-visual-canvas').waitFor();
    await page.waitForFunction(() => Boolean(window.tonesealAgent?.getState().visuals));
    assert.equal(await page.locator('#site-nav button').count(), 4, `${name}: visuals do not add a fifth main tab`);
    const expanded = await checkDockLayout(page, name);
    await page.locator('#auto-text').fill('A draft survives changing the live display.');
    if (options.viewport.width <= 520) {
      await page.waitForFunction(() => document.querySelector('#audio-visual-collapse').getAttribute('aria-expanded') === 'false');
      await checkDockLayout(page, `${name}/typing`, false);
      await page.locator('#audio-visual-collapse').click();
      await page.waitForFunction(() => document.querySelector('#audio-visual-collapse').getAttribute('aria-expanded') === 'true');
      assert.equal(await page.locator('#auto-text').evaluate(node => document.activeElement === node), false, `${name}: expanding views dismisses composer focus`);
    }
    for (const view of views) {
      await page.locator(`#audio-view-${view}`).click();
      assert.equal(await page.locator('#audio-visual-canvas').getAttribute('data-view'), view);
      const state = await page.evaluate(() => window.tonesealAgent.getState().visuals);
      metadataOnly(state, `${name}/${view}`);
      assert.equal(state.view, view);
      assert.equal(state.active, false);
      assert.equal(await page.locator('#mode-message').getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#auto-text').inputValue(), 'A draft survives changing the live display.');
    }
    for (const mode of modes) {
      await page.locator(`#mode-${mode}`).click();
      assert.equal(await page.locator(`#mode-${mode}`).getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('#advanced-options').isVisible(), mode === 'advanced');
      await checkDockLayout(page, `${name}/${mode}`);
    }
    await checkFooter(page, name);
    const scrolled = await checkDockLayout(page, `${name}/scrolled`);
    assert.ok(Math.abs(scrolled.dock.y - expanded.dock.y) < 2, `${name}: scrolling does not move the dock`);
    await page.screenshot({path:path.join(shots, `${name}.png`)});
    await page.locator('#audio-visual-collapse').click();
    assert.equal(await page.locator('#audio-visual-collapse').getAttribute('aria-expanded'), 'false');
    const collapsed = await checkDockLayout(page, `${name}/collapsed`, false);
    assert.ok(collapsed.dock.height < expanded.dock.height, `${name}: collapse gives space back to the page`);
    await checkFooter(page, `${name}/collapsed`);
    await page.locator('#audio-visual-collapse').click();
    assert.equal(await page.locator('#audio-visual-collapse').getAttribute('aria-expanded'), 'true');
    await checkDockLayout(page, `${name}/expanded`);
    await page.locator('#mode-message').click();
    await page.locator('#audio-profile').selectOption('telephone');
    await page.waitForFunction(() => document.querySelector('#audio-visual-canvas').dataset.profile === 'telephone');
    assert.equal(Number(await page.locator('#audio-visual-canvas').getAttribute('data-min-hz')), 450);
    assert.equal(Number(await page.locator('#audio-visual-canvas').getAttribute('data-max-hz')), 2812.5);
    await page.locator('#audio-profile').selectOption('nearby');
    await page.waitForFunction(() => document.querySelector('#audio-visual-canvas').dataset.profile === 'nearby');
    assert.equal(Number(await page.locator('#audio-visual-canvas').getAttribute('data-min-hz')), 600);
    assert.equal(Number(await page.locator('#audio-visual-canvas').getAttribute('data-max-hz')), 3750);
    await noMedia(page, name);
    results.push({name, kind:'app-layout', viewport:options.viewport});
    console.log(`PASS ${name}: four tabs, touch targets, fixed dock, reachable footer, collapse, profile ranges, no audio acquisition.`);
  } finally { await context.close(); }
}

async function fixtureCase(browser, name, reducedMotion = false) {
  const context = await browser.newContext({viewport:{width:900, height:650}, deviceScaleFactor:1, reducedMotion:reducedMotion ? 'reduce' : 'no-preference'});
  try {
    await guardMedia(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    await page.goto(url + 'fixture.html');
    await page.waitForFunction(() => Boolean(window.fixture));
    await samplingStopped(page, `${name}/idle`);
    await page.evaluate(() => window.fixture.set({active:true}));
    await page.waitForFunction(() => window.fixture.state().active && window.fixture.state().source === 'microphone');
    metadataOnly(await page.evaluate(() => window.fixture.state()), name);
    assert.match(await page.locator('#audio-visual-status').textContent(), /microphone/i);
    if (reducedMotion) {
      for (const view of ['tones', 'scope', 'spectrum']) {
        await page.locator(`#audio-view-${view}`).click();
        await page.waitForFunction(() => window.fixture.state().motion === 'held');
        await page.waitForTimeout(150);
        const before = await canvasSignature(page);
        await page.evaluate(() => window.fixture.set({amplitude:0.8, frequency:1700}, false));
        await page.waitForTimeout(350);
        assert.equal(await canvasSignature(page), before, `${name}/${view}: reduced motion holds the display`);
      }
    } else {
      for (const view of views) {
        await page.locator(`#audio-view-${view}`).click();
        await page.evaluate(() => window.fixture.set({amplitude:0, playing:false}));
        await page.waitForTimeout(200);
        const quiet = view === 'peaks' ? null : await canvasSignature(page);
        if (view === 'peaks') assert.equal(await page.locator('#audio-peak-microphone').evaluate(meter => meter.value), 0);
        await page.evaluate(() => window.fixture.set({amplitude:0.65, frequency:1500}, false));
        if (view === 'peaks') await page.waitForFunction(() => document.querySelector('#audio-peak-microphone').value > 0.6);
        else await waitForNewPixels(page, quiet, `${name}/${view}`);
      }
    }
    // Peaks remain readable/current even when the animated plots are held.
    await page.locator('#audio-view-peaks').click();
    await page.evaluate(() => window.fixture.set({playing:true, amplitude:0.35}));
    await page.waitForFunction(() => ['microphone', 'playback'].every(source => {
      const meter = document.querySelector('#audio-peak-' + source);
      return meter.value > 0.3 && meter.value < 0.4;
    }));
    await page.evaluate(() => window.fixture.set({amplitude:0.7}, false));
    await page.waitForFunction(() => document.querySelector('#audio-peak-playback').value > 0.65);
    await page.locator('#audio-view-scope').click();
    await page.evaluate(() => window.fixture.set({playing:true, amplitude:0.35}));
    await page.waitForFunction(() => window.fixture.state().source === 'playback');
    assert.equal(await page.locator('#audio-visual-canvas').getAttribute('data-source'), 'playback');
    assert.match(await page.locator('#audio-visual-status').textContent(), /playback/i);
    await page.evaluate(() => window.fixture.set({playing:false, sampleRate:44100, profile:'telephone', frequency:750}));
    await page.waitForFunction(() => window.fixture.state().source === 'microphone' && window.fixture.state().profile === 'telephone');
    assert.equal(Number(await page.locator('#audio-visual-canvas').getAttribute('data-min-hz')), 450);
    assert.equal(Number(await page.locator('#audio-visual-canvas').getAttribute('data-max-hz')), 2812.5);
    if (name === 'chromium-pcm') await page.screenshot({path:path.join(shots, 'synthetic-telephone-scope.png')});
    await page.locator('#audio-view-tones').click();
    await page.evaluate(() => window.fixture.clear());
    await samplingStopped(page, `${name}/idle-baseline`);
    const idlePixels = await canvasSignature(page);
    const idleImage = await canvasPixels(page);
    await page.evaluate(() => window.fixture.set({active:true}));
    await waitForNewPixels(page, idlePixels, `${name}/restart`);
    if (name === 'chromium-pcm') {
      await page.evaluate(() => window.fixture.set({amplitude:0.7, pattern:[[750,1250], [1250,1800], [1800,2400], [2400,750]]}));
      await page.waitForTimeout(6200);
      await page.screenshot({path:path.join(shots, 'synthetic-four-tone-history.png')});
    }
    await page.locator('#audio-visual-collapse').click();
    await samplingStopped(page, `${name}/collapsed`);
    assert.equal((await page.evaluate(() => window.fixture.state())).collapsed, true);
    await page.locator('#audio-visual-collapse').click();
    const readsBefore = await page.evaluate(() => window.fixture.reads());
    await page.waitForFunction(count => window.fixture.reads() > count, readsBefore);
    // Headless browsers do not consistently background tabs. Exercise the
    // actual visibility handler with the browser's hidden flag in this fixture.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true, get:() => true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await samplingStopped(page, `${name}/hidden`);
    await assertIdlePixels(page, idleImage, `${name}/hidden`);
    metadataOnly(await page.evaluate(() => window.fixture.state()), `${name}/hidden`);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(count => window.fixture.reads() > count, await page.evaluate(() => window.fixture.reads()));
    await page.evaluate(() => window.fixture.clear());
    await samplingStopped(page, `${name}/clear`);
    const cleared = await page.evaluate(() => window.fixture.state());
    assert.equal(cleared.active, false);
    assert.equal(cleared.source, null);
    assert.equal(cleared.motion, 'idle');
    await assertIdlePixels(page, idleImage, `${name}/clear`);
    metadataOnly(cleared, `${name}/clear`);
    await page.evaluate(() => window.fixture.destroy());
    await samplingStopped(page, `${name}/destroy`);
    assert.equal(await page.locator('#audio-visuals').evaluate(node => node.childElementCount), 0, `${name}/destroy: removes visual controls`);
    assert.equal(await page.evaluate(() => document.body.classList.contains('has-audio-visuals')), false, `${name}/destroy: releases reserved page space`);
    await noMedia(page, name);
    results.push({name, kind:'synthetic-pcm', reducedMotion});
    console.log(`PASS ${name}: ${reducedMotion ? 'held reduced-motion plots' : 'four live PCM views'}, microphone/playback labels, 44.1/48 kHz, cleanup and metadata-only state.`);
  } finally { await context.close(); }
}

async function canvasFailureCase(browser, name, trigger) {
  const context = await browser.newContext({viewport:{width:900, height:650}, deviceScaleFactor:1});
  try {
    await guardMedia(context);
    if (trigger === 'initialization') await context.addInitScript(() => {
      HTMLCanvasElement.prototype.getContext = function () { throw Error('Synthetic unavailable canvas'); };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    await page.goto(url + 'fixture.html');
    await page.waitForFunction(() => Boolean(window.fixture), null, {timeout:3000});
    if (trigger !== 'initialization') {
      await page.evaluate(() => window.fixture.set({active:true}));
      await page.waitForFunction(() => window.fixture.state().source === 'microphone');
      await page.evaluate(method => {
        CanvasRenderingContext2D.prototype.fillRect = function () { throw Error('Synthetic lost canvas'); };
        if (method === 'clear') window.fixture.clear();
        else window.fixture.set({profile:'telephone'});
      }, trigger);
    }
    await page.locator('#audio-visual-unavailable').waitFor({state:'visible'});
    assert.match(await page.locator('#audio-visual-status').textContent(), /unavailable/i);
    await page.evaluate(() => window.fixture.set({active:true}));
    await samplingStopped(page, `${name}/failed-renderer`);
    for (const view of views) {
      await page.locator(`#audio-view-${view}`).click();
      assert.equal((await page.evaluate(() => window.fixture.state())).view, view);
    }
    await page.locator('#audio-visual-collapse').click();
    await page.locator('#audio-visual-collapse').click();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
      window.fixture.clear();
      window.fixture.set({active:true, profile:'nearby'});
    });
    await samplingStopped(page, `${name}/after-controls`);
    const state = await page.evaluate(() => window.fixture.state());
    metadataOnly(state, name);
    assert.equal(state.source, null);
    assert.equal(state.motion, 'idle');
    assert.equal(await page.locator('#audio-visual-canvas').isVisible(), false, `${name}: failed canvas is replaced by readable fallback`);
    assert.equal(await page.locator('#audio-visual-unavailable').isVisible(), true);
    await page.evaluate(() => window.fixture.destroy());
    await samplingStopped(page, `${name}/destroy`);
    await noMedia(page, name);
    results.push({name, kind:'canvas-failure', trigger});
    console.log(`PASS ${name}: canvas ${trigger} failure does not escape lifecycle methods or restart PCM sampling.`);
  } finally { await context.close(); }
}

try {
  await fs.access(path.join(assets, 'audio-visuals.mjs'));
  await fs.access(path.join(assets, 'media.mjs'));
  const {chromium, webkit, devices} = await import(pathToFileURL(playwright));
  const chromiumBrowser = await chromium.launch({executablePath:chrome, headless:true}); browsers.push(chromiumBrowser);
  const webkitBrowser = await webkit.launch({headless:true}); browsers.push(webkitBrowser);
  await fs.mkdir(shots, {recursive:true});
  await appCase(chromiumBrowser, 'desktop-chromium', {viewport:{width:1280, height:800}, deviceScaleFactor:1});
  await appCase(webkitBrowser, 'iphone-320-webkit', {...devices['iPhone SE'], viewport:{width:320, height:568}, screen:{width:320, height:568}, deviceScaleFactor:1});
  await appCase(chromiumBrowser, 'android-360-chromium', {...devices['Galaxy S9+'], viewport:{width:360, height:740}, screen:{width:360, height:740}, deviceScaleFactor:1});
  await fixtureCase(chromiumBrowser, 'chromium-pcm');
  await fixtureCase(webkitBrowser, 'webkit-pcm');
  await fixtureCase(chromiumBrowser, 'chromium-reduced-motion', true);
  await canvasFailureCase(chromiumBrowser, 'chromium-no-canvas', 'initialization');
  await canvasFailureCase(chromiumBrowser, 'chromium-lost-canvas', 'refresh');
  await canvasFailureCase(webkitBrowser, 'webkit-no-canvas', 'initialization');
  await canvasFailureCase(webkitBrowser, 'webkit-lost-canvas', 'clear');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  await fs.writeFile(path.join(shots, 'results.json'), JSON.stringify({results, errors}, null, 2) + '\n');
  console.log(`PASS audio visuals: ${results.length} browser cases; screenshots in ${shots}`);
} finally {
  await Promise.allSettled(browsers.map(browser => browser.close()));
  await new Promise(resolve => server.close(resolve));
}
