// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Real browser UI, Web Crypto and automatic controller; only the room/audio
// transport and OS clipboard are substituted in the two-device checks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? path.resolve(args[args.indexOf(name) + 1]) : fallback;
const synth = process.env.JOTTUNE_SYNTH_ROOT || path.resolve(root, '../jottune-synth');
const playwright = option('--playwright', process.env.PLAYWRIGHT_MODULE || path.join(root, 'node_modules/playwright/index.mjs'));
const chrome = option('--chrome', process.env.CHROME_PATH);
const dist = option('--assets', path.join(root, 'dist'));
const shots = option('--screenshots', path.join(root, 'out/auto-browser'));
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const mime = {'.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2','.wasm':'application/wasm', '.json':'application/json'};
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(dist, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    if (!filename.startsWith(dist + path.sep)) throw Error('path');
    const content = await fs.readFile(filename);
    response.writeHead(200, {'Content-Type':mime[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control':'no-store', 'Content-Security-Policy':csp, 'Permissions-Policy':'microphone=(self), camera=(), geolocation=()',
      'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff'});
    response.end(content);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const stub = `export class AutoAudioLink {
  constructor(options={}) { this.options=options; this.running=false; this.playing=false; this.busy=false; this.generation=0; window.__air=this; }
  async start() { this.generation++; this.running=true; this.options.onStatus?.('Listening automatically.'); }
  async send(packet) {
    if(!this.running) throw Error('Transport stopped');
    const token=this.generation; this.busy=true; this.playing=true;
    await new Promise(resolve=>setTimeout(resolve,15));
    if(token!==this.generation) throw new DOMException('Stopped','AbortError');
    await window.__airSend(Array.from(packet));
    this.playing=false; this.busy=false;
  }
  stop() { this.generation++; this.running=false; this.playing=false; this.busy=false; }
}`;
let browser;
const errors = [], pairs = [];
const waitText = (page, selector, part) => page.waitForFunction(({selector, part}) => document.querySelector(selector)?.textContent.includes(part), {selector, part}, {timeout:45000});
const enabled = (page, selector) => page.waitForFunction(selector => !document.querySelector(selector)?.disabled, selector, {timeout:45000});
async function hide(page) {
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable:true, value:true}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
}
async function configureOneShot(page) {
  // This suite retains the single-transfer regression matrix. Default Message
  // chat, retained sessions and replies are covered by chat-browser.mjs.
  await page.locator('#mode-advanced').click();
  assert.equal(await page.locator('#chat-enabled').isChecked(), true, 'Message chat is enabled on a newly loaded page');
  await page.locator('#chat-enabled').uncheck();
  await page.locator('#mode-message').click();
  await enabled(page, '#auto-start');
}
async function createPair({drop = () => false, unsupportedCompact = false} = {}) {
  const pair = {pages:[], records:[], dropped:[], counts:new Map()};
  for (let side = 0; side < 2; side++) {
    const context = await browser.newContext({viewport:side ? {width:390, height:844} : {width:1280, height:1000}});
    await context.route('**/auto-audio-link.mjs', route => route.fulfill({status:200, contentType:'text/javascript', body:stub}));
    await context.addInitScript(() => {
      window.__clipboard = '';
      Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
        readText:() => window.__holdClipboard ? new Promise((resolve,reject) => { window.__releaseClipboard = resolve; window.__denyClipboard = reject; }) : Promise.resolve(window.__clipboard),
        writeText:async text => { window.__clipboard = text; },
      }});
    });
    if (unsupportedCompact) await context.addInitScript(() => {
      const native = crypto.subtle.generateKey.bind(crypto.subtle);
      crypto.subtle.generateKey = (algorithm,...args) => (typeof algorithm === 'string' ? algorithm : algorithm.name) === 'X25519'
        ? Promise.reject(new DOMException('Synthetic unsupported X25519','NotSupportedError')) : native(algorithm,...args);
    });
    await context.exposeBinding('__airSend', async ({page}, bytes) => {
      const record = {side, bytes}; pair.records.push(record);
      const key = side + ':' + Buffer.from(bytes).toString('hex');
      const occurrence = (pair.counts.get(key) || 0) + 1; pair.counts.set(key, occurrence);
      if (drop(record, occurrence)) { pair.dropped.push(record); return; }
      const peer = pair.pages[1 - side];
      if (!peer || peer.isClosed()) return;
      await peer.evaluate(bytes => {
        const air = window.__air;
        if (air?.running && !air.playing) air.options.onPackets?.([Uint8Array.from(bytes)]);
      }, bytes);
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { errors.push('Unexpected dialog: ' + dialog.message()); dialog.dismiss(); });
    await page.goto(url+'?view=web'); await configureOneShot(page);
    pair.pages.push(page);
  }
  pairs.push(pair);
  return pair;
}
async function startPair(pair, text, {verify = false, mode = 'message', senderFirst = false, profile = 'nearby', cryptoProfile = 'p256'} = {}) {
  const [a,b] = pair.pages;
  for (const page of [a,b]) {
    await page.locator(`[data-mode="${mode}"]`).click();
    await page.locator('#verify-peer').setChecked(verify);
    await page.locator('#audio-profile').selectOption(profile);
    if (mode !== 'clear' && await page.locator('#crypto-profile').inputValue() !== cryptoProfile) {
      await page.locator('#mode-advanced').click();
      await page.waitForFunction(value => !document.querySelector(`#crypto-profile option[value="${value}"]`).disabled,cryptoProfile);
      await page.locator('#crypto-profile').selectOption(cryptoProfile);
      await page.locator(`[data-mode="${mode}"]`).click();
    }
  }
  await a.locator(mode === 'password' ? '#auto-password' : '#auto-text').fill(text);
  if (senderFirst) { await a.locator('#auto-start').click(); await b.locator('#auto-start').click(); }
  else { await b.locator('#auto-start').click(); await a.locator('#auto-start').click(); }
}
async function stopPair(pair) {
  for (const page of pair.pages) if (await page.locator('#auto-stop').isVisible()) await page.locator('#auto-stop').click();
}

