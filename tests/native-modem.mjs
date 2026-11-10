// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {payloadTimeline,readCaptureWav,pcmWav} from '../web/communication-codec.mjs';
import {StreamingDecoder} from '../web/auto-decoder.mjs';
const driver=process.env.TONESEAL_MODEM||'build/modem-driver';
if(!process.env.TONESEAL_MODEM)execFileSync('python3',['scripts/build-cli.py','--modem-driver',...(process.env.TONESEAL_SANITIZE?['--sanitize']:[])],{stdio:'pipe'});
const run=(...args)=>execFileSync(driver,args,{encoding:'utf8',maxBuffer:1024*1024});
const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/codec-vectors.json',import.meta.url),'utf8'));
test('native tone timelines match the browser encoder exactly',()=>{
  for(const profile of ['nearby','ultrasonic'])for(const row of fixture.vectors){
    const packet=Uint8Array.from(row.payload),timeline=run('timeline',Buffer.from(packet).toString('hex'),profile);
    const identity=timeline.split('\n')[1].slice(7);
    assert.equal(timeline,payloadTimeline(packet,identity,profile));
  }
});

test('portable file TL embeds every physical profile and decodes in both clients',{skip:!process.env.TONESEAL_BROWSER_PCM},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toneseal-portable-pcm-'));
  try{
    const dist=new URL('../dist/',import.meta.url),registry=JSON.parse(await fs.readFile(new URL('engines.json',dist),'utf8'));
    const engine=registry.engines.find(item=>item.id===registry.default||item.release_id===registry.default);
    const {runCLI}=await import(new URL(engine.runtime_module,dist));
    const bytes=await fs.readFile(new URL(engine.browser_wasm,dist));
    assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex'),engine.browser_sha256);
    const synth=await WebAssembly.compile(bytes),module=await WebAssembly.compile(await fs.readFile(new URL('communication-decoder.wasm',dist)));
    const packet=Uint8Array.from({length:128},(_,i)=>(i*71+9)&255),value=Buffer.from(packet).toString('hex');
    for(const profile of ['nearby','telephone','ultrasonic']){
      const timeline=run('record',value,profile);assert.ok(timeline.startsWith('# jottune-tl 1 1\n'));
      const rendered=await runCLI(synth,['--play','packet.tl','--merged','canonical.tl'],{'packet.tl':timeline});
      assert.equal(rendered.code,0,rendered.stderr);
      const source=path.join(directory,profile+'.tl');await fs.writeFile(source,timeline);
      for(const rate of [48000,44100]){
        const wav=path.join(directory,`${profile}-${rate}.wav`);run('render-tl',source,wav,String(rate));
        const file=await fs.readFile(wav),capture=readCaptureWav(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength));
        if(rate===48000)assert.deepEqual(Int16Array.from(capture.samples,sample=>Math.round(sample*32768)),rendered.pcm,`${profile}: physical TL renders the same PCM in C and browser Wasm`);
        const receiver=await StreamingDecoder.create(module,rate,profile),input=new Float32Array(capture.samples.length+Math.ceil(rate*.3)),found=[];
        input.set(capture.samples);
        for(let i=0;i<input.length;i+=2048)found.push(...receiver.push(input.slice(i,i+2048)));
        assert.deepEqual(found,[packet],`${profile}/${rate}: C portable file -> browser receiver`);
      }
      const browserWav=path.join(directory,`browser-${profile}.wav`);await fs.writeFile(browserWav,pcmWav(rendered.pcm));
      const decoded=run('decode',browserWav,profile).trim().split('\n').map(JSON.parse);
      assert.deepEqual(decoded.filter(event=>event.packet).map(event=>event.packet),[value],`${profile}: browser portable file -> C receiver`);
    }
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('native and browser synth PCM agree; both receivers decode crosswise',{skip:!process.env.TONESEAL_BROWSER_PCM},async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toneseal-pcm-'));
  try{
    const dist=new URL('../dist/',import.meta.url),registry=JSON.parse(await fs.readFile(new URL('engines.json',dist),'utf8'));
    const engine=registry.engines.find(item=>item.id===registry.default||item.release_id===registry.default);
    const {runCLI}=await import(new URL(engine.runtime_module,dist));
    const wasm=await fs.readFile(new URL(engine.browser_wasm,dist));
    assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',wasm)).toString('hex'),engine.browser_sha256);
    const synth=await WebAssembly.compile(wasm),decoder=await WebAssembly.compile(await fs.readFile(new URL('communication-decoder.wasm',dist)));
    const packet=Uint8Array.from({length:128},(_,i)=>(i*37+9)&255),value=Buffer.from(packet).toString('hex');
    for(const profile of ['nearby','telephone','ultrasonic']){
      const nativeTimeline=run('timeline',value,profile);assert.equal(nativeTimeline,payloadTimeline(packet,engine.identity,profile));
      const rendered=await runCLI(synth,['--play','packet.tl','--merged','canonical.tl'],{'packet.tl':nativeTimeline});
      assert.equal(rendered.code,0,rendered.stderr);
      for(const rate of [48000,44100]){
      const name=path.join(directory,`${profile}-${rate}.wav`);
      run('render',value,name,String(rate),profile);
      const wav=await fs.readFile(name),capture=readCaptureWav(wav.buffer.slice(wav.byteOffset,wav.byteOffset+wav.byteLength));
      const step=48000*(profile==='telephone'?.75:1)/rate,physical=new Int16Array(Math.ceil(rendered.pcm.length/step));
      for(let i=0;i<physical.length;i++){
        const position=i*step,index=Math.min(Math.floor(position),rendered.pcm.length-1),mix=position-Math.floor(position);
        physical[i]=Math.max(-32768,Math.min(32767,Math.round(rendered.pcm[index]*(1-mix)+rendered.pcm[Math.min(index+1,rendered.pcm.length-1)]*mix)));
      }
      assert.deepEqual(Int16Array.from(capture.samples,value=>Math.round(value*32768)),physical,`${profile}/${rate} native PCM equals the browser waveform`);
      const receiver=await StreamingDecoder.create(decoder,rate,profile),samples=new Float32Array(capture.samples.length+Math.ceil(rate*.3));samples.set(capture.samples);
      const decoded=[];for(let i=0;i<samples.length;i+=2048)decoded.push(...receiver.push(samples.slice(i,i+2048)));
      assert.deepEqual(decoded,[packet],`${profile}/${rate} native synth -> browser receiver`);
      const browserWav=path.join(directory,`browser-${profile}-${rate}.wav`);await fs.writeFile(browserWav,pcmWav(physical,rate));
      const events=run('decode',browserWav,profile).trim().split('\n').map(JSON.parse);
      assert.deepEqual(events.filter(event=>event.packet).map(event=>event.packet),[value],`${profile}/${rate} browser synth -> C receiver`);
      }
    }
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
