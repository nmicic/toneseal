// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Actual UI/native crypto across Chromium and WebKit. The room is substituted;
// accelerated timing checks behavior, while chat-simulation checks airtime.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const assets=option('--assets',path.join(root,'dist')),shots=option('--screenshots',path.join(root,'out/chat-browser'));
const playwright=option('--playwright',process.env.PLAYWRIGHT_MODULE||path.join(root,'node_modules/playwright/index.mjs'));
const chrome=option('--chrome',process.env.CHROME_PATH);
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.wasm':'application/wasm','.json':'application/json'};
const csp="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
const server=http.createServer(async(req,res)=>{
  try{
    let name=new URL(req.url,'http://localhost').pathname;if(name==='/chat-transfer-real.mjs')name='/chat-transfer.mjs';
    const file=path.resolve(assets,'.'+(name.endsWith('/')?name+'index.html':name));if(!file.startsWith(assets+path.sep))throw Error('Path refused');
    const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Security-Policy':csp});res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const stub=`export class AutoAudioLink {
 constructor(options={}){this.options=options;this.running=false;this.playing=false;this.generation=0;this.metrics={txFrames:0,txBytes:0,rxFrames:0,rxBytes:0};window.__air=this;}
 async start(){this.generation++;this.running=true;this.options.onStatus?.('Synthetic room ready');}
 async send(packet){if(!this.running)throw Error('Stopped');const token=this.generation;this.playing=true;await new Promise(resolve=>setTimeout(resolve,15));if(token!==this.generation)throw new DOMException('Stopped','AbortError');await window.__airSend(Array.from(packet));this.playing=false;this.metrics.txFrames++;this.metrics.txBytes+=packet.length;this.options.onMetrics?.({...this.metrics});}
 stop(){this.generation++;this.running=false;this.playing=false;}
}`;
const wrapper=`import {ChatTransfer as Native} from './chat-transfer-real.mjs';
export class ChatTransfer extends Native {constructor(options={}){super({...options,timing:{retryMs:180,retryJitterMs:20,turnaroundMs:12,initialDelayMs:5,turnTimeoutMs:400,idlePollMs:35,maxIdlePollMs:120,maxRunMs:45000,maxAttempts:20,closeTimeoutMs:6000,closeMaxAttempts:3,closeLingerMs:1800}});window.__chat=this;}}`;
const errors=[],browsers=[],contexts=[];
const wait=(page,fn,arg)=>page.waitForFunction(fn,arg,{timeout:20000});
async function pair(aBrowser,bBrowser,{compact=false,verify=false}={}){
  const p={pages:[],records:[],blocked:false,dropNext:false};
  for(const [side,browser] of [aBrowser,bBrowser].entries()){
    const context=await browser.newContext({viewport:side?{width:390,height:844}:{width:1280,height:900},hasTouch:Boolean(side)});contexts.push(context);
    await context.route('**/auto-audio-link.mjs',route=>route.fulfill({contentType:'text/javascript',body:stub}));
    await context.route('**/chat-transfer.mjs',route=>route.fulfill({contentType:'text/javascript',body:wrapper}));
    await context.addInitScript(()=>{
      window.__mediaRequests=0;window.__copied='';
      navigator.mediaDevices.getUserMedia=async()=>{window.__mediaRequests++;throw Error('Room is synthetic');};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}});
    });
    await context.exposeBinding('__airSend',async(_,bytes)=>{
      p.records.push({side,bytes});
      if(p.blocked)return;
      if(p.dropNext&&bytes[2]===3&&new DataView(Uint8Array.from(bytes).buffer).getUint32(11,false)<0x80000000){p.dropNext=false;return;}
      const peer=p.pages[1-side];if(!peer)return;
      await peer.evaluate(bytes=>{const air=window.__air;if(air?.running&&!air.playing){air.metrics.rxFrames++;air.metrics.rxBytes+=bytes.length;air.options.onMetrics?.({...air.metrics});void air.options.onPackets([Uint8Array.from(bytes)]);}},bytes);
    });
    const page=await context.newPage();p.pages.push(page);page.on('pageerror',error=>errors.push(error.message));await page.goto(url+'?view=web');
    assert.equal(await page.locator('#chat-enabled').isChecked(),true);
    assert.equal(await page.locator('#playback-value').textContent(),'100%');
    if(compact){await page.locator('#mode-advanced').click();await wait(page,()=>!document.querySelector('#crypto-profile option[value=x25519]').disabled);await page.locator('#crypto-profile').selectOption('x25519');await page.locator('#mode-message').click();}
    await page.locator('#verify-peer').setChecked(verify);
  }
  return p;
}
async function connect(p,{verify=false}={}){
  const [a,b]=p.pages;await a.locator('#auto-text').fill('First <message> é');await b.locator('#auto-start').click();await a.locator('#auto-start').click();
  if(verify){
    for(const page of p.pages)await page.locator('#auto-confirm').waitFor({state:'visible'});
    assert.equal(await a.locator('#auto-fingerprint').textContent(),await b.locator('#auto-fingerprint').textContent());
    assert.equal(await b.locator('#chat-history li').count(),0);
    await a.locator('#auto-confirm').click();assert.equal(await b.locator('#chat-history li').count(),0);
    await b.locator('#auto-confirm').click();
  }
  for(const page of p.pages)await wait(page,()=>window.__chat?.state.connected);
  await wait(a,()=>document.querySelector('#chat-history .chat-receipt')?.textContent.startsWith('Delivered'));
  assert.equal(await b.locator('#chat-history li p').textContent(),'First <message> é');
  assert.equal(await b.locator('#chat-history message').count(),0);
  for(const page of p.pages){assert.equal(await page.locator('#auto-end').textContent(),'End chat');assert.equal(await page.locator('#auto-stop').textContent(),'Stop now');assert.equal(await page.locator('#auto-text').isEnabled(),true);assert.equal(await page.evaluate(()=>window.__air.options.volume),1);}
}
async function send(page,text){
  await page.locator('#auto-text').fill(text);await page.locator('#auto-start').click();
  try{await wait(page,()=>document.getElementById('auto-text').value==='');}
  catch(error){throw Error(JSON.stringify(await page.evaluate(()=>({state:window.__chat?.state,button:document.getElementById('auto-start').textContent,status:document.getElementById('auto-status').textContent,hint:document.getElementById('input-hint').textContent,history:document.getElementById('chat-history').textContent}))),{cause:error});}
}
async function drain(p){for(const page of p.pages)await wait(page,()=>window.__chat.state.pendingCount===0);}
try{
  const {chromium,webkit}=await import(pathToFileURL(playwright));
  const chromeBrowser=await chromium.launch({executablePath:chrome,headless:true,args:['--mute-audio']});browsers.push(chromeBrowser);
  const safari=await webkit.launch({headless:true});browsers.push(safari);await fs.mkdir(shots,{recursive:true});
  for(const compact of [false,true]){
    const p=await pair(chromeBrowser,safari,{compact,verify:compact});await connect(p,{verify:compact});const [a,b]=p.pages;
    const fingerprint=await a.locator('#auto-fingerprint').textContent();
    await Promise.all([send(a,'A replies while B writes'),send(b,'B replies while A writes')]);await drain(p);
    assert.equal(await a.locator('#chat-history li.incoming p').textContent(),'B replies while A writes');
    assert.equal(await b.locator('#chat-history li.incoming').count(),2);
    p.dropNext=true;await send(b,'Repair the dropped DATA exactly');await drain(p);
    assert.equal(await a.locator('#chat-history li.incoming').count(),2);
    assert.equal(await a.locator('#auto-fingerprint').textContent(),fingerprint,'Later messages reuse established keys');
    const offers=p.records.filter(x=>x.side===0&&x.bytes[2]===1);
    assert.equal(new Set(offers.map(x=>Buffer.from(x.bytes).toString('hex'))).size,1);
    assert.equal(offers[0].bytes[1],compact?7:6);
    assert.equal(p.records.some(x=>Buffer.from(x.bytes).includes(Buffer.from('First <message>'))),false);
    await a.locator('#chat-history li.incoming .text-button').first().click();assert.equal(await a.evaluate(()=>window.__copied),'B replies while A writes');
    await a.locator('#link-diagnostics summary').click();
    await a.evaluate(()=>window.__air.options.onMetrics({...window.__air.metrics,crcRejectedCandidates:3,decoderErrors:0,inputRms:.1,inputPeak:.2}));
    assert.equal(await a.locator('#metric-crc').textContent(),'3');
    assert.match(await a.locator('#metric-level').textContent(),/-20 dBFS/);
    await a.screenshot({path:path.join(shots,`${compact?'compact':'compatible'}-desktop.png`),fullPage:true});
    await b.locator('#chat-panel').evaluate(node=>node.scrollIntoView({block:'start'}));
    await b.screenshot({path:path.join(shots,`${compact?'compact':'compatible'}-mobile.png`)});
    assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    p.blocked=true;
    for(let i=0;i<8;i++)await send(a,`Queued ${i}`);
    await a.locator('#auto-text').fill('Keep my ninth draft');
    assert.equal(await a.locator('#auto-start').isDisabled(),true);assert.match(await a.locator('#input-hint').textContent(),/Queue full/);
    p.blocked=false;await drain(p);
    assert.equal(await a.locator('#auto-text').inputValue(),'Keep my ninth draft');assert.equal(await a.locator('#auto-start').isEnabled(),true);
    assert.equal(await b.locator('#chat-history li.incoming').count(),10,'Every admitted peer message appears exactly once');
    p.blocked=true;
    await Promise.all([send(a,'A queued before close'),send(b,'B queued before close')]);
    await a.locator('#auto-text').fill('Retain unsent A draft');await b.locator('#auto-text').fill('Retain unsent B draft');
    const requester=compact?b:a,peer=compact?a:b;
    await requester.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    assert.ok((await requester.locator('#header-stop').boundingBox()).y>=0,'End chat remains reachable while reading the transcript');
    await requester.locator('#header-stop').click();
    await wait(requester,()=>window.tonesealAgent.getState().session.closing);
    assert.equal(await requester.locator('#header-stop').textContent(),'Stop now');
    assert.equal(await requester.locator('#auto-start').isDisabled(),true);assert.equal(await requester.locator('#auto-end').isDisabled(),true);
    assert.match(await requester.locator('#input-hint').textContent(),/Closing/);assert.doesNotMatch(await requester.locator('#input-hint').textContent(),/Queue full/);
    assert.ok(await requester.locator('#chat-history li.outgoing .chat-receipt').evaluateAll(nodes=>nodes.some(node=>node.textContent==='Pending')));
    assert.equal(await requester.evaluate(()=>window.tonesealAgent.getState().nextAction),'wait_for_close_or_stop_now');
    p.blocked=false;
    for(const page of p.pages)await wait(page,()=>!window.tonesealAgent.getState().session.active);
    for(const page of p.pages){
      const closed=await page.evaluate(()=>window.tonesealAgent.getState());
      assert.equal(closed.session.phase,'closed');assert.equal(closed.session.close.outcome,'confirmed');
      assert.equal(closed.queue.pending,0);assert.equal(closed.queue.canEnqueue,false);assert.equal(await page.evaluate(()=>window.__air.running),false);
      assert.equal(await page.locator('#chat-history li.outgoing .chat-receipt').evaluateAll(nodes=>nodes.every(node=>node.textContent.startsWith('Delivered'))),true);
      assert.equal(await page.locator('#auto-fingerprint').textContent(),'');
    }
    assert.equal((await peer.evaluate(()=>window.tonesealAgent.getState())).session.close.localRequested,false,'Peer closes without a local End chat click');
    assert.equal(await a.locator('#auto-text').inputValue(),'Retain unsent A draft');assert.equal(await b.locator('#auto-text').inputValue(),'Retain unsent B draft');
    assert.equal(await a.locator('#chat-history li.incoming').count(),3);assert.equal(await b.locator('#chat-history li.incoming').count(),11);
    await b.locator('#auto-text').fill('Discard this draft when hidden');
    await b.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;});
    assert.equal(await b.locator('#chat-history li').count(),0);assert.equal(await b.locator('#auto-text').inputValue(),'');assert.equal(await b.evaluate(()=>window.__air.running),false);
    assert.equal(await b.locator('#auto-start').textContent(),'Start receiving');assert.match(await b.locator('#byte-count').textContent(),/^0 /);
    assert.equal(await b.evaluate(()=>localStorage.length+sessionStorage.length),0);
    console.log(`PASS ${compact?'X25519 verified / responder close':'P-256 simple / initiator close'} Chrome/WebKit chat: exact bidirectional messages, loss/queue repair, admitted-message drain, automatic peer close, unsent draft retention, truthful close receipts, privacy and mobile layout.`);
  }
  const interrupted=await pair(chromeBrowser,safari);await connect(interrupted);
  const [left,right]=interrupted.pages;interrupted.blocked=true;
  await send(left,'This message remains unconfirmed');await left.locator('#auto-text').fill('Unsent draft survives Stop now');
  await left.locator('#auto-end').click();await wait(left,()=>window.tonesealAgent.getState().session.closing);
  await left.locator('#header-stop').click();
  const stopped=await left.evaluate(()=>window.tonesealAgent.getState());
  assert.equal(stopped.session.active,false);assert.equal(stopped.session.phase,'stopped');assert.equal(stopped.session.close.outcome,'aborted');
  assert.equal(stopped.messages.at(-1).delivery,'unconfirmed');assert.equal(await left.evaluate(()=>window.__air.running),false);
  assert.equal(await left.locator('#auto-text').inputValue(),'Unsent draft survives Stop now');
  await right.locator('#auto-end').click();await wait(right,()=>window.tonesealAgent.getState().session.closing);
  await right.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;});
  assert.equal(await right.evaluate(()=>window.__air.running),false);assert.equal(await right.locator('#chat-history li').count(),0);
  console.log('PASS closing can be interrupted immediately by header Stop now or page hiding; pending messages remain Unconfirmed and drafts/privacy are truthful.');
  assert.deepEqual(errors,[]);
}finally{for(const context of contexts)await context.close();for(const browser of browsers)await browser.close();await new Promise(resolve=>server.close(resolve));}