async function roleAndExampleChecks() {
  const pair = await createPair(), [sender,receiver] = pair.pages;
  for (const page of pair.pages) {
    assert.equal(await page.locator('#auto-text').inputValue(), '', 'No example is prefilled on either device');
    assert.equal(await page.locator('#auto-start').textContent(), 'Start receiving');
    assert.equal(await page.locator('#playback-value').textContent(), '100%');
    assert.equal(await page.locator('#playback-level').count(), 0, 'Playback gain has no app slider');
    assert.equal(await page.locator('#audio-profile').inputValue(), 'nearby');
    assert.equal(await page.locator('#audio-profile').isDisabled(), false);
    assert.equal(await page.locator('#crypto-profile').inputValue(),'p256');
    assert.equal(await page.locator('.mode-tabs button:visible').count(),4,'All four tabs are visible from the start');
    assert.equal(await page.locator('#advanced-options').isVisible(),false,'Message is the initial view');
    assert.equal(await page.evaluate(() => Boolean(window.__air?.running)), false);
  }
  await receiver.locator('#auto-text').fill('An old draft');
  assert.equal(await receiver.locator('#auto-start').textContent(), 'Start sending');
  assert.equal(await receiver.locator('#auto-example').isDisabled(), true, 'Example must not overwrite an existing draft');
  await receiver.locator('#receive-instead').click();
  assert.equal(await receiver.locator('#auto-text').inputValue(), '');
  assert.equal(await receiver.locator('#auto-start').textContent(), 'Start receiving');
  await receiver.evaluate(() => {
    document.querySelector('#auto-text').value = 'Restored browser draft';
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
  });
  assert.equal(await receiver.locator('#auto-text').inputValue(), '', 'Restored pages begin without stale sender content');
  await sender.locator('#auto-text').fill('Draft before reload');
  await sender.reload(); await configureOneShot(sender);
  assert.equal(await sender.locator('#auto-text').inputValue(), '');
  await receiver.locator('#auto-start').click();
  const earliest = Date.now();
  await sender.locator('#auto-example').click();
  assert.equal(await sender.locator('#auto-text').inputValue(), '', 'Sending snapshots and then clears the draft');
  assert.equal(await sender.locator('#audio-profile').isDisabled(), true);
  assert.equal(await sender.evaluate(() => window.__air.options.volume), 1, 'The app always requests full playback gain');
  assert.equal(await sender.evaluate(() => window.__air.options.profile), 'nearby', 'The default audio profile reaches the transport');
  await waitText(sender, '#auto-status', 'Delivery confirmed');
  const example = await receiver.locator('#auto-received-text').textContent();
  const match = /^The current time is (.+)\.$/.exec(example);
  assert.ok(match, 'Explicit example contains a time');
  assert.ok(Date.parse(match[1]) >= earliest && Date.parse(match[1]) <= Date.now(), 'Example time is generated by this click');
  await stopPair(pair);

  // Reuse the same Message pages in the opposite direction. The previous
  // sender has no lingering Hello/draft that could start another transmission.
  assert.equal(await sender.locator('#auto-start').textContent(), 'Start receiving');
  const reply = 'The second device now sends';
  await receiver.locator('#auto-text').fill(reply);
  await sender.locator('#auto-start').click(); await receiver.locator('#auto-start').click();
  await waitText(sender, '#auto-received-text', reply);
  await waitText(receiver, '#auto-status', 'Delivery confirmed');
  assert.equal(await receiver.locator('#auto-text').inputValue(), '');
  await stopPair(pair);
  console.log('PASS single-transfer roles: empty/restored pages, Receive instead, opt-in dynamic example, fixed full playback level, cleared sender draft and reversed next transfer.');
}

