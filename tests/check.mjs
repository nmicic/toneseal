// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {encodePayload,textPayload,payloadText,messageTimeline,receiverPCM,readCaptureWav,pcmWav,decodePCM} from '../web/communication-codec.mjs';
const lab=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);
const synth=path.resolve(process.env.JOTTUNE_SYNTH_ROOT||path.resolve(lab,'../jottune-synth'));
const option=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const harness=option('--harness',path.join(synth,'build/s12e10p1v1/harness')),receiver=option('--receiver',path.join(lab,'build/receiver')),wasm=option('--wasm',path.join(lab,'web/communication-decoder.wasm'));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'jottune-acoustic-'));
function run(command,values,input){const result=spawnSync(command,values,{input,encoding:'utf8',maxBuffer:4*1024*1024,timeout:60000});assert.equal(result.status,0,result.stderr||result.error?.message);return result.stdout;}
let checks=0;function check(value,message){assert.ok(value,message);checks++;}
try {
 const module=await WebAssembly.compile(fs.readFileSync(wasm));check(WebAssembly.Module.imports(module).length===0,'standalone decoder imports no network/WASI/engine runtime');
 const identity=run(harness,['--engine']).trim().slice(7);
 const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/codec-vectors.json',import.meta.url),'utf8')).vectors;
 const vectors=fixtures.map(({payload,sender})=>({payload,sender})),expected=fixtures.map(row=>row.encoded);
 vectors.forEach((vector,i)=>assert.deepEqual([...encodePayload(Uint8Array.from(vector.payload),vector.sender)],expected[i]));checks++;
 const frames=Buffer.concat(expected.map(values=>{const buffer=Buffer.alloc(2+values.length);buffer.writeUInt16LE(values.length);buffer.set(values,2);return buffer;}));
 fs.writeFileSync(path.join(temporary,'frames.bin'),frames);
 const events=run(receiver,['frames',path.join(temporary,'frames.bin')]).trim().split('\n').map(JSON.parse);
 vectors.forEach((v,i)=>{assert.equal(events[i].payload_hex,Buffer.from(v.payload).toString('hex'));assert.equal(events[i].sender,v.sender);});checks++;
 for(const text of ['Hello two devices','é🎵','x'.repeat(127)]) {
  const authored=path.join(temporary,'authored.tl'),canonical=path.join(temporary,'song.tl'),wav=path.join(temporary,'song.wav');
  fs.writeFileSync(authored,messageTimeline(text,identity));
  const result=run(harness,['--play',authored,'--merged',canonical,'--wav',wav,'--metrics']);
  check(/clipped=0/.test(result)&&/block_indep=yes/.test(result),'native synthesized packet remains unclipped and block independent');
  check(/match=yes/.test(run(harness,['--play',canonical])),'delivered canonical TL replays saved hash');
  const bytes=fs.readFileSync(wav),capture=readCaptureWav(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const input=receiverPCM(capture.samples,capture.rate).pcm;
  check(input.length/48000<=4.16,'largest128-wire-byte frame including guards fits4.16seconds, inside20second capture');
  const controls=[['clean',input],['offset',Int16Array.from([...new Int16Array(317),...input])]];
  const reflected=Int16Array.from(input,(value,i)=>Math.max(-32768,Math.min(32767,Math.round(value*0.8+(i>=192?input[i-192]*0.2:0)))));
  controls.push(['reflection4ms',reflected]);
  const rate44100=Float32Array.from({length:Math.floor(capture.samples.length*44100/48000)},(_,i)=>{const x=i*48000/44100,j=Math.floor(x),f=x-j;return capture.samples[j]*(1-f)+capture.samples[Math.min(j+1,capture.samples.length-1)]*f;});
  controls.push(['44100',receiverPCM(rate44100,44100).pcm]);
  let seed=73;const noisy=Int16Array.from(input,value=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.max(-32768,Math.min(32767,Math.round(-value*0.8+((seed/2**32)-0.5)*200)));});
  controls.push(['polarity-gain-noise',noisy]);
  for(const [name,pcm] of controls){
   const raw=path.join(temporary,'capture.pcm');fs.writeFileSync(raw,Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength));
   const native=run(receiver,['stream',raw,'irregular']).trim().split('\n').map(JSON.parse).filter(row=>row.kind==='packet');
   const decoded=await decodePCM(module,pcm);
   assert.deepEqual(decoded.messages.map(m=>Buffer.from(m.bytes).toString('hex')),native.map(m=>m.payload_hex),name);
   assert.deepEqual(decoded.messages.map(m=>payloadText(m.bytes)),[text],name);checks++;
  }
  const truncated=input.slice(0,5000),silence=new Int16Array(48000);let seed2=9;
  const noise=Int16Array.from({length:48000},()=>{seed2=(Math.imul(seed2,1664525)+1013904223)>>>0;return (seed2>>>16)-32768;});
  for(const pcm of [truncated,silence,noise])check((await decodePCM(module,pcm)).messages.length===0,'truncation/silence/noise refuse without a message');
  const replay=Int16Array.from([...input,...new Int16Array(4800),...input]);
  check((await decodePCM(module,replay)).messages.length===2,'later identical messages remain two occurrences');
  if(text.startsWith('Hello')){
   const roundtrip=pcmWav(input);const reread=readCaptureWav(roundtrip.buffer);assert.deepEqual(receiverPCM(reread.samples,reread.rate).pcm,input);checks++;
  }
 }
 assert.throws(()=>textPayload('😀'.repeat(32)),/127/);assert.throws(()=>textPayload('\ud800'),/Unicode/);assert.throws(()=>textPayload(''));
 assert.throws(()=>payloadText(Uint8Array.from([0,0xff])));assert.throws(()=>payloadText(Uint8Array.from([1,65])));checks++;
 assert.throws(()=>encodePayload(new Uint8Array(129)));assert.throws(()=>receiverPCM(new Float32Array(48000*20+1),48000));
 assert.throws(()=>receiverPCM(Float32Array.from([NaN]),48000));assert.throws(()=>receiverPCM(new Float32Array(100),32000));checks++;
 assert.throws(()=>readCaptureWav(new ArrayBuffer(45)));checks++;
 const shortDraft=path.join(temporary,'short.tl'),shortWav=path.join(temporary,'short.wav');fs.writeFileSync(shortDraft,messageTimeline('x',identity));run(harness,['--play',shortDraft,'--wav',shortWav]);
 const shortBytes=fs.readFileSync(shortWav),shortCapture=readCaptureWav(shortBytes.buffer.slice(shortBytes.byteOffset,shortBytes.byteOffset+shortBytes.byteLength)),shortPCM=receiverPCM(shortCapture.samples,48000).pcm;
 const crowded=new Int16Array((shortPCM.length+4800)*9);for(let i=0;i<9;i++)crowded.set(shortPCM,i*(shortPCM.length+4800));
 await assert.rejects(()=>decodePCM(module,crowded),/refused|finish/);checks++;
 const delivery=path.join(temporary,'cli-message'),cli=path.join(lab,'cli.mjs');
 const encoded=JSON.parse(run(process.execPath,[cli,'encode','--text','CLI delivery é','--out',delivery,'--harness',harness]));
 check(encoded.ok&&fs.existsSync(encoded.record)&&fs.existsSync(encoded.wav),'CLI delivers accessible canonical TL and WAV');
 assert.deepEqual(JSON.parse(run(process.execPath,[cli,'decode','--wav',encoded.wav,'--decoder',receiver])).messages.map(row=>row.text),['CLI delivery é']);checks++;
 assert.equal(spawnSync(process.execPath,[cli,'encode','--text','replacement','--out',delivery,'--harness',harness]).status,2);check(/match=yes/.test(run(harness,['--play',encoded.record])),'existing delivery is never overwritten');
 const silent=path.join(temporary,'silent.wav');fs.writeFileSync(silent,pcmWav(new Int16Array(48000)));
 const refused=spawnSync(process.execPath,[cli,'decode','--wav',silent,'--decoder',receiver],{encoding:'utf8'});assert.equal(refused.status,1);assert.deepEqual(JSON.parse(refused.stdout).messages,[]);checks++;
 const broken=expected[6].map((value,i)=>i>=24?value^255:value),buffer=Buffer.alloc(2+broken.length);buffer.writeUInt16LE(broken.length);buffer.set(broken,2);fs.writeFileSync(path.join(temporary,'bad.bin'),buffer);
 check(JSON.parse(run(receiver,['frames',path.join(temporary,'bad.bin')]).trim()).kind==='refused','uncorrectable body cannot passCRC');
 console.log(`PASS ${checks} acoustic framing/native/Wasm/cross-rate/channel/refusal groups`);
} finally {fs.rmSync(temporary,{recursive:true,force:true});}
