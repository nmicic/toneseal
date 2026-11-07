// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Real Chromium + Web Crypto + application UI. Only the audio transport and
// OS clipboard are substituted; tests/audio-link.mjs covers the real codec.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const synth=process.env.JOTTUNE_SYNTH_ROOT || path.resolve(root,'../jottune-synth');
const playwright=option('--playwright',process.env.PLAYWRIGHT_MODULE||path.join(root,'node_modules/playwright/index.mjs'));
const chrome=option('--chrome',process.env.CHROME_PATH);
const dist=option('--assets',path.join(root,'dist'));
const screenshot=option('--screenshots',path.join(root,'out/browser'));
const csp="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.wasm':'application/wasm','.json':'application/json'};
const server=http.createServer(async(request,response)=>{
  try {
    const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    const file=path.resolve(dist,'.'+(pathname.endsWith('/')?pathname+'index.html':pathname));
    if (!file.startsWith(dist+path.sep)) throw Error('path');
    const bytes=await fs.readFile(file);
    response.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream',
      'Cache-Control':'no-store','Content-Security-Policy':csp,'Permissions-Policy':'microphone=(self), camera=(), geolocation=()',
      'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}); response.end(bytes);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/manual.html`;
const stub=`export class AudioLink {
  constructor(options={}) { this.options=options; this.prepared=null; this.busy=false; this.playing=false; this.recording=false; window.__audio=this; window.__preparedCount=0; }
  async prepare(packet) { this.clear(); this.prepared=Uint8Array.from(packet); window.__preparedCount++; this.options.onStatus?.('Test audio prepared.'); return {seconds:packet.length*.02,bytes:packet.length}; }
  async play() { if(!this.prepared)throw Error('No packet'); this.playing=true; this.options.onStatus?.('Test audio playing.'); window.__lastPlayed=Array.from(this.prepared); await new Promise(resolve=>setTimeout(resolve,5)); this.playing=false; this.options.onStatus?.('Playback finished.'); }
  async listen() { this.recording=true; this.options.onStatus?.('Test microphone listening.'); }
  async finish() { this.recording=false; const packets=(window.__incoming||[]).map(value=>Uint8Array.from(value)); window.__incoming=[]; this.options.onStatus?.('Test audio decoded.'); await this.options.onPackets?.(packets); return packets; }
  cancel() { this.busy=false; this.playing=false; this.recording=false; }
  clear() { this.cancel(); this.prepared=null; }
}`;
let browser;
const errors=[];
const waitText=(page,selector,part)=>page.waitForFunction(({selector,part})=>document.querySelector(selector)?.textContent.includes(part),{selector,part});
const enabled=(page,selector)=>page.waitForFunction(selector=>!document.querySelector(selector).disabled,selector);
async function prepare(page,text,kind='message') {
  await page.locator(kind==='password'?'#password':'#message').fill(text);
  await enabled(page,'#prepare-message');
  const before=await page.evaluate(()=>window.__preparedCount);
  await page.locator('#prepare-message').click();
  await page.waitForFunction(before=>window.__preparedCount>before,before);
  await waitText(page,'#packet-info',kind==='password'?'Encrypted password':'Encrypted message');
  await enabled(page,'#play');
}
async function inject(page,packets) {
  await enabled(page,'#listen'); await page.locator('#listen').click();
  await page.evaluate(value=>{window.__incoming=value;},packets);
  await page.locator('#finish').click();
}
async function transfer(sender,receiver) {
  await enabled(receiver,'#listen'); await receiver.locator('#listen').click();
  await enabled(sender,'#play'); await sender.locator('#play').click();
  await sender.waitForFunction(()=>!window.__audio.playing);
  const packet=await sender.evaluate(()=>window.__lastPlayed);
  assert.ok(packet?.length && packet.length<=128);
  await receiver.evaluate(value=>{window.__incoming=[value];},packet);
  await receiver.locator('#finish').click();
  return packet;
}
async function acknowledge(receiver,sender,pending=0) {
  await waitText(receiver,'#packet-info','Delivery receipt');
  await transfer(receiver,sender);
  await waitText(sender,'#delivery-status',pending?`${pending} encrypted message(s) awaiting receipt`:'Delivery confirmed');
}
async function mode(page,value) { await page.locator(`[data-mode="${value}"]`).click(); }
async function screenHidden(page) {
  await page.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,value:true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(()=>{
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
try {
  const {chromium}=await import(pathToFileURL(playwright));
  browser=await chromium.launch({executablePath:chrome,headless:true});
  async function pageAt(viewport) {
    const context=await browser.newContext({viewport});
    await context.route('**/audio-link.mjs',route=>route.fulfill({status:200,contentType:'text/javascript',body:stub}));
    await context.addInitScript(()=>{
      window.__clipboard='';
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
        readText:async()=>window.__clipboard,
        writeText:async text=>{window.__clipboard=text;}
      }});
      const encrypt=crypto.subtle.encrypt.bind(crypto.subtle);
      crypto.subtle.encrypt=(...args)=>{
        if (!window.__holdEncrypt) return encrypt(...args);
        return new Promise((resolve,reject)=>{
          window.__releaseEncrypt=()=>{
            window.__holdEncrypt=false;
            const operation=encrypt(...args); operation.then(resolve,reject); return operation;
          };
        });
      };
    });
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',dialog=>{errors.push('Unexpected script dialog: '+dialog.message()); dialog.dismiss();});
    await page.goto(url);
    await enabled(page,'#start-pair');
    return page;
  }
  const a=await pageAt({width:1280,height:1050}), b=await pageAt({width:390,height:844});
  assert.equal(await a.locator('#connection-badge').textContent(),'NOT PAIRED');
  assert.equal(await a.locator('#message').isEditable(),true,'Message can be drafted before pairing');
  await waitText(a,'#compose-hint','exchange the pairing offer and answer');
  await waitText(a,'#next-title','choose Device 1 and Device 2');
  assert.equal(await b.locator('#message').inputValue(),'');
  assert.equal(await a.locator('#role-choices').isVisible(),true);
  assert.equal(await b.locator('#role-choices').isVisible(),true);
  await a.locator('#message').fill('locked');
  assert.equal(await a.locator('#prepare-message').isDisabled(),true);
  await a.locator('#choose-device1').click(); await waitText(a,'#packet-info','Pairing offer');
  assert.equal(await a.locator('#role-choices').isVisible(),false,'Device 1 selection is reflected in the top banner');
  await waitText(a,'#device-role','DEVICE 1');
  await waitText(a,'#next-instruction','Device 2: tap Listen first');
  // A receiver does not accept unsolicited pairing until explicitly armed.
  const offer=await a.evaluate(()=>Array.from(window.__audio.prepared));
  await inject(b,[offer]); await waitText(b,'#status','Pairing offer ignored');
  assert.equal(await b.locator('#connection-badge').textContent(),'NOT PAIRED');
  await b.locator('#choose-device2').click();
  assert.equal(await b.locator('#role-choices').isVisible(),false,'Device 2 selection is reflected in the top banner');
  await waitText(b,'#device-role','DEVICE 2');
  await waitText(b,'#next-title','listen for the offer');
  await transfer(a,b); await waitText(b,'#packet-info','Pairing answer');
  assert.equal(await b.locator('#confirm-peer').isDisabled(),true,'Pairing answer must be played before local confirmation');
  await transfer(b,a); await waitText(a,'#status','Compare every fingerprint');
  const fingerprint=await a.locator('#fingerprint').textContent();
  assert.match(fingerprint,/^(?:[A-F0-9]{4} ){7}[A-F0-9]{4}$/);
  assert.equal(await b.locator('#fingerprint').textContent(),fingerprint);
  for (const page of [a,b]) {
    assert.equal(await page.locator('#next-fingerprint').isVisible(),true);
    assert.equal(await page.locator('#next-fingerprint').textContent(),fingerprint,'Confirm action shows the complete code beside it');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Fingerprint does not widen the viewport');
  }
  const codeBounds=await b.locator('#next-fingerprint').boundingBox();
  assert.ok(codeBounds.x>=0 && codeBounds.x+codeBounds.width<=390,'Mobile fingerprint fits within the visible width');
  await fs.mkdir(screenshot,{recursive:true});
  await b.locator('.next-step').screenshot({path:path.join(screenshot,'mobile-fingerprint.png')});
  assert.equal(await a.locator('#prepare-message').isDisabled(),true);
  // Hiding while encryption is still pending must not lose the packet's role.
  // After encryption completes, Restore must recover a confirmation (not the
  // previous offer) and must still require its completed audio playback.
  await a.evaluate(()=>{window.__holdEncrypt=true;});
  await a.locator('#confirm-peer').click();
  await a.waitForFunction(()=>typeof window.__releaseEncrypt==='function');
  await screenHidden(a);
  assert.equal(await a.locator('#play').isDisabled(),true);
  await a.evaluate(()=>window.__releaseEncrypt());
  await a.locator('#retry').click(); await waitText(a,'#packet-info','Peer confirmation');
  assert.equal(await a.locator('#prepare-message').isDisabled(),true);
  // Both users commonly confirm the matching screens before exchanging their
  // confirmations. Preparing each confirmation must not unlock message sending.
  await b.locator('#confirm-peer').click(); await waitText(b,'#packet-info','Peer confirmation');
  assert.equal(await b.locator('#prepare-message').isDisabled(),true);
  await waitText(b,'#connection-badge','SEND CONFIRMATION');
  // A repeated original offer must not make the unsent local confirmation
  // irretrievable when its cached answer replaces the latest transport packet.
  const confirmation=await b.evaluate(()=>Array.from(window.__audio.prepared));
  await inject(b,[offer]); await waitText(b,'#packet-info','Session control');
  assert.equal(await b.evaluate(()=>window.__audio.prepared[2]),2);
  await waitText(b,'#next-title','restore your confirmation');
  await b.locator('#next-action').click();
  await waitText(b,'#packet-info','Peer confirmation');
  assert.deepEqual(await b.evaluate(()=>Array.from(window.__audio.prepared)),confirmation,'Restore preserves exact confirmation ciphertext');
  await transfer(a,b); await waitText(b,'#status','Peer confirmed');
  assert.equal(await b.locator('#prepare-message').isDisabled(),true,'Own confirmation still needs playback');
  await waitText(b,'#connection-badge','SEND CONFIRMATION');
  assert.equal(await b.locator('#fingerprint-panel').isVisible(),true,'Keep verification visible until own confirmation played');
  await waitText(b,'#compose-hint','your confirmation still needs playback');
  await transfer(b,a);
  await waitText(a,'#connection-badge','READY TO SEND'); await waitText(b,'#connection-badge','READY TO SEND');
  await enabled(a,'#prepare-message');
  assert.equal(await b.locator('#prepare-message').isDisabled(),true,'An empty message stays disabled after pairing');
  await waitText(b,'#compose-hint','Pairing is complete. Type a message');
  await waitText(b,'#next-title','Device 2: ready to send');
  await b.locator('#message').fill('ready after four flights');
  await enabled(b,'#prepare-message');
  await b.locator('#message').fill('');
  assert.equal(await b.locator('#prepare-message').isDisabled(),true,'Clearing text restores the empty-message gate');
  console.log('PASS browser pairing: device timeline, both confirmations prepared, honest send locks, empty draft guidance, interrupted and overwritten confirmation recovery.');

  const hostile='<img src=x onerror=alert(1)> exact text';
  await prepare(a,hostile); const encrypted=await transfer(a,b);
  await waitText(b,'#received-text',hostile);
  assert.equal(await b.locator('#received-text img').count(),0);
  assert.equal(await b.locator('#received-kind').textContent(),'ENCRYPTED MESSAGE');
  assert.equal(Buffer.from(encrypted).includes(Buffer.from(hostile)),false);
  await waitText(a,'#delivery-status','1 encrypted message(s) awaiting receipt');
  await waitText(a,'#next-title','wait for a delivery receipt');
  assert.match(await a.locator('#next-action').textContent(),/Listen/);
  assert.equal(await a.locator('#rekey').isDisabled(),true,'Unacknowledged data blocks rekey');
  assert.equal(await b.locator('#rekey').isDisabled(),true,'Receipt playback comes before new sends/rekey');
  await inject(b,[[0,...new TextEncoder().encode('untrusted cleartext')]]);
  await waitText(b,'#status','Cleartext ignored');
  assert.equal(await b.locator('#received-text').textContent(),hostile);
  // Drop the first receipt. The sender retries identical ciphertext; the peer
  // acknowledges again without delivering or displaying the content twice.
  await b.locator('#clear-received').click();
  await a.locator('#retry-pending').click(); await waitText(a,'#packet-info','Encrypted retransmission');
  const repeated=await transfer(a,b); assert.deepEqual(repeated,encrypted);
  await waitText(b,'#packet-info','Delivery receipt');
  assert.equal(await b.locator('#received-text').textContent(),'');
  assert.equal(await b.locator('#copy-received').isDisabled(),true);
  await acknowledge(b,a);
  assert.equal(await a.locator('#retry-pending').isDisabled(),true);
  console.log('PASS browser message safety: authenticated delivery, HTML rendered as text, cleartext isolation, dropped receipt/retry with no duplicate delivery.');

  // Lose an application packet, deliver the next, then recover the hole using
  // the encrypted highest-sequence + bitmap receipt and bounded resend queue.
  await prepare(a,'first packet delayed');
  const delayed=await a.evaluate(()=>Array.from(window.__audio.prepared));
  await prepare(a,'second packet arrives first'); await transfer(a,b);
  await waitText(b,'#received-text','second packet arrives first');
  await waitText(a,'#delivery-status','2 encrypted message(s) awaiting receipt');
  await acknowledge(b,a,1);
  await a.locator('#retry-pending').click(); await waitText(a,'#packet-info','Encrypted retransmission');
  assert.deepEqual(await transfer(a,b),delayed);
  await waitText(b,'#received-text','first packet delayed');
  await acknowledge(b,a);
  console.log('PASS browser bitmap receipt: packet loss, out-of-order arrival, selective pending count and exact-packet recovery.');

  await mode(a,'password'); await mode(b,'password');
  const password='Dummy-password-only_!42';
  await a.evaluate(value=>{window.__clipboard=value;},password);
  await a.locator('#paste').click();
  await a.waitForFunction(value=>document.querySelector('#password').value===value,password);
  await a.locator('#prepare-message').click(); await waitText(a,'#packet-info','Encrypted password');
  assert.equal(await a.locator('#password').inputValue(),'');
  await transfer(a,b); await waitText(b,'#received-kind','ENCRYPTED PASSWORD');
  assert.equal(await b.locator('#received-secret').inputValue(),password);
  assert.equal(await b.locator('#received-secret').getAttribute('type'),'password');
  assert.equal((await b.locator('body').innerText()).includes(password),false);
  assert.equal(await b.evaluate(()=>window.__clipboard),'','reception does not automatically overwrite clipboard');
  await b.locator('#copy-received').click(); await waitText(b,'#status','Copied.');
  assert.equal(await b.evaluate(()=>window.__clipboard),password);
  assert.equal(await b.locator('#received-secret').inputValue(),'');
  assert.equal(await b.locator('#copy-received').isDisabled(),true);
  await acknowledge(b,a);
  await prepare(a,password,'password'); await transfer(a,b); await waitText(b,'#received-kind','ENCRYPTED PASSWORD');
  await screenHidden(b);
  assert.equal(await b.locator('#received-secret').inputValue(),'');
  assert.equal(await b.locator('#copy-received').isDisabled(),true);
  assert.equal(await b.evaluate(()=>window.__audio.prepared),null);
  assert.equal(await b.locator('#connection-badge').textContent(),'SEND RECEIPT');
  await b.locator('#retry').click(); await waitText(b,'#packet-info','Delivery receipt');
  await acknowledge(b,a);
  console.log('PASS browser password flow: explicit clipboard paste/copy, masked receipt, sender clearing, hide clears received secret and audio.');

  await mode(a,'message'); await mode(b,'message');
  const oldFingerprint=fingerprint;
  await enabled(a,'#rekey'); await a.locator('#rekey').click(); await waitText(a,'#connection-badge','REKEYING');
  await transfer(a,b); await waitText(b,'#packet-info','Session control');
  await transfer(b,a); await waitText(a,'#packet-info','Session control');
  await transfer(a,b); await waitText(b,'#connection-badge','SEND RESPONSE');
  assert.equal(await b.locator('#prepare-message').isDisabled(),true,'Pending rekey confirmation must be played');
  await transfer(b,a); await waitText(a,'#connection-badge','READY TO SEND');
  assert.notEqual(await a.locator('#fingerprint').textContent(),oldFingerprint);
  await prepare(a,'after key refresh'); await transfer(a,b); await waitText(b,'#received-text','after key refresh');
  await acknowledge(b,a);
  // Refresh initiated from responder exercises its extra authenticated request.
  await b.locator('#rekey').click(); await waitText(b,'#connection-badge','REKEYING');
  await transfer(b,a); await waitText(a,'#connection-badge','REKEYING');
  await transfer(a,b); await waitText(b,'#packet-info','Session control');
  await transfer(b,a); await waitText(a,'#packet-info','Session control');
  await transfer(a,b); await waitText(b,'#connection-badge','SEND RESPONSE');
  await transfer(b,a); await waitText(a,'#connection-badge','READY TO SEND');
  await prepare(b,'return path after refresh'); await transfer(b,a); await waitText(a,'#received-text','return path after refresh');
  await acknowledge(a,b);
  console.log('PASS browser encrypted rekey from both roles and subsequent bidirectional messaging.');

  await fs.mkdir(screenshot,{recursive:true});
  await a.screenshot({path:path.join(screenshot,'desktop.png'),fullPage:true});
  await b.screenshot({path:path.join(screenshot,'mobile.png'),fullPage:true});
  for (const page of [a,b]) {
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal overflow');
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0,'No session or message persistence');
  }
  await mode(b,'clear');
  assert.equal(await b.locator('#connection-badge').textContent(),'CLEARTEXT');
  assert.equal(await b.locator('#received-text').textContent(),'');
  await inject(b,[offer]); await waitText(b,'#status','Encrypted session packet ignored');
  await inject(b,[[0,...new TextEncoder().encode('plain demonstration')]]);
  await waitText(b,'#received-text','plain demonstration');
  assert.equal(await b.locator('#received-kind').textContent(),'UNAUTHENTICATED');
  await mode(b,'message');
  assert.equal(await b.locator('#connection-badge').textContent(),'NOT PAIRED');
  assert.equal(await b.locator('#received-text').textContent(),'');
  await a.locator('#disconnect').click();
  assert.equal(await a.locator('#connection-badge').textContent(),'NOT PAIRED');

  // A separate context uses the real transport, native synth worker, decoder
  // worker and WebAudio under the same CSP. This is digital loopback, not air.
  const realContext=await browser.newContext({viewport:{width:1024,height:900}});
  await realContext.addInitScript(()=>{
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message',({data})=>{
          if(data.verified && data.pcm instanceof Int16Array) window.__renderedPCM=data.pcm.slice();
        });
      }
    };
  });
  const real=await realContext.newPage();
  real.on('pageerror',error=>errors.push(error.message));
  await real.goto(url); await enabled(real,'#start-pair'); await mode(real,'clear');
  const loopbackText='Real browser audio path';
  await real.locator('#message').fill(loopbackText);
  await real.locator('#prepare-message').click(); await waitText(real,'#packet-info','Cleartext message');
  const recovered=await real.evaluate(async()=>{
    const samples=Float32Array.from(window.__renderedPCM,value=>value/32768);
    return new Promise((resolve,reject)=>{
      const worker=new Worker('./packet-worker.mjs',{type:'module'});
      const timeout=setTimeout(()=>{worker.terminate();reject(Error('Loopback timeout'));},60000);
      worker.onmessage=({data})=>{clearTimeout(timeout);worker.terminate();data.ok?resolve(data.packets.map(packet=>Array.from(packet))):reject(Error(data.error));};
      worker.onerror=event=>{clearTimeout(timeout);worker.terminate();reject(Error(event.message));};
      worker.postMessage({samples,rate:48000},[samples.buffer]);
    });
  });
  assert.deepEqual(recovered,[[0,...new TextEncoder().encode(loopbackText)]]);
  await real.locator('#play').click(); await waitText(real,'#status','Playback finished.');
  await enabled(real,'#play'); await realContext.close();
  assert.deepEqual(errors,[],'No application JavaScript errors or injected dialogs');
  console.log('PASS browser mode resets, no stored session data, cleartext display, desktop/mobile layout.');
  console.log('PASS real browser transport: synth worker/canonical replay, decoder worker digital loopback, completed WebAudio playback under CSP.');
  console.log(`Screenshots: ${screenshot}`);
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