async function passwordStartupChecks() {
  const pair = await createPair(), [sender,receiver] = pair.pages;
  for (const page of pair.pages) await page.locator('#mode-password').click();
  const dummy = 'Dummy-delayed-paste_42!';
  await sender.evaluate(() => { window.__holdClipboard = true; });
  await sender.locator('#auto-paste').click();
  await sender.waitForFunction(() => typeof window.__releaseClipboard === 'function');
  assert.equal(await sender.locator('#auto-start').isDisabled(), true, 'Start must wait for an asynchronous clipboard read');
  await sender.evaluate(() => document.querySelector('#auto-start').click());
  assert.equal(await sender.evaluate(() => Boolean(window.__air?.running)), false, 'A pending paste must not silently start a receiver');
  await sender.evaluate(value => { window.__holdClipboard = false; window.__releaseClipboard(value); }, dummy);
  await sender.waitForFunction(value => document.querySelector('#auto-password').value === value, dummy);
  await enabled(sender, '#auto-start');
  assert.equal(await sender.locator('#auto-role').textContent(), 'SENDING DEVICE');
  await receiver.locator('#auto-start').click(); await sender.locator('#auto-start').click();
  await receiver.waitForFunction(value => document.querySelector('#auto-received-secret').value === value, dummy, {timeout:45000});
  await waitText(sender, '#auto-status', 'Delivery confirmed');

  // A received message retains the microphone briefly for lost receipts. A
  // deliberate mode change ends that run so the next transfer can start now.
  assert.equal(await receiver.evaluate(() => window.__air.running), true, 'Receiver is still in its receipt-repair interval');
  for (const page of pair.pages) await page.locator('#mode-message').click();
  assert.equal(await receiver.evaluate(() => window.__air.running), false, 'Mode change stops the finished receiver instead of silently ignoring the click');
  const text = 'A message before the next password';
  await receiver.locator('#auto-text').fill(text);
  await sender.locator('#auto-start').click(); await receiver.locator('#auto-start').click();
  await waitText(sender, '#auto-received-text', text);
  await waitText(receiver, '#auto-status', 'Delivery confirmed');

  // Reproduce the user's Message -> Password path on the same pages, reversing
  // sender roles, including autofill that sets .value without an input event.
  for (const page of pair.pages) await page.locator('#mode-password').click();
  await sender.evaluate(value => { document.querySelector('#auto-password').value = value; }, dummy);
  await receiver.locator('#auto-start').click(); await sender.locator('#auto-start').click();
  await receiver.waitForFunction(value => document.querySelector('#auto-received-secret').value === value, dummy, {timeout:45000});
  await waitText(sender, '#auto-status', 'Delivery confirmed');
  await stopPair(pair);

  // A privacy-cleared sender must not become a silent receiver by accident.
  await sender.locator('#auto-password').fill(dummy);
  await hide(sender);
  assert.equal(await sender.locator('#auto-password').inputValue(), '');
  assert.equal(await sender.locator('#auto-start').isDisabled(), true, 'A cleared sending password requires new input or explicit receiving intent');
  await sender.evaluate(() => document.querySelector('#auto-start').click());
  assert.equal(await sender.evaluate(() => window.__air.running), false);
  await sender.locator('#receive-instead').click();
  await enabled(sender, '#auto-start');
  await sender.locator('#auto-start').click();
  await waitText(sender, '#auto-status', 'Listening for the sender');
  assert.equal(await sender.locator('#auto-role').textContent(), 'RECEIVING DEVICE');
  await stopPair(pair);

  // Clipboard denial and a hidden page release the UI lock and never restore a
  // late clipboard result into a cleared field.
  await receiver.evaluate(() => { window.__holdClipboard = true; window.__releaseClipboard = null; });
  await receiver.locator('#auto-paste').click();
  await receiver.waitForFunction(() => typeof window.__denyClipboard === 'function');
  await receiver.evaluate(() => window.__denyClipboard(new DOMException('Denied for test', 'NotAllowedError')));
  await receiver.waitForFunction(() => !document.querySelector('#auto-paste').disabled);
  assert.equal(await receiver.locator('#auto-password').inputValue(), '');
  await receiver.locator('#receive-instead').click();
  await enabled(receiver, '#auto-start');
  await receiver.locator('#auto-paste').click();
  await receiver.waitForFunction(() => typeof window.__releaseClipboard === 'function');
  await hide(receiver);
  await receiver.evaluate(value => window.__releaseClipboard(value), dummy);
  await receiver.waitForTimeout(50);
  assert.equal(await receiver.locator('#auto-password').inputValue(), '', 'Late paste must not restore a hidden-page secret');
  assert.equal(await receiver.locator('#auto-start').isDisabled(), true);
  await stopPair(pair);
  console.log('PASS password startup: pending paste cannot start a silent receiver, Message -> Password reuse during receipt repair, autofill without input event, privacy-cleared intent, denied/late clipboard results.');
}

