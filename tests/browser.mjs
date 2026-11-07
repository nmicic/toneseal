// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Real Chromium with synthetic microphone input; never physical-device acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const lab=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);
const synth=path.resolve(process.env.JOTTUNE_SYNTH_ROOT||path.resolve(lab,'../jottune-synth'));
const option=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const assets=option('--assets',path.join(synth,'web')),wasm=option('--wasm',path.join(lab,'web/communication-decoder.wasm'));
const harness=option('--harness',path.join(synth,'build/s12e10p1v1/harness'));
const playwright=option('--playwright',process.env.PLAYWRIGHT_MODULE||path.join(lab,'node_modules/playwright/index.mjs'));
const executable=option('--chrome',process.env.CHROME_PATH);
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'jottune-acoustic-browser-'));
let browser,server,checks=0;
function run(executable,argv){const result=spawnSync(executable,argv,{encoding:'utf8',timeout:60000,maxBuffer:2**20});assert.equal(result.status,0,result.stderr);return result.stdout;}
try {
  const text='x'.repeat(127),delivery=JSON.parse(run(process.execPath,[path.join(lab,'cli.mjs'),'encode','--text',text,'--out',path.join(temporary,'input'),'--harness',harness]));
  server=http.createServer((request,response)=>{
    try {const name=decodeURIComponent(new URL(request.url,'http://localhost').pathname).slice(1);
      if(!name||name.split('/').some(part=>part==='..'||part===''))throw Error('Invalid asset');
      const file=name==='communication-decoder.wasm'?wasm:path.join(name.startsWith('communication')?path.join(lab,'web'):assets,name);
      const types={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm','.css':'text/css'};
      const content=fs.readFileSync(file);response.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Permissions-Policy':'microphone=(self), camera=()','Cache-Control':'no-store'});response.end(content);
    }catch{response.writeHead(404);response.end();}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {chromium}=await import(pathToFileURL(playwright));
  browser=await chromium.launch({executablePath:executable,headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+delivery.wav]});
  const context=await browser.newContext({acceptDownloads:true});
  await context.addInitScript(()=>{
    window.captureTest={calls:0,streams:[],deny:false,hold:false,resumeHold:false,release:null,contexts:[]};
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async options=>{const state=window.captureTest;state.calls++;if(state.deny)throw new DOMException('Microphone denied for this test','NotAllowedError');
      const stream=await original(options);state.streams.push(stream);if(state.hold)await new Promise(resolve=>state.release=resolve);return stream;};
    const Context=window.AudioContext;window.AudioContext=class extends Context{constructor(options){super(options);window.captureTest.contexts.push(this);}resume(){return window.captureTest.resumeHold?new Promise(()=>{}):super.resume();}};
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${server.address().port}/`;
  await page.goto(base+'communication.html');await page.locator('#message').waitFor();
  assert.deepEqual(await page.evaluate(()=>[captureTest.calls,captureTest.contexts.length]),[0,0]);checks++;
  const message='<b>hello</b> é';await page.locator('#message').fill(message);await page.locator('#prepare').click();
  await page.waitForFunction(()=>!document.querySelector('#loopback').disabled,{},{timeout:60000});
  assert.equal(await page.evaluate(()=>captureTest.contexts.length),0);checks++;
  await page.locator('#loopback').click();await page.waitForFunction(()=>document.querySelector('#received').textContent.includes('hello'),{},{timeout:60000});
  assert.equal(await page.locator('#received').innerText(),message);assert.equal(await page.locator('#received b').count(),0);checks++;
  const download=page.waitForEvent('download');await page.locator('#save-tl').click();const record=path.join(temporary,'download.tl');await(await download).saveAs(record);
  assert.match(run(harness,['--play',record]),/match=yes/);checks++;
  await page.locator('#play-message').click();await page.waitForFunction(()=>!document.querySelector('#stop-message').disabled);
  await page.locator('#stop-message').click();assert.equal(await page.locator('#stop-message').isDisabled(),true);checks++;
  await page.evaluate(()=>captureTest.deny=true);await page.locator('#capture').click();await page.waitForFunction(()=>document.querySelector('#communication-status').textContent.includes('denied'));
  assert.equal(await page.locator('#capture').isDisabled(),false);assert.ok(await page.evaluate(()=>captureTest.contexts.every(context=>context.state==='closed')));checks++;
  await page.evaluate(()=>captureTest.deny=false);await page.locator('#capture').click();await page.waitForFunction(()=>!document.querySelector('#finish-capture').disabled);
  await page.waitForTimeout(5200);await page.locator('#finish-capture').click();await page.waitForFunction(()=>document.querySelector('#received').textContent.includes('xxxxxxxx'),{},{timeout:60000});
  assert.ok((await page.locator('#received').innerText()).split('\n').every(row=>!row||row===text));
  assert.ok(await page.evaluate(()=>captureTest.streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))));checks++;
  await page.locator('#capture').click();await page.waitForFunction(()=>!document.querySelector('#finish-capture').disabled);await page.locator('#cancel').click();
  assert.ok(await page.evaluate(()=>captureTest.streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))));checks++;
  await page.evaluate(()=>captureTest.hold=true);await page.locator('#capture').click();await page.waitForFunction(()=>Boolean(captureTest.release));await page.locator('#cancel').click();await page.evaluate(()=>captureTest.release());
  await page.waitForFunction(()=>captureTest.streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')));assert.equal(await page.locator('#finish-capture').isDisabled(),true);checks++;
  await page.evaluate(()=>captureTest.hold=false);await page.locator('#capture-file').setInputFiles(delivery.wav);
  await page.waitForFunction(()=>document.querySelector('#received').textContent==='x'.repeat(127),{},{timeout:60000});checks++;
  await page.locator('#capture').click();await page.waitForFunction(()=>!document.querySelector('#finish-capture').disabled);await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.ok(await page.evaluate(()=>captureTest.streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))));checks++;
  await page.evaluate(()=>captureTest.resumeHold=true);await page.locator('#capture').click();
  await page.waitForFunction(()=>document.querySelector('#communication-status').textContent.includes('audio setup did not finish'),{},{timeout:25000});
  assert.ok(await page.evaluate(()=>captureTest.streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))));assert.equal(await page.locator('#capture').isDisabled(),false);checks++;
  assert.deepEqual(errors,[]);checks++;
  console.log(`PASS ${checks} Chromium native synthesis/Wasm/synthetic capture/permission/cancel/export groups; no physical microphone or air test`);
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
