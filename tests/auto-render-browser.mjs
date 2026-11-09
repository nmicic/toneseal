// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Real browser worker/Wasm checks; no microphone or audio device is required.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const synth=process.env.JOTTUNE_SYNTH_ROOT||path.resolve(root,'../jottune-synth');
const playwright=option('--playwright',process.env.PLAYWRIGHT_MODULE||path.join(root,'node_modules/playwright/index.mjs'));
const chrome=option('--chrome',process.env.CHROME_PATH);
const dist=option('--assets',path.join(root,'dist')),counts=new Map();
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.wasm':'application/wasm','.json':'application/json'};
const csp="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
const server=http.createServer(async(request,response)=>{
  try{
    const name=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    const filename=path.resolve(dist,'.'+(name==='/'?'/index.html':name));
    if(!filename.startsWith(dist+path.sep))throw Error('path');
    const bytes=await fs.readFile(filename);counts.set(name,(counts.get(name)||0)+1);
    response.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-store','Content-Security-Policy':csp});
    response.end(bytes);
  }catch{response.writeHead(404);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  const {chromium}=await import(pathToFileURL(playwright));
  browser=await chromium.launch({executablePath:chrome,headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const measured=await page.evaluate(async()=>{
    const {AutoAudioLink}=await import('./auto-audio-link.mjs');
    const {payloadTimeline}=await import('./communication-codec.mjs');
    const link=new AutoAudioLink(),rows=[];
    const hash=async pcm=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pcm)),x=>x.toString(16).padStart(2,'0')).join('');
    const packets=[84,32,128].map(size=>Uint8Array.from({length:size},(_,i)=>(i*71+size)&255));
    for(const packet of packets){const start=performance.now();const pcm=await link.prepare(packet,link.generation);rows.push({bytes:packet.length,ms:Math.round(performance.now()-start),hash:await hash(pcm),audioMs:pcm.length/48});}
    window.renderCheck={link,hash,packets,payloadTimeline};
    return {rows,engine:link.engine};
  });
  const wasm='/'+measured.engine.browser_wasm,runtime='/'+measured.engine.runtime_module;
  assert.equal(counts.get('/auto-render-worker.mjs'),1,'one persistent renderer per run');
  assert.equal(counts.get(wasm),1,'all canonical passes and later packets share one digest-checked engine download');
  if(measured.engine.runtime_module)assert.equal(counts.get(runtime),2,'archived runtime is fetched once for verification and once for module import');
  const checked=await page.evaluate(async()=>{
    const {link,hash,packets,payloadTimeline}=window.renderCheck;
    const engine=link.engine,recordText=payloadTimeline(packets[0],engine.identity);
    const worker=new Worker(new URL('./worker.mjs',location.href),{type:'module'});
    const original=data=>new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data);worker.onerror=event=>reject(Error(event.message));worker.postMessage(data);});
    let fresh=await original({recordText,engine,mode:'verify'});
    fresh=await original({recordText:new TextDecoder().decode(fresh.canonical),engine,mode:'verify'});
    const reference={hash:await hash(fresh.pcm),verified:fresh.verified};worker.terminate();
    const badIdentity=await link.renderJob({recordText,engine:{...engine,identity:'incorrect cached identity'},mode:'verify'},link.generation);
    const badDigest=await link.renderJob({recordText,engine:{...engine,browser_sha256:'0'.repeat(64)},mode:'verify'},link.generation);
    const restored=await link.renderJob({recordText,engine,mode:'verify'},link.generation);
    link.stop();
    return {reference,badIdentity:{verdict:badIdentity.verdict,stderr:badIdentity.stderr},badDigest:{verdict:badDigest.verdict,stderr:badDigest.stderr},restored:restored.verdict,stopped:link.renderWorker===null};
  });
  assert.equal(checked.reference.verified,true,'original renderer completes canonical verification');
  assert.equal(measured.rows[0].hash,checked.reference.hash,'cached renderer produces byte-identical PCM to unchanged fresh renderer');
  assert.equal(checked.badIdentity.verdict,'refused','cached bytes still enforce native registry identity');
  assert.match(checked.badIdentity.stderr,/identity/i);
  assert.equal(checked.badDigest.verdict,'refused','changing expected digest cannot reuse previously valid cached bytes');
  assert.match(checked.badDigest.stderr,/checksum/i);
  assert.equal(checked.restored,'valid');assert.equal(checked.stopped,true);
  const wasmBefore=counts.get(wasm),workersBefore=counts.get('/auto-render-worker.mjs');
  const restarted=await page.evaluate(async()=>{
    const {link,hash,packets}=window.renderCheck;
    const pcm=await link.prepare(packets[0],link.generation),result=await hash(pcm);link.stop();return result;
  });
  assert.equal(restarted,measured.rows[0].hash);
  assert.equal(counts.get(wasm),wasmBefore+1,'Stop discards cached engine bytes before a new run');
  assert.equal(counts.get('/auto-render-worker.mjs'),workersBefore+1,'new run gets a fresh worker');
  const ultrasonic=await page.evaluate(async()=>{
    const {AutoAudioLink}=await import('./auto-audio-link.mjs');
    const {StreamingDecoder}=await import('./auto-decoder.mjs');
    const packet=window.renderCheck.packets[2],link=new AutoAudioLink({profile:'ultrasonic'});
    try{
      const pcm=await link.prepare(packet,link.generation);
      const wasm=await WebAssembly.compile(await(await fetch('./communication-decoder.wasm')).arrayBuffer());
      const receiver=await StreamingDecoder.create(wasm,48000,'ultrasonic'),samples=new Float32Array(pcm.length+14400),decoded=[];
      samples.set(Float32Array.from(pcm,value=>value/32768));
      for(let i=0;i<samples.length;i+=2048)decoded.push(...receiver.push(samples.slice(i,i+2048)));
      return {audioMs:pcm.length/48,exact:decoded.length===1&&decoded[0].length===packet.length&&decoded[0].every((value,i)=>value===packet[i])};
    }finally{link.stop();}
  });
  assert.equal(ultrasonic.audioMs,8320);assert.equal(ultrasonic.exact,true,'real browser Worker synth and receiver preserve the maximum ultrasonic packet');
  assert.deepEqual(errors,[]);
  console.log('PASS browser renderer: one engine fetch per run, original canonical verification and exact PCM preserved, cached identity/checksum rejection, Stop clears cache.');
  console.log(JSON.stringify({preparation:measured.rows.map(({hash,...row})=>row)}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