async function peerIdleChecks() {
  // Use the real configured deadlines with a controlled browser clock. Only
  // the acoustic room is substituted; no peer sends data in these cases.
  for (const [mode, timeout] of [['message',30000],['password',60000],['clear',120000],['message',3600000]]) {
    const context = await browser.newContext({viewport:{width:1280,height:720}});
    try {
      await context.route('**/auto-audio-link.mjs', route => route.fulfill({contentType:'text/javascript',body:stub}));
      await context.exposeBinding('__airSend', async () => {});
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({time:new Date('2026-10-30T12:00:00Z')});
      await page.goto(url+'?view=web');
      assert.equal(await page.locator('#peer-idle-timeout').inputValue(),'60000','A new page defaults to one minute');
      assert.deepEqual(await page.locator('#peer-idle-timeout option').evaluateAll(options=>options.map(option=>option.value)),['30000','60000','120000','300000','600000','1800000','3600000']);
      await page.locator('#mode-advanced').click();
      await page.locator('#peer-idle-timeout').selectOption(String(timeout));
      await page.locator(`#mode-${mode}`).click();
      assert.equal((await page.evaluate(()=>window.tonesealAgent.getState())).limits.peerIdleTimeoutMs,timeout);
      await page.locator('#auto-start').click();
      await page.waitForFunction(()=>window.tonesealAgent.getState().session.peerIdle?.remainingMs>0);
      // Pause only after crypto/startup completed, preserving real click and
      // permission-start ordering while making the deadline deterministic.
      await page.clock.pauseAt(await page.evaluate(()=>Date.now()+500));
      const running = await page.evaluate(()=>window.tonesealAgent.getState());
      assert.equal(running.session.active,true);
      assert.equal(running.session.peerIdle.timeoutMs,timeout,'The Advanced value reaches the controller unchanged');
      assert.equal(running.session.peerIdle.lastPeerAgeMs,null);
      if(timeout===3600000) {
        assert.equal(running.limits.chatLifetimeMs,7200000);
        assert.equal(running.limits.singleTransferLifetimeMs,7200000);
        assert.equal(await page.evaluate(()=>window.__air.options.maxRunMs),7200000);
      }
      assert.ok(running.session.peerIdle.remainingMs>0 && running.session.peerIdle.remainingMs<=timeout);
      assert.equal(await page.locator('#peer-idle-timeout').isDisabled(),true,'The setting is locked during audio');
      assert.equal(await page.evaluate(()=>window.__air.running),true);
      await page.clock.runFor(1000);
      assert.match(await page.locator('#peer-idle-countdown').innerText(),/audio stops in \d+:\d{2}/);
      const remaining = await page.evaluate(()=>window.tonesealAgent.getState().session.peerIdle.remainingMs);
      await page.clock.fastForward(remaining-1000);
      assert.equal((await page.evaluate(()=>window.tonesealAgent.getState())).session.active,true,'Audio is still active just before its deadline');
      await page.clock.fastForward(1001);
      await page.clock.runFor(50); // Flush the one-time status reveal frame.
      const stopped = await page.evaluate(()=>window.tonesealAgent.getState());
      assert.equal(stopped.session.active,false);
      assert.equal(stopped.session.phase,'error');
      assert.equal(stopped.session.peerIdle,null);
      assert.match(stopped.session.error.message,/No new peer response/);
      assert.equal(await page.evaluate(()=>window.__air.running),false,'The deadline stops the transport');
      assert.equal(await page.locator('#peer-idle-timeout').isDisabled(),false);
      assert.equal(await page.locator('#auto-start').isDisabled(),false);
      assert.match(await page.locator('#start-hint').innerText(),/No new peer response.*(?:Microphone and playback stopped|audio was released)/);
      const position = await page.evaluate(()=>({
        hint:document.querySelector('#start-hint').getBoundingClientRect().toJSON(),
        header:document.querySelector('#site-header').getBoundingClientRect().toJSON(),
        dock:document.querySelector('#audio-visuals').getBoundingClientRect().toJSON(),
      }));
      assert.ok(position.hint.top>=position.header.bottom-1 && position.hint.bottom<=position.dock.top+1,'The timeout explanation is visible between fixed header and dock');
      await page.clock.resume();
      await page.locator('#mode-advanced').click();
      await page.locator('#peer-idle-timeout').selectOption('60000');
      await page.locator(`#mode-${mode}`).click();
      await page.locator('#auto-start').click();
      await page.waitForFunction(()=>window.tonesealAgent.getState().session.peerIdle?.remainingMs>0);
      const restarted = await page.evaluate(()=>window.tonesealAgent.getState());
      assert.equal(restarted.session.active,true,'A timed-out page can start a fresh run');
      assert.equal(restarted.session.run,stopped.session.run+1);
      assert.equal(restarted.session.peerIdle.timeoutMs,60000);
      assert.equal(restarted.session.peerIdle.lastPeerAgeMs,null);
      assert.ok(restarted.session.peerIdle.remainingMs>59000);
      await page.locator('#header-stop').click();
      assert.equal(await page.evaluate(()=>window.__air.running),false);
      console.log(`PASS ${mode} peer timeout UI: actual ${timeout/1000}s configuration, locked control, live countdown, visible timeout reason, stopped audio and fresh restart under browser clock.`);
    } finally { await context.close(); }
  }
}

