// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
// Optional real synth/receiver layer for the shared-timeline C/browser tests.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {payloadTimeline,readCaptureWav,pcmWav} from '../web/communication-codec.mjs';
import {StreamingDecoder} from '../web/auto-decoder.mjs';

export async function createPCMChannel(profile){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'toneseal-channel-'));
  try{
    const driver=process.env.TONESEAL_MODEM||'build/modem-driver';
    const run=(...args)=>execFileSync(driver,args,{encoding:'utf8',maxBuffer:1024*1024});
    const dist=new URL('../dist/',import.meta.url),registry=JSON.parse(await fs.readFile(new URL('engines.json',dist),'utf8'));
    const engine=registry.engines.find(item=>item.id===registry.default||item.release_id===registry.default);
    const {runCLI}=await import(new URL(engine.runtime_module,dist));
    const wasm=await fs.readFile(new URL(engine.browser_wasm,dist));
    assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',wasm)).toString('hex'),engine.browser_sha256);
    const synth=await WebAssembly.compile(wasm),receiver=await WebAssembly.compile(await fs.readFile(new URL('communication-decoder.wasm',dist)));
    let serial=0;
    return {
      async transmit(side,packet){
        const value=Buffer.from(packet).toString('hex'),name=path.join(directory,`${++serial}.wav`);
        if(side===0){
          run('render',value,name,'48000',profile);
          const buffer=await fs.readFile(name),capture=readCaptureWav(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));
          const decoder=await StreamingDecoder.create(receiver,48000,profile),input=new Float32Array(capture.samples.length+14400),found=[];input.set(capture.samples);
          for(let i=0;i<input.length;i+=2048)found.push(...decoder.push(input.slice(i,i+2048)));
          assert.deepEqual(found,[packet],'C-generated waveform must decode once and byte-exactly in the browser');
        }else{
          const timeline=payloadTimeline(packet,engine.identity,profile),rendered=await runCLI(synth,['--play','packet.tl','--merged','canonical.tl'],{'packet.tl':timeline});
          assert.equal(rendered.code,0,rendered.stderr);
          const step=profile==='telephone'?.75:1,pcm=new Int16Array(Math.ceil(rendered.pcm.length/step));
          for(let i=0;i<pcm.length;i++){const position=i*step,index=Math.min(Math.floor(position),rendered.pcm.length-1),mix=position-Math.floor(position);pcm[i]=Math.max(-32768,Math.min(32767,Math.round(rendered.pcm[index]*(1-mix)+rendered.pcm[Math.min(index+1,rendered.pcm.length-1)]*mix)));}
          await fs.writeFile(name,pcmWav(pcm));
          const events=run('decode',name,profile).trim().split('\n').map(JSON.parse);
          assert.deepEqual(events.filter(event=>event.packet).map(event=>event.packet),[value],'Browser-generated waveform must decode once and byte-exactly in C');
        }
        await fs.unlink(name);return packet;
      },
      close:()=>fs.rm(directory,{recursive:true,force:true}),
    };
  }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
}
