// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Deterministic waveform tests, not a simulation of any particular room/phone.
// Fixed dummy crypto material is confined to these acoustic fixtures. Session
// negotiation/authentication is exercised separately by the protocol suites.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {StreamingDecoder} from '../web/auto-decoder.mjs';
import {payloadTimeline} from '../web/communication-codec.mjs';
import {decodeClearPacket, clearControl} from '../web/clear-session.mjs';
const dist=new URL('../dist/',import.meta.url),encoder=new TextEncoder();
const registry=JSON.parse(await fs.readFile(new URL('engines.json',dist),'utf8'));
const engine=registry.engines.find(item=>item.id===registry.default||item.release_id===registry.default);
const {runCLI}=await import(new URL(engine.runtime_module||'runtime.mjs',dist));
const synthBytes=await fs.readFile(new URL(engine.browser_wasm,dist));
const receiverBytes=await fs.readFile(new URL('communication-decoder.wasm',dist));
const synth=await WebAssembly.compile(synthBytes);
const receiver=await WebAssembly.compile(receiverBytes);
const hex=bytes=>Buffer.from(bytes).toString('hex'),same=(a,b)=>a.length===b.length&&a.every((byte,index)=>byte===b[index]);
const rendererBrowserSha256=hex(await crypto.subtle.digest('SHA-256',synthBytes));
const receiverSha256=hex(await crypto.subtle.digest('SHA-256',receiverBytes));
assert.equal(rendererBrowserSha256,engine.browser_sha256,'renderer bytes must match their registry digest');
const text='Acoustic fixture. '.repeat(6).slice(0,96),body=encoder.encode(text);
const clearId=Uint8Array.from({length:12},(_,index)=>index+1);
const domain=encoder.encode('audio-text-lab/clear/v1\0');
const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from([...domain,...clearId,...body])));
const clear=Uint8Array.from([0xa8,1,1,...clearId,...digest.slice(0,16),...body]);
assert.equal((await decodeClearPacket(clear)).text,text);assert.equal(clear.length,127);
const secretKey=await crypto.subtle.importKey('raw',Uint8Array.from({length:32},(_,index)=>index),'AES-GCM',false,['encrypt','decrypt']);
const header=Uint8Array.from([0xa7,2,3,10,20,30,40,50,60,70,80,0,0,0,1]);
const nonce=Uint8Array.from([2,4,6,8,10,12,14,16,0,0,0,1]);
const encrypted=Uint8Array.from([...header,...new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:header,tagLength:128},secretKey,Uint8Array.from([1,...body])))]);
assert.equal(encrypted.length,128);
assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:header,tagLength:128},secretKey,encrypted.slice(15))),Uint8Array.from([1,...body]));
const fixtureBytes={clear,encrypted,ack:clearControl(clear,'ack')},fixtures={};
for(const [name,packet] of Object.entries(fixtureBytes)){
  const start=performance.now();
  const first=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':payloadTimeline(packet,engine.identity)});
  assert.equal(first.code,0,first.stderr);
  const second=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':new TextDecoder().decode(first.canonical)});
  assert.equal(second.code,0,second.stderr);assert.deepEqual(second.pcm,first.pcm,'canonical replay must preserve acoustic fixture');
  fixtures[name]={packet,pcm:Float32Array.from(second.pcm,value=>value/32768),preparationMs:performance.now()-start};
}
function random(seed){let state=seed>>>0;return()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/0x100000000;};}
function waveform({events,seconds,noisePeak=0,seed=0x45ac1234,zero=[],remove=[]}){
  let samples=new Float32Array(Math.ceil(seconds*48000));
  for(const {name,start,gain=0.8,endGain=gain} of events){
    const pcm=fixtures[name].pcm,offset=Math.round(start*48000);
    assert.ok(offset+pcm.length<=samples.length,'fixture must fit the shared timeline');
    for(let i=0;i<pcm.length;i++)samples[offset+i]+=pcm[i]*(gain+(endGain-gain)*i/Math.max(1,pcm.length-1));
  }
  const signalPower=samples.reduce((sum,value)=>sum+value*value,0)/samples.length;
  const snrDb=noisePeak&&signalPower?Number((10*Math.log10(signalPower/(noisePeak*noisePeak/3))).toFixed(2)):null;
  const rng=random(seed);
  for(let i=0;i<samples.length;i++)samples[i]+=(rng()*2-1)*noisePeak;
  for(const [start,duration] of zero)samples.fill(0,Math.round(start*48000),Math.round((start+duration)*48000));
  for(const [start,duration] of [...remove].sort((a,b)=>b[0]-a[0])){
    const begin=Math.round(start*48000),end=Math.round((start+duration)*48000),cut=new Float32Array(samples.length-(end-begin));
    cut.set(samples.subarray(0,begin));cut.set(samples.subarray(end),begin);samples=cut;
  }
  assert.ok(samples.every(value=>Number.isFinite(value)&&Math.abs(value)<=1),'test impairments must not accidentally clip');
  return {samples,snrDb};
}
function resample(samples,rate){
  if(rate===48000)return samples;
  return Float32Array.from({length:Math.floor(samples.length*rate/48000)},(_,i)=>{
    const position=i*48000/rate,index=Math.floor(position),fraction=position-index;
    return samples[index]*(1-fraction)+samples[Math.min(index+1,samples.length-1)]*fraction;
  });
}
const rows=[];
async function runCase(name,options,expected){
  const rate=options.rate||48000,wave=waveform(options),samples=resample(wave.samples,rate),decoder=await StreamingDecoder.create(receiver,rate);
  const allowed=[...new Set(options.events.map(event=>event.name))],observed=[],start=performance.now();
  for(let offset=0;offset<samples.length;offset+=2048){
    for(const packet of decoder.push(samples.slice(offset,offset+2048))){
      const source=allowed.find(id=>same(packet,fixtures[id].packet));
      assert.ok(source,`${name}: a decoded packet differed from every allowed source (${hex(packet)})`);
      observed.push({fixture:source,atSeconds:Number((Math.min(offset+2048,samples.length)/rate).toFixed(4))});
    }
  }
  assert.deepEqual(observed.map(item=>item.fixture),expected,name);
  const cleanRetryStarts={};
  if(options.recoveredAfterRetry){
    for(const fixture of expected){
      const transmissions=options.events.filter(event=>event.name===fixture);
      assert.ok(transmissions.length>=2,`${name}: recovery requires an initial transmission and a retry`);
      const retryStart=transmissions.at(-1).start;
      const removedBefore=(options.remove||[]).reduce((sum,[start,seconds])=>sum+Math.min(seconds,Math.max(0,retryStart-start)),0);
      cleanRetryStarts[fixture]=retryStart-removedBefore;
    }
    for(const item of observed)assert.ok(item.atSeconds>=cleanRetryStarts[item.fixture],`${name}: ${item.fixture} must recover after its clean retry begins, not during the impaired transmission`);
  }
  const gains=options.events.flatMap(event=>[event.gain??0.8,event.endGain??event.gain??0.8]);
  const row={name,passed:true,expected,decodedPackets:observed.length,byteExact:true,sampleRate:rate,
    audioDurationMs:Number((samples.length/rate*1000).toFixed(2)),audioSeconds:Number((samples.length/rate).toFixed(4)),
    processingMs:Number((performance.now()-start).toFixed(2)),snrDb:wave.snrDb,noisePeak:options.noisePeak||0,
    dropMs:Number([...(options.zero||[]),...(options.remove||[])].reduce((sum,[,seconds])=>sum+seconds*1000,0).toFixed(2)),
    gainRange:gains.length?[Math.min(...gains),Math.max(...gains)]:null,recoveredAfterRetry:Boolean(options.recoveredAfterRetry),cleanRetryStarts,
    recoveryAtMs:options.recoveredAfterRetry?Math.round(observed.at(-1).atSeconds*1000):null,
    seed:options.seed??0x45ac1234,events:options.events,zeroIntervals:options.zero||[],removedIntervals:options.remove||[],decoded:observed,corruptPacketsAccepted:0};
  rows.push(row);console.log('PASS '+name+': '+observed.map(item=>item.fixture).join(', ')+'; '+row.audioSeconds+'s waveform, '+row.processingMs+'ms decode');
}
const pair=[{name:'clear',start:0.2},{name:'encrypted',start:5.0}];
await runCase('clean maximum frames', {events:pair,seconds:10}, ['clear','encrypted']);
await runCase('seeded white noise and attenuation', {events:pair.map(event=>({...event,gain:0.25})),seconds:10,noisePeak:0.002}, ['clear','encrypted']);
await runCase('varying amplitude at 44.1 kHz', {events:pair.map(event=>({...event,gain:0.25,endGain:0.8})),seconds:10,noisePeak:0.002,rate:44100}, ['clear','encrypted']);
await runCase('short erased intervals repaired', {events:pair,seconds:10,noisePeak:0.001,zero:[[1.2,0.02],[6.2,0.02]]}, ['clear','encrypted']);
await runCase('removed interval then clean retransmission', {events:[{name:'encrypted',start:0.2},{name:'encrypted',start:5.0}],seconds:10,remove:[[1.2,0.02]],recoveredAfterRetry:true}, ['encrypted']);
await runCase('long erased interval then clean retransmission', {events:[{name:'clear',start:0.2},{name:'clear',start:5.0}],seconds:10,zero:[[0.24,0.8]],recoveredAfterRetry:true}, ['clear']);
await runCase('two simultaneous speakers then separate retries', {events:[{name:'clear',start:0.2},{name:'encrypted',start:0.2},{name:'clear',start:5.0},{name:'encrypted',start:10.0}],seconds:15,recoveredAfterRetry:true}, ['clear','encrypted']);
await runCase('checksum ACK under noise', {events:[{name:'ack',start:0.2,gain:0.25}],seconds:3,noisePeak:0.002}, ['ack']);
await runCase('seeded noise without packets', {events:[],seconds:5,noisePeak:0.15}, []);
const report={schemaVersion:1,createdAt:new Date().toISOString(),kind:'deterministic synthetic PCM, not physical room acceptance',snrDefinition:'whole-waveform signal mean square before losses versus seeded uniform noise variance',renderer:engine.id,rendererBrowserSha256,receiverSha256,fixtures:Object.fromEntries(Object.entries(fixtures).map(([name,value])=>[name,{bytes:value.packet.length,pcmSeconds:value.pcm.length/48000,preparationMs:Number(value.preparationMs.toFixed(2))}])),cases:rows,totals:{cases:rows.length,decodedPackets:rows.reduce((sum,row)=>sum+row.decoded.length,0),corruptPacketsAccepted:0}};
await fs.mkdir(new URL('../out/',import.meta.url),{recursive:true});
await fs.writeFile(new URL('../out/acoustic-impairments.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log('PASS all deterministic acoustic impairments; report out/acoustic-impairments.json');