try {
  const {chromium} = await import(pathToFileURL(playwright));
  browser = await chromium.launch({executablePath:chrome, headless:true, args:['--mute-audio']});

  if (!args.includes('--real-only') && !args.includes('--password-only')) await peerIdleChecks();
  if (!args.includes('--real-only') && !args.includes('--idle-only')) await passwordStartupChecks();
  if (!args.includes('--real-only') && !args.includes('--password-only') && !args.includes('--idle-only')) {
  await roleAndExampleChecks();
  const automatic = await createPair();
  const simpleText = '<b>Automatic, literal text</b> é';
  await startPair(automatic, simpleText);
  const [a,b] = automatic.pages;
  await waitText(b, '#auto-received-text', simpleText);
  await waitText(a, '#auto-status', 'Delivery confirmed');
  assert.equal(await b.locator('#auto-received-text b').count(), 0);
  assert.equal(automatic.records.some(({bytes}) => Buffer.from(bytes).includes(Buffer.from(simpleText))), false);
  assert.equal(await a.locator('#auto-confirm').isVisible(), false, 'Simple mode requires no manual confirmation');
  assert.equal(await b.locator('#auto-confirm').isVisible(), false);
  assert.match(await a.locator('body').innerText(), /peer not verified/i, 'Simple mode must disclose the unverified peer');
  console.log('PASS automatic UI: Start both, no intermediate actions, encrypted delivery and receipt, literal HTML and unverified-peer disclosure.');

  await fs.mkdir(shots, {recursive:true});
  await a.screenshot({path:path.join(shots, 'desktop.png'), fullPage:true});
  await b.screenshot({path:path.join(shots, 'mobile.png'), fullPage:true});
  for (const page of [a,b]) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  }
  await stopPair(automatic);

  const telephone = await createPair();
  const telephoneText = 'A slower encrypted link ☎';
  await startPair(telephone, telephoneText, {profile:'telephone'});
  for (const page of telephone.pages) {
    assert.equal(await page.locator('#audio-profile').isDisabled(), true, 'The chosen audio profile cannot change during transfer');
    assert.equal(await page.evaluate(() => window.__air.options.profile), 'telephone', 'Both peers pass the selected profile to their transport');
    assert.match(await page.locator('#audio-profile-hint').innerText(), /both devices/i);
    assert.match(await page.locator('#start-hint').innerText(), /call connected/i);
  }
  await waitText(telephone.pages[1], '#auto-received-text', telephoneText);
  await waitText(telephone.pages[0], '#auto-status', 'Delivery confirmed');
  assert.equal(telephone.records.some(({bytes}) => Buffer.from(bytes).includes(Buffer.from(telephoneText))), false);
  await stopPair(telephone);
  for (const page of telephone.pages) {
    assert.equal(await page.locator('#audio-profile').isDisabled(), false);
    assert.equal(await page.locator('#audio-profile').inputValue(), 'telephone');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0, 'Profile selection is not persisted in browser storage');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'The longer telephone profile label fits the viewport');
  }
  await telephone.pages[0].screenshot({path:path.join(shots, 'telephone-desktop.png'), fullPage:true});
  await telephone.pages[1].screenshot({path:path.join(shots, 'telephone-mobile.png'), fullPage:true});
  console.log('PASS telephone profile UI: same explicit profile on both peers, locked during encrypted transfer, exact message and receipt, no stored selection.');

  for (const options of [{mode:'message',profile:'nearby',verify:false},{mode:'password',profile:'telephone',verify:true}]) {
    const compact = await createPair(), [sender,receiver] = compact.pages;
    const text = 'Compact dummy bytes é 🔑';
    await startPair(compact,text,{...options,cryptoProfile:'x25519'});
    for (const page of compact.pages) {
      assert.equal(await page.locator('#crypto-profile').isDisabled(),true);
      assert.match(await page.locator('#crypto-profile-hint').textContent(),/32 bytes/);
      assert.match(await page.locator('#crypto-profile-hint').textContent(),options.profile==='telephone'?/4\.8 seconds/:/3\.6 seconds/);
    }
    if (options.verify) {
      await sender.locator('#auto-confirm').waitFor({state:'visible'});
      await receiver.locator('#auto-confirm').waitFor({state:'visible'});
      assert.equal(await sender.locator('#auto-fingerprint').textContent(),await receiver.locator('#auto-fingerprint').textContent());
      await sender.locator('#auto-confirm').click();await receiver.waitForTimeout(200);
      assert.equal(await receiver.locator('#auto-received-secret').inputValue(),'');
      await receiver.locator('#auto-confirm').click();
    }
    if(options.mode==='password')await receiver.waitForFunction(value=>document.querySelector('#auto-received-secret').value===value,text,{timeout:45000});
    else await waitText(receiver,'#auto-received-text',text);
    await waitText(sender,'#auto-status','Delivery confirmed');
    assert.equal(compact.records.every(({bytes})=>bytes[0]===0xa7&&bytes[1]===3),true);
    assert.equal(compact.records.filter(({bytes})=>bytes[2]===1||bytes[2]===2).every(({bytes})=>bytes.length===51),true);
    assert.equal(compact.records.some(({bytes})=>Buffer.from(bytes).includes(Buffer.from(text))),false);
    await stopPair(compact);
    for(const page of compact.pages) {
      assert.equal(await page.locator('#crypto-profile').isDisabled(),false);
      assert.equal(await page.locator('#crypto-profile').inputValue(),'x25519');
      assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
    if(options.mode==='password') {
      await sender.screenshot({path:path.join(shots,'compact-desktop.png'),fullPage:true});
      await receiver.screenshot({path:path.join(shots,'compact-mobile.png'),fullPage:true});
    }
    await receiver.locator('#mode-clear').click();
    await receiver.locator('#mode-advanced').click();
    assert.equal(await receiver.locator('#crypto-profile').isDisabled(),false,'Advanced settings remain available after Clear text');
    assert.equal(await receiver.locator('#crypto-profile').inputValue(),'x25519','Clear text does not reset encrypted-mode settings');
    await receiver.locator('#mode-clear').click();
  }
  console.log('PASS compact advanced options: short X25519 records, Message and verified Telephone Password, exact receipt, locked choice, no downgrade or stored selection.');

  const unavailable = await createPair({unsupportedCompact:true});
  for(const page of unavailable.pages) {
    await page.locator('#mode-advanced').click();
    await page.waitForFunction(()=>!document.querySelector('#crypto-capability').textContent.includes('Checking'));
    assert.equal(await page.locator('#crypto-profile option[value="x25519"]').isDisabled(),true);
    assert.equal(await page.locator('#crypto-profile').inputValue(),'p256');
    await page.evaluate(()=>{const select=document.querySelector('#crypto-profile');select.value='x25519';select.dispatchEvent(new Event('change'));});
    await page.locator('#mode-message').click();
    assert.equal(await page.locator('#auto-start').isDisabled(),true);
    await page.evaluate(()=>document.querySelector('#auto-start').click());
    assert.equal(await page.evaluate(()=>Boolean(window.__air?.running)),false,'Unsupported Compact must not silently use Compatible');
    assert.equal(await page.locator('#crypto-profile').inputValue(),'x25519');
    await page.locator('#mode-advanced').click();
    await page.locator('#crypto-profile').selectOption('p256');
    await page.locator('#mode-message').click();
  }
  await startPair(unavailable,'Explicit Compatible still works');
  await waitText(unavailable.pages[1],'#auto-received-text','Explicit Compatible still works');
  await waitText(unavailable.pages[0],'#auto-status','Delivery confirmed');await stopPair(unavailable);
  console.log('PASS unavailable native X25519: Compact disabled with no silent fallback; explicitly selected Compatible still delivers.');

  const verified = await createPair();
  const verifiedText = 'Verify both screens before this arrives';
  await startPair(verified, verifiedText, {verify:true, senderFirst:true});
  const [v1,v2] = verified.pages;
  await v1.locator('#auto-confirm').waitFor({state:'visible'});
  await v2.locator('#auto-confirm').waitFor({state:'visible'});
  for (const page of [v1,v2]) {
    assert.equal(await page.locator('#transfer-next').getAttribute('href'),'#verification-panel');
    assert.match(await page.locator('#transfer-next').innerText(),/Compare fingerprints/);
  }
  await v1.locator('#transfer-next').click();
  const fingerprint = await v1.locator('#auto-fingerprint').textContent();
  assert.match(fingerprint, /^(?:[A-F0-9]{4} ){7}[A-F0-9]{4}$/);
  assert.equal(await v2.locator('#auto-fingerprint').textContent(), fingerprint);
  assert.equal(await v2.locator('#auto-received-text').textContent(), '');
  await v1.locator('#auto-confirm').click();
  await v2.waitForTimeout(1500);
  assert.equal(await v2.locator('#auto-received-text').textContent(), '', 'One confirmation cannot release the message');
  await v2.locator('#auto-confirm').click();
  await waitText(v2, '#auto-received-text', verifiedText);
  await waitText(v1, '#auto-status', 'Delivery confirmed');
  assert.match(await v1.locator('#fingerprint-instruction').innerText(), /confirmed the original pairing/i);
  await stopPair(verified);
  console.log('PASS verified UI: matching full fingerprints, no delivery before both confirmations, automatic completion afterwards.');

  let lostReceipt = false;
  const loss = await createPair({drop:({side,bytes}) => {
    if (!lostReceipt && side === 1 && bytes[0] === 0xa7 && bytes[2] === 3 && bytes.length === 44) { lostReceipt = true; return true; }
    return false;
  }});
  const lossText = 'Automatic recovery after the receipt is lost';
  await startPair(loss, lossText);
  const [l1,l2] = loss.pages;
  await waitText(l2, '#auto-received-text', lossText);
  await l2.locator('#auto-clear').click();
  await waitText(l1, '#auto-status', 'Delivery confirmed');
  assert.equal(lostReceipt, true);
  assert.equal(await l2.locator('#auto-received-text').textContent(), '', 'Retries must not redisplay a cleared message');
  const application = loss.records.filter(({side,bytes}) => side === 0 && bytes.length >= 32 && bytes[2] === 3 && new DataView(Uint8Array.from(bytes).buffer).getUint32(11, false) < 0x80000000);
  assert.ok(application.length >= 2);
  assert.deepEqual(application[0].bytes, application[1].bytes, 'Lost receipt retries identical ciphertext');
  await stopPair(loss);
  console.log('PASS automatic loss recovery: lost receipt, exact encrypted retry and no duplicate display.');

  const passwordPair = await createPair();
  const password = 'Dummy-auto-password_42!';
  await startPair(passwordPair, password, {mode:'password'});
  const [p1,p2] = passwordPair.pages;
  await p2.waitForFunction(value => document.querySelector('#auto-received-secret').value === value, password, {timeout:45000});
  assert.equal(await p2.locator('#auto-received-secret').getAttribute('type'), 'password');
  assert.equal((await p2.locator('body').innerText()).includes(password), false);
  assert.equal(await p2.evaluate(() => window.__clipboard), '');
  assert.equal(await p2.locator('#transfer-next').getAttribute('href'),'#received-panel');
  assert.match(await p2.locator('#transfer-next').innerText(),/Copy received password/);
  await p2.locator('#transfer-next').click();
  await p2.locator('#auto-copy').click();
  assert.equal(await p2.evaluate(() => window.__clipboard), password);
  await p2.waitForFunction(() => document.querySelector('#auto-received-secret').value === '');
  await waitText(p1, '#auto-status', 'Delivery confirmed');
  await hide(p1);
  assert.equal(await p1.locator('#auto-password').inputValue(), '');
  assert.equal(await p1.evaluate(() => window.__air.running), false);
  await stopPair(passwordPair);
  console.log('PASS automatic password flow: masked receipt, explicit Copy, no automatic clipboard write, hidden-page cleanup.');

  const clear = await createPair();
  const plain = 'Cleartext auto test';
  await startPair(clear, plain, {mode:'clear'});
  const [c1,c2] = clear.pages;
  await waitText(c2, '#auto-received-text', plain);
  await waitText(c1, '#auto-status', 'Delivery confirmed');
  await c2.waitForFunction(() => !window.__air.running);
  assert.ok(clear.records.some(({bytes}) => bytes[0] === 0xa8 && bytes[2] === 1 && Buffer.from(bytes).includes(Buffer.from(plain))));
  assert.ok(clear.records.some(({side,bytes}) => side === 1 && bytes[0] === 0xa8 && bytes[2] === 2), 'Receiver sends a cleartext ACK');
  assert.ok(clear.records.some(({side,bytes}) => side === 0 && bytes[0] === 0xa8 && bytes[2] === 3), 'Sender returns a final confirmation');
  assert.match(await c1.locator('#auto-status').textContent(), /unauthenticated|not authenticated/i);
  assert.equal(clear.records.filter(({side,bytes}) => side === 0 && bytes[2] === 1).length, 1, 'Healthy cleartext sends DATA once');
  await stopPair(clear);
  console.log('PASS automatic cleartext: DATA, matching ACK, final confirmation, no blind repeats and explicit unauthenticated receipt.');
  }

  if (!args.includes('--idle-only')) {
  // Real persistent transport, synth and streamed WASM decoding in Chromium.
  // A separate WebAudio graph supplies a synthetic microphone stream; no
  // physical microphone or room is used, and output playback is muted here.
  const realContext = await browser.newContext({viewport:{width:1024, height:900}});
  await realContext.addInitScript(() => {
    const NativeAudioContext = window.AudioContext, NativeWorker = window.Worker;
    window.__transportContexts = []; window.__playbackStarts = 0; window.__playbackRates = []; window.__outputGains = [];
    window.AudioContext = class extends NativeAudioContext {
      constructor(options) { super(options); window.__transportContexts.push(this); }
      createGain() { const gain = super.createGain(); window.__outputGains.push(gain); return gain; }
      createBufferSource() {
        const source = super.createBufferSource(), start = source.start;
        source.start = (...args) => { window.__playbackStarts++; window.__playbackRates.push(source.playbackRate.value); return start.apply(source, args); };
        return source;
      }
    };
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({data}) => {
          if (data.verified && data.pcm instanceof Int16Array) window.__renderedPCM = data.pcm.slice();
        });
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new NativeAudioContext({sampleRate:48000});
      window.__inputContext = context;
      window.__inputDestination = context.createMediaStreamDestination();
      await context.resume();
      window.__inputStream = window.__inputDestination.stream;
      return window.__inputStream;
    };
  });
  const real = await realContext.newPage();
  real.on('pageerror', error => errors.push(error.message));
  await real.goto(url+'?view=web'); await configureOneShot(real);
  await real.locator('#mode-password').click();
  await real.locator('#audio-profile').selectOption('telephone');
  await real.locator('#mode-advanced').click();
  await real.waitForFunction(()=>!document.querySelector('#crypto-profile option[value="x25519"]').disabled);
  await real.locator('#crypto-profile').selectOption('x25519');
  await real.locator('#mode-password').click();
  await real.locator('#auto-password').fill('Dummy-real-start_42!');
  await real.locator('#auto-start').click();
  try {
    await real.waitForFunction(() => window.__playbackStarts > 0 || document.querySelector('#auto-phase').textContent === 'Transfer stopped', {}, {timeout:30000});
    assert.ok(await real.evaluate(() => window.__playbackStarts > 0), 'Password should schedule playback');
    await real.waitForFunction(() => {
      const visual = window.tonesealAgent.getState().visuals;
      return visual?.active && visual.source === 'playback' && visual.motion === 'live';
    }, {}, {timeout:3000});
  }
  catch (error) {
    const state = await real.evaluate(() => ({phase:document.querySelector('#auto-phase').textContent,
      status:document.querySelector('#auto-status').textContent,audio:document.querySelector('#audio-note').textContent,
      role:document.querySelector('#auto-role').textContent, tracks:window.__inputStream?.getTracks().map(track => track.readyState),
      contexts:window.__transportContexts.map(context => context.state),plays:window.__playbackStarts}));
    throw new Error(`Password playback did not start: ${JSON.stringify(state)}`, {cause:error});
  }
  assert.equal(await real.locator('#auto-role').textContent(), 'SENDING DEVICE');
  assert.equal(await real.evaluate(() => window.__transportContexts.length), 1);
  assert.equal(await real.evaluate(() => window.__outputGains.length > 0 && window.__outputGains.every(gain => gain.gain.value === 1)), true, 'Real password playback uses full app gain');
  assert.equal(await real.evaluate(() => window.__playbackRates[0]), 0.75, 'Telephone password startup uses the slower playback rate');
  assert.equal(await real.evaluate(() => window.__renderedPCM.length), 98880, 'A compact 51-byte offer renders 2.06 seconds of canonical PCM');
  assert.equal(await real.evaluate(() => window.__renderedPCM?.some(sample => sample !== 0)), true, 'Password Start renders and schedules non-silent pairing audio');
  await real.locator('#auto-stop').click();
  assert.deepEqual(await real.evaluate(() => {
    const {active, source, motion} = window.tonesealAgent.getState().visuals;
    return {active, source, motion};
  }), {active:false, source:null, motion:'idle'}, 'Stop immediately clears the real password audio dock');
  assert.equal(await real.evaluate(() => window.__inputStream.getTracks().every(track => track.readyState === 'ended')), true);
  await real.evaluate(async () => {
    await window.__inputContext.close();
    window.__transportContexts = []; window.__renderedPCM = null; window.__playbackRates = [];
  });
  console.log('PASS real compact telephone password startup: native X25519, short verified pairing PCM, slower playback, live playback dock, Stop clearing, and preserved Start gesture.');
  for (const profile of ['nearby', 'telephone']) {
  await real.evaluate(async profile => {
    const {AutoAudioLink} = await import('./auto-audio-link.mjs');
    window.__packets = []; window.__realErrors = []; window.__realReady = false; window.__transportContexts = []; window.__playbackRates = [];
    window.__realLink = new AutoAudioLink({
      profile,
      onPackets:packets => window.__packets.push(...packets.map(packet => Array.from(packet))),
      onError:error => window.__realErrors.push(error.message),
    });
    document.querySelector('#real-start')?.remove();
    const button = document.createElement('button'); button.id = 'real-start'; button.textContent = 'Start real transport test';
    button.onclick = () => window.__realLink.start().then(() => { window.__realReady = true; }, error => window.__realErrors.push(error.message));
    document.body.append(button);
  }, profile);
  assert.equal(await real.evaluate(() => window.__transportContexts.length), 0);
  await real.locator('#real-start').click();
  await real.waitForFunction(() => window.__realReady || window.__realErrors.length, {}, {timeout:30000});
  assert.deepEqual(await real.evaluate(() => window.__realErrors), []);
  assert.equal(await real.evaluate(() => {
    const frame = window.__realLink.readAudioVisuals();
    window.__heldVisualFrame = frame;
    return Boolean(frame?.active && !frame.playing && frame.input instanceof Float32Array && frame.output instanceof Float32Array
      && frame.input.length === 2048 && frame.output.length === 2048 && frame.output.every(value => value === 0));
  }), true, 'Started real transport exposes bounded microphone and silent playback windows');
  const binary = Array.from({length:96}, (_, i) => (i * 73) & 255);
  await real.evaluate(packet => {
    window.__realSend = window.__realLink.send(Uint8Array.from(packet)).then(
      () => ({ok:true}), error => ({ok:false, error:error.message}));
  }, binary);
  await real.waitForFunction(() => {
    const frame = window.__realLink.readAudioVisuals();
    return frame?.playing && frame.output.some(value => Math.abs(value) > 0.0001);
  }, {}, {timeout:30000});
  assert.equal(await real.evaluate(() => {
    const frame = window.__realLink.readAudioVisuals(), held = window.__heldVisualFrame;
    return frame.input === held.input && frame.output === held.output && frame.profile === window.__realLink.profile.id
      && frame.sampleRate === window.__transportContexts[0].sampleRate;
  }), true, 'Live playback reuses the same bounded arrays and reports the real profile/sample rate');
  assert.deepEqual(await real.evaluate(() => window.__realSend), {ok:true});
  assert.equal(await real.evaluate(() => {
    const frame = window.__realLink.readAudioVisuals();
    return !frame.playing && frame.output.every(value => value === 0);
  }), true, 'Completed playback leaves no stale output waveform');
  assert.deepEqual(await real.evaluate(() => window.__playbackRates), [profile === 'telephone' ? 0.75 : 1], 'The real transport schedules the selected playback rate');
  assert.equal(await real.evaluate(() => window.__transportContexts.length), 1, 'Automated send reuses the context unlocked by Start');
  assert.equal(await real.evaluate(() => window.__realLink.running), true);
  await real.evaluate(playbackRate => {
    const context = window.__inputContext, pcm = window.__renderedPCM;
    if (!(pcm instanceof Int16Array) || !pcm.length) throw Error('Missing actual synth output');
    const buffer = context.createBuffer(1, pcm.length, 48000);
    buffer.getChannelData(0).set(Float32Array.from(pcm, value => value / 32768));
    const source = context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = playbackRate; source.connect(window.__inputDestination);
    window.__micPlayback = new Promise(resolve => { source.onended = resolve; source.start(); });
  }, profile === 'telephone' ? 0.75 : 1);
  await real.waitForFunction(() => {
    const frame = window.__realLink.readAudioVisuals();
    return frame && !frame.playing && frame.input.some(value => Math.abs(value) > 0.0001);
  }, {}, {timeout:3000});
  assert.equal(await real.evaluate(() => {
    const frame = window.__realLink.readAudioVisuals(), held = window.__heldVisualFrame;
    return frame.input === held.input && frame.output === held.output && frame.output.every(value => value === 0);
  }), true, 'Synthetic microphone audio reaches the input tap without becoming playback output');
  await real.evaluate(() => window.__micPlayback);
  await real.waitForFunction(() => window.__packets.length || window.__realErrors.length, {}, {timeout:15000});
  assert.deepEqual(await real.evaluate(() => window.__realErrors), []);
  assert.deepEqual(await real.evaluate(() => window.__packets), [binary]);
  // Stop during a second cached playback, so erasure is checked while the
  // retained output window still contains nonzero real analyser samples.
  await real.evaluate(packet => {
    window.__stopSend = window.__realLink.send(Uint8Array.from(packet)).then(
      () => ({completed:true}), error => ({completed:false, name:error.name}));
  }, binary);
  await real.waitForFunction(() => {
    const frame = window.__realLink.readAudioVisuals();
    return frame?.playing && frame.output.some(value => Math.abs(value) > 0.0001);
  }, {}, {timeout:3000});
  await real.evaluate(() => window.__realLink.stop());
  assert.deepEqual(await real.evaluate(() => window.__stopSend), {completed:false, name:'AbortError'});
  assert.equal(await real.evaluate(() => window.__realLink.readAudioVisuals()), null, 'Stopped transport provides no live frame');
  assert.equal(await real.evaluate(() => {
    const frame = window.__heldVisualFrame;
    return frame.input.every(value => value === 0) && frame.output.every(value => value === 0);
  }), true, 'Stop erases input and output buffers even in previously held frames');
  assert.equal(await real.evaluate(() => window.__transportContexts.length), 1, 'Live views and repeated playback never acquire another transport context');
  assert.equal(await real.evaluate(() => window.__inputStream.getTracks().every(track => track.readyState === 'ended')), true);
  assert.equal(await real.evaluate(() => window.__transportContexts.every(context => context.state === 'closed')), true);
  await real.evaluate(() => window.__inputContext.close());
  console.log(`PASS real ${profile} audio: one activated context, live input/output analyser taps, reused bounded windows, selected synth playback rate, streamed worklet/WASM decode, exact binary recovery and in-flight Stop erasure under deployed CSP.`);
  }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
