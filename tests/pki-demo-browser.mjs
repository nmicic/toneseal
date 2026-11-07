// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Native browser identity/session cryptography and actual artifact assembly.
// Only audio is substituted; accelerated timers are not an airtime benchmark.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const assets=option('--assets',path.join(root,'dist')),shots=option('--screenshots',path.join(root,'out/pki-demo-browser'));
const chrome=option('--chrome',process.env.CHROME_PATH);
const playwright=option('--playwright',process.env.PLAYWRIGHT_MODULE||path.join(root,'node_modules/playwright/index.mjs'));
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.wasm':'application/wasm','.json':'application/json'};
const csp="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const server=http.createServer(async(req,res)=>{
  try{
    let pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/artifact-transfer-real.mjs')pathname='/artifact-transfer.mjs';
    const file=path.resolve(assets,'.'+(pathname.endsWith('/')?pathname+'index.html':pathname));
    if(!file.startsWith(assets+path.sep))throw Error('Path refused');
    const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Security-Policy':csp,'Cache-Control':'no-store'});res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const audioStub=`export class AutoAudioLink {
 constructor(options={}){this.options=options;this.running=false;this.playing=false;this.generation=0;window.__air=this;}
 async start(){this.generation++;this.running=true;this.options.onStatus?.('Synthetic audio ready.');}
 async send(packet){if(!this.running)throw Error('Stopped');const token=this.generation;this.playing=true;await new Promise(resolve=>setTimeout(resolve,12));if(token!==this.generation)throw new DOMException('Stopped','AbortError');await window.__airSend(Array.from(packet));this.playing=false;}
 stop(){this.generation++;this.running=false;this.playing=false;}
}`;
const artifactWrapper=`import {ArtifactTransfer as Native} from './artifact-transfer-real.mjs';
export class ArtifactTransfer extends Native {
 constructor(options={}){super({...options,timing:{retryMs:120,retryJitterMs:20,turnaroundMs:5,initialDelayMs:5,maxRunMs:20000,lingerMs:400,maxAttempts:8}});window.__artifact=this;}
 start(options){if(options.bytes){options={...options,bytes:options.bytes.slice()};window.__publicEnvelope=Array.from(options.bytes);if(options.kind==='approval'&&window.__tamperApproval)options.bytes[options.bytes.length-1]^=1;}return super.start(options);}
}`;
const errors=[],contexts=[];let browser;
const wait=(page,fn,arg)=>page.waitForFunction(fn,arg,{timeout:25000});
const enabled=(page,id)=>wait(page,id=>!document.getElementById(id).disabled,id);
async function createPage(width){
  const context=await browser.newContext({viewport:{width,height:900}});contexts.push(context);
  await context.route('**/auto-audio-link.mjs',route=>route.fulfill({status:200,contentType:'text/javascript',body:audioStub}));
  await context.route('**/artifact-transfer.mjs',route=>route.fulfill({status:200,contentType:'text/javascript',body:artifactWrapper}));
  await context.addInitScript(()=>{
    window.__privateExports=0;window.__privateExtractability=[];
    const generate=crypto.subtle.generateKey.bind(crypto.subtle),exportKey=crypto.subtle.exportKey.bind(crypto.subtle);
    crypto.subtle.generateKey=(...args)=>generate(...args).then(keys=>{if(keys.privateKey)window.__privateExtractability.push(keys.privateKey.extractable);return keys;});
    crypto.subtle.exportKey=(format,key)=>{if(key.type==='private')window.__privateExports++;return exportKey(format,key);};
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return {context,page};
}
async function pair(){
  const peers=[await createPage(1280),await createPage(390)],records=[];
  for(let side=0;side<2;side++){
    await peers[side].context.exposeBinding('__airSend',async(_,bytes)=>{
      records.push({side,bytes});await peers[1-side].page.evaluate(bytes=>{const air=window.__air;if(air?.running&&!air.playing)air.options.onPackets([Uint8Array.from(bytes)]);},bytes);
    });
    await peers[side].page.goto(url+'pki-demo.html');
  }
  const [device,authority]=peers.map(peer=>peer.page);
  await authority.locator('#role-authority').click();
  await device.locator('#device-name').fill('Lab <sensor>');
  await device.locator('#create-device').click();await authority.locator('#create-authority').click();
  await wait(device,()=>document.getElementById('device-fingerprint').textContent.length>0);
  await wait(authority,()=>document.getElementById('authority-fingerprint').textContent.length>0);
  return {device,authority,records};
}
async function confirmBoth(a,b,checkBefore){
  await a.locator('#demo-confirm').waitFor({state:'visible',timeout:25000});await b.locator('#demo-confirm').waitFor({state:'visible',timeout:25000});
  assert.equal(await a.locator('#demo-fingerprint').textContent(),await b.locator('#demo-fingerprint').textContent());
  await a.locator('#demo-confirm').click();await b.waitForTimeout(60);await checkBefore?.();
  await b.locator('#demo-confirm').click();
}
async function request(p){
  await p.authority.locator('#receive-enrollment').click();await p.device.locator('#send-enrollment').click();
  await confirmBoth(p.device,p.authority,async()=>assert.equal(await p.authority.locator('#enrollment-panel').isVisible(),false));
  await p.authority.locator('#enrollment-panel').waitFor({state:'visible',timeout:25000});
  await wait(p.device,()=>!window.__artifact.state.active);await wait(p.authority,()=>!window.__artifact.state.active);
  assert.equal(await p.authority.locator('#request-name').textContent(),'Lab <sensor>');
  assert.equal(await p.authority.locator('#request-name sensor').count(),0);
  assert.equal(await p.authority.locator('#request-fingerprint').textContent(),await p.device.locator('#device-fingerprint').textContent());
  assert.equal(await p.device.evaluate(()=>window.__artifact.state.phase),'delivered');
}
async function reply(p,{tamper=false}={}){
  await enabled(p.authority,'approve-enrollment');await p.authority.locator('#approve-enrollment').click();await enabled(p.authority,'send-approval');
  if(tamper)await p.authority.evaluate(()=>{window.__tamperApproval=true;});
  await p.device.locator('#receive-approval').click();await p.authority.locator('#send-approval').click();
  await confirmBoth(p.authority,p.device,async()=>assert.equal(await p.device.locator('#approval-panel').isVisible(),false));
  await wait(p.authority,()=>!window.__artifact.state.active);await wait(p.device,()=>!window.__artifact.state.active);
}
try{
  const {chromium}=await import(pathToFileURL(playwright));browser=await chromium.launch({executablePath:chrome,headless:true,args:['--mute-audio']});await fs.mkdir(shots,{recursive:true});
  const main=await createPage(390);await main.page.goto(url+'?view=web');
  assert.equal(await main.page.locator('.mode-tabs button:visible').count(),4);
  assert.equal(await main.page.locator('#mode-showcase').isVisible(),false);
  await main.page.locator('#auto-text').fill('Keep my draft while changing settings');
  await main.page.locator('#mode-advanced').click();await main.page.locator('#mode-showcase').waitFor({state:'visible'});
  assert.equal(await main.page.locator('#advanced-options').isVisible(),true);
  assert.equal(await main.page.locator('#auto-text').isVisible(),false);
  assert.equal(await main.page.locator('.mode-tabs button:visible').count(),4);
  await wait(main.page,()=>!document.querySelector('#crypto-profile option[value="x25519"]').disabled);
  await main.page.locator('#crypto-profile').selectOption('x25519');
  await main.page.locator('#mode-message').click();await main.page.locator('#mode-showcase').waitFor({state:'hidden'});
  assert.equal(await main.page.locator('#crypto-profile').inputValue(),'x25519','Returning to Message retains the selected crypto profile');
  assert.equal(await main.page.locator('#auto-text').inputValue(),'Keep my draft while changing settings');
  await main.page.locator('#mode-advanced').click();await main.page.locator('#mode-showcase').click();
  await main.page.waitForURL('**/pki-demo.html');assert.match(await main.page.title(),/Signed enrollment/);
  assert.equal(await main.page.evaluate(()=>Boolean(window.__air?.running)),false,'Opening showcase does not start audio');
  await main.page.locator('a.quiet-link').click();await main.page.waitForURL('**/?advanced=1');
  await main.page.locator('#mode-showcase').waitFor({state:'visible'});
  assert.equal(await main.page.locator('#advanced-options').isVisible(),true,'Back link restores the Advanced tab');
  assert.equal(await main.page.locator('.mode-tabs button:visible').count(),4);
  console.log('PASS main page: four permanent tabs; Advanced contains crypto and Showcase; returning preserves draft and crypto; showcase navigation opens no microphone and returns to Advanced.');

  const normal=await pair();await request(normal);await reply(normal);
  await normal.device.locator('#approval-panel').waitFor({state:'visible'});
  assert.equal(await normal.device.locator('#authority-pin').inputValue(),'','Received signer must never populate the trust pin');
  assert.equal(await normal.device.locator('#accept-approval').isDisabled(),true);
  const trusted=await normal.authority.locator('#authority-fingerprint').textContent();
  assert.equal(await normal.device.locator('#received-authority-fingerprint').textContent(),trusted);
  await normal.device.locator('#authority-pin').fill('0'.repeat(64));await normal.device.locator('#accept-approval').click();
  await wait(normal.device,()=>document.getElementById('demo-notice').textContent.includes('Approval not accepted'));
  assert.equal(await normal.device.locator('#acceptance-status').textContent(),'');
  assert.equal(await normal.device.locator('#authority-pin').isEditable(),true);
  await normal.device.locator('#authority-pin').fill(trusted.replaceAll(' ','\n'));await normal.device.locator('#accept-approval').click();
  await wait(normal.device,()=>document.getElementById('acceptance-status').textContent.includes('Enrollment accepted'));
  assert.equal(await normal.device.locator('#authority-pin').isEditable(),false);
  assert.equal(await normal.device.locator('#accept-approval').isDisabled(),true);
  for(const page of [normal.device,normal.authority]){
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    assert.equal(await page.locator('input[type=file]').count(),0);
    assert.equal(await page.evaluate(()=>window.__privateExports),0);
    assert.equal(await page.evaluate(()=>window.__privateExtractability.every(value=>value===false)),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await normal.device.screenshot({path:path.join(shots,'device-accepted-desktop.png'),fullPage:true});
  await normal.authority.screenshot({path:path.join(shots,'authority-mobile.png'),fullPage:true});
  await normal.device.setViewportSize({width:320,height:844});
  assert.equal(await normal.device.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await normal.device.screenshot({path:path.join(shots,'device-accepted-mobile-320.png'),fullPage:true});
  const before=await normal.device.locator('#device-fingerprint').textContent();
  await normal.device.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;});
  assert.equal(await normal.device.locator('#device-fingerprint').textContent(),before,'Hiding stops audio but retains the in-memory identity');
  await normal.device.locator('#demo-reset').click();
  assert.equal(await normal.device.locator('#device-fingerprint').textContent(),'');assert.equal(await normal.device.locator('#authority-pin').inputValue(),'');
  assert.equal(await normal.device.locator('#acceptance-status').textContent(),'');assert.equal(await normal.device.evaluate(()=>window.__artifact.state.active),false);
  console.log('PASS signed enrollment: real native identity/signatures, encrypted multipart request+reply, explicit authority approval, no trust before manual pin, wrong pin rejected, matching full pin accepted, no private export/storage, Reset and responsive layout.');

  const corrupted=await pair();await request(corrupted);await reply(corrupted,{tamper:true});
  await wait(corrupted.device,()=>document.getElementById('demo-notice').textContent.includes('Signed envelope rejected'));
  assert.equal(await corrupted.device.locator('#approval-panel').isVisible(),false);
  assert.equal(await corrupted.device.locator('#acceptance-status').textContent(),'');
  assert.equal(await corrupted.device.locator('#authority-pin').inputValue(),'');
  console.log('PASS tampered signed reply: transport delivers exact mutated bytes but native signature validation refuses the approval and creates no trust decision.');
  assert.deepEqual(errors,[]);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
