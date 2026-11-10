// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {StreamingDecoder} from '../web/auto-decoder.mjs';
import {payloadTimeline, encodePayload, rsEncode, glyphFrequencies, preamble} from '../web/communication-codec.mjs';
import {getAudioProfile} from '../web/audio-profiles.mjs';
const dist=new URL('../dist/',import.meta.url);
const registry=JSON.parse(await fs.readFile(new URL('engines.json',dist),'utf8'));
const engine=registry.engines.find(entry=>entry.id===registry.default||entry.release_id===registry.default);
const {runCLI}=await import(new URL(engine.runtime_module||'runtime.mjs',dist));
const synth=await WebAssembly.compile(await fs.readFile(new URL(engine.browser_wasm,dist)));
const module=await WebAssembly.compile(await fs.readFile(new URL('communication-decoder.wasm',dist)));
const packet=Uint8Array.from({length:128},(_,i)=>(i*71)&255);
const result=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':payloadTimeline(packet,engine.identity)});
assert.equal(result.code,0,result.stderr);
const pcm=result.pcm;
const ultrasonicResult=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':payloadTimeline(packet,engine.identity,'ultrasonic')});
assert.equal(ultrasonicResult.code,0,ultrasonicResult.stderr);
assert.equal(getAudioProfile().id,'nearby');
assert.equal(getAudioProfile('nearby').playbackRate,1);
assert.equal(getAudioProfile('telephone').playbackRate,0.75);
assert.equal(getAudioProfile('telephone').timingScale,1/0.75);
assert.ok(Object.isFrozen(getAudioProfile('telephone')));
for(const invalid of ['unknown','constructor','__proto__',null,0,NaN,{}])assert.throws(()=>getAudioProfile(invalid),/supported audio profile/);
await assert.rejects(StreamingDecoder.create(module,48000,'unknown'),/supported audio profile/);
function place(samples,source,start,rate,playbackRate){
  const count=Math.floor(source.length*rate/(48000*playbackRate));
  for(let i=0;i<count;i++){
    const position=i*48000*playbackRate/rate,index=Math.floor(position),mix=position-index;
    samples[Math.round(start*rate)+i]=(source[index]*(1-mix)+source[Math.min(index+1,source.length-1)]*mix)/32768;
  }
}
async function streamCase(rate,starts,duration,{profile='nearby',receiverProfile=profile,chunks=[2048]}={}){
  const {playbackRate,timingScale}=getAudioProfile(profile),source=profile==='ultrasonic'?ultrasonicResult.pcm:pcm;
  const decoder=await StreamingDecoder.create(module,rate,receiverProfile),samples=new Float32Array(Math.ceil(duration*rate*timingScale));
  // Fixture positions use the decoder's canonical clock, so each physical
  // profile crosses the same native reset boundaries at its own duration.
  for(const start of starts)place(samples,source,start*timingScale,rate,playbackRate);
  const found=[];for(let i=0,chunk=0;i<samples.length;chunk++){
    const count=chunks[chunk%chunks.length],emitted=decoder.push(samples.slice(i,i+count));i+=count;
    // Match the decoder Worker's transferable delivery: output buffers become
    // detached, while internal dedup memory must remain usable.
    for(const value of emitted)found.push(structuredClone(value,{transfer:[value.buffer]}));
    assert.ok(decoder.recent.every(item=>item.bytes.length>0),'transferring callback bytes cannot detach the pending dedup cache');
    assert.ok(decoder.states.every(state=>state.fed<=12*48000&&state.api.memory.buffer.byteLength<=262144),'native windows remain bounded in canonical time');
  }
  assert.equal(found.length,profile===receiverProfile?starts.length:0,`One delivery per matching physical packet at ${rate} Hz (${profile} → ${receiverProfile})`);
  for(const value of found)assert.deepEqual(value,packet);
  return decoder;
}
// Maximum packets cross both staggered reset boundaries; repeats remain visible
// while the two simultaneous receivers never produce duplicate callbacks.
await streamCase(48000,[0.21,10.9,17.8,29.4],35);
await streamCase(44100,[0.17,10.7,17.9],24);
await streamCase(48000,[0.21,10.9,17.8,29.4],35,{profile:'telephone',chunks:[1,17,2048,4096,8192]});
await streamCase(44100,[0.17,10.7,17.9],24,{profile:'telephone',chunks:[8192,11,2048,3071]});
await streamCase(48000,[0.21,10.9,17.8,29.4],35,{profile:'ultrasonic',chunks:[1,17,2048,4096,8192]});
await streamCase(44100,[0.17,10.7,17.9],24,{profile:'ultrasonic',chunks:[8192,11,2048,3071]});
await streamCase(48000,[0.21],6,{profile:'telephone',receiverProfile:'nearby'});
await streamCase(44100,[0.17],6,{profile:'nearby',receiverProfile:'telephone'});
await streamCase(48000,[0.21],6,{profile:'ultrasonic',receiverProfile:'nearby'});
await streamCase(44100,[0.17],6,{profile:'nearby',receiverProfile:'ultrasonic'});
// Seven short packets make both receivers reach the adapter result capacity
// together. Their scheduled reset phases must remain staggered afterward.
const shortPacket=Uint8Array.of(0xa7),shortResult=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':payloadTimeline(shortPacket,engine.identity)});
assert.equal(shortResult.code,0);
const ultrasonicShort=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':payloadTimeline(shortPacket,engine.identity,'ultrasonic')});
assert.equal(ultrasonicShort.code,0,ultrasonicShort.stderr);
async function burstCase(rate,profile='nearby'){
  const {playbackRate,timingScale}=getAudioProfile(profile),short=profile==='ultrasonic'?ultrasonicShort.pcm:shortResult.pcm,full=profile==='ultrasonic'?ultrasonicResult.pcm:pcm;
  const burst=new Float32Array(Math.ceil(28*rate*timingScale)),burstDecoder=await StreamingDecoder.create(module,rate,profile),burstFound=[];
  for(let i=0;i<7;i++)place(burst,short,(6.05+i*0.8)*timingScale,rate,playbackRate);
  place(burst,full,11.8*timingScale,rate,playbackRate);place(burst,full,23.2*timingScale,rate,playbackRate);
  for(let i=0;i<burst.length;i+=2048)burstFound.push(...burstDecoder.push(burst.slice(i,i+2048)));
  assert.deepEqual(burstFound,[...Array.from({length:7},()=>shortPacket),packet,packet]);
}
await burstCase(48000);
await burstCase(48000,'telephone');
await burstCase(44100,'telephone');
await burstCase(48000,'ultrasonic');
await burstCase(44100,'ultrasonic');
const decoder=await StreamingDecoder.create(module,48000);
assert.throws(()=>decoder.push(Float32Array.of(NaN)),/Non-finite/);
assert.throws(()=>decoder.push(new Float32Array(8193)),/Invalid/);
const empty=[];for(let i=0;i<24*48000;i+=2048)empty.push(...decoder.push(new Float32Array(2048)));
assert.deepEqual(empty,[]);
// Corrupt payload bytes while keeping Reed–Solomon protection valid, leaving
// the original payload CRC intact. This exercises the real native CRC branch
// rather than guessing checksum failure from silence or an invalid AEAD tag.
const crcPacket=Uint8Array.of(0x7b),crcFrame=encodePayload(crcPacket);
const word=Array.from({length:15},(_,i)=>(crcFrame[8+Math.floor(i/2)]>>(i%2?0:4))&15);
word[0]^=1;
const changed=rsEncode(word.slice(0,11));
for(let i=0;i<8;i++)crcFrame[8+i]=(changed[i*2]<<4)|(changed[i*2+1]||0);
const crcTimeline=payloadTimeline(crcPacket,engine.identity).split('\n').map(row=>{
  const parts=row.split(' ');
  if(parts[3]!=='on')return row;
  const glyph=(Number(parts[0])/1000000-40)/20-preamble.length;
  if(glyph<0)return row;
  parts[4]=String(glyphFrequencies(crcFrame[glyph])[Number(parts[2])]*1000);
  return parts.join(' ');
}).join('\n');
const crcResult=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':crcTimeline});
assert.equal(crcResult.code,0,crcResult.stderr);
const crcDecoder=await StreamingDecoder.create(module,48000),crcSamples=new Float32Array(crcResult.pcm.length+48000),crcFound=[];
crcSamples.set(Float32Array.from(crcResult.pcm,value=>value/32768));
for(let offset=0;offset<crcSamples.length;offset+=2048)crcFound.push(...crcDecoder.push(crcSamples.slice(offset,offset+2048)));
assert.deepEqual(crcFound,[],'a valid-RS packet with a bad payload CRC never reaches the application');
assert.ok(crcDecoder.metrics.crcRejectedCandidates>0,'native decoder reports actual payload CRC failures');
assert.ok(crcDecoder.metrics.invalidPayloadCandidates>=crcDecoder.metrics.crcRejectedCandidates);
const crcFailures=crcDecoder.metrics.crcRejectedCandidates;
crcDecoder.reset();
assert.equal(crcDecoder.metrics.crcRejectedCandidates,crcFailures,'playback resets preserve run diagnostics');
const recovered=[];
for(let offset=0;offset<pcm.length;offset+=2048)recovered.push(...crcDecoder.push(Float32Array.from(pcm.slice(offset,offset+2048),value=>value/32768)));
assert.deepEqual(recovered,[packet],'a clean packet recovers after the failed checksum');
console.log('PASS continuous native decoding: nearby/telephone/near-ultrasonic at 48/44.1 kHz, full packets across both reset boundaries, irregular chunks, duplicate suppression, profile mismatch, silence and bounded input.');
console.log('PASS native CRC telemetry: valid Reed–Solomon words with a wrong payload checksum are rejected, counted as candidate failures, and followed by exact recovery.');

const {AutoAudioLink}=await import(new URL('auto-audio-link.mjs',dist));
const saved=new Map(['navigator','AudioContext','AudioWorkletNode','Worker','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
let contextCount=0,resumeCalls=0,stopped=0,closed=0,lastContext,lastNode,lastSource,lastGain,lastBuffer;
let gum,decoderWorker,renderJobs=0,renderWorkers=0,holdInit=false,releaseInit,suppressDecoded=false,renderPCM=pcm;
const audioSession={type:'auto'};
let wakeRequests=0,wakeReleases=0;
const wakeLock={async request(type){
  assert.equal(type,'screen');wakeRequests++;
  return {released:false,onrelease:null,async release(){assert.equal(this.released,false);this.released=true;wakeReleases++;this.onrelease?.();}};
}};
const tracks=[{readyState:'live',stop(){this.readyState='ended';stopped++;}}];
const stream={getTracks:()=>tracks};
class Context {
  constructor(){contextCount++;lastContext=this;this.state='suspended';this.currentTime=0;this.sampleRate=48000;this.audioWorklet={addModule:async()=>{}};}
  resume(){resumeCalls++;this.state='running';return Promise.resolve();}
  close(){this.state='closed';closed++;return Promise.resolve();}
  createMediaStreamSource(){return {connect:node=>node};}
  createBuffer(_,length){const buffer=new Float32Array(length);lastBuffer=buffer;return {getChannelData:()=>buffer};}
  createGain(){lastGain={gain:{value:1},connect(){return this;}};return lastGain;}
  createBufferSource(){lastSource={playbackRate:{value:1},connect:node=>node,start(){this.rateAtStart=this.playbackRate.value;},stop(){queueMicrotask(()=>this.onended?.());}};return lastSource;}
}
class Node {
  constructor(){lastNode=this;this.port={postMessage(){}};}
  connect(){return this;}
  disconnect(){}
}
class Worker {
  constructor(url){this.url=String(url);this.messages=[];if(this.url.includes('auto-decoder-worker'))decoderWorker=this;else renderWorkers++;}
  postMessage(data){
    this.messages.push(data);
    if(this.url.includes('auto-decoder-worker')){
      if(data.type==='init'){
        const ready=()=>!this.ended&&this.onmessage?.({data:{type:'ready'}});
        if(holdInit)releaseInit=ready;else queueMicrotask(ready);
      }
      if(data.type==='samples'&&!suppressDecoded)queueMicrotask(()=>!this.ended&&this.onmessage?.({data:{type:'decoded',id:data.id,epoch:data.epoch,packets:[]}}));
    }else{
      renderJobs++;
      queueMicrotask(()=>!this.ended&&this.onmessage?.({data:{verdict:'valid',canonical:new TextEncoder().encode('canonical'),verified:true,channels:1,sampleRate:48000,play:{clipped:'0'},pcm:renderPCM}}));
    }
  }
  terminate(){this.ended=true;}
}
const eventLoop=()=>new Promise(resolve=>setTimeout(resolve,0));
try{
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{audioSession,wakeLock,mediaDevices:{getUserMedia:options=>{
    assert.equal(audioSession.type,'play-and-record');assert.equal(options.video,false);return gum();
  }}}});
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:Context});
  Object.defineProperty(globalThis,'AudioWorkletNode',{configurable:true,value:Node});
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:Worker});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async()=>({ok:true,json:async()=>registry})});
  assert.throws(()=>new AutoAudioLink({profile:'unknown'}),/supported audio profile/);
  assert.equal(contextCount,0,'unsupported profiles are rejected before opening audio');
  let grant;gum=()=>new Promise(resolve=>{grant=resolve;});
  const late=new AutoAudioLink();assert.equal(late.volume,1,'automatic playback stays at 100%');const starting=late.start();
  assert.equal(resumeCalls,1,'audio resumes synchronously in Start');assert.ok(grant,'permission request occurs before awaiting');
  late.stop();grant(stream);await assert.rejects(starting,{name:'AbortError'});await eventLoop();
  assert.equal(tracks[0].readyState,'ended');assert.equal(audioSession.type,'auto');
  assert.equal(wakeRequests,0,'a cancelled microphone permission cannot leave a screen lock');
  gum=async()=>{
    const freshTracks=[{readyState:'live',stop(){this.readyState='ended';stopped++;}}];
    return {getTracks:()=>freshTracks};
  };
  const received=[],errors=[],metrics=[];
  const link=new AutoAudioLink({volume:0.65,onPackets:packets=>received.push(...packets),onError:error=>errors.push(error.message),onMetrics:value=>metrics.push(value)});
  await link.start();assert.equal(link.running,true);assert.equal(contextCount,2);assert.equal(audioSession.type,'play-and-record');
  assert.equal(link.metrics.screenWakeLock,'held','live capture holds a screen lock after permission');
  assert.equal(decoderWorker.messages.find(message=>message.type==='init').profile,'nearby');
  const context=lastContext;
  const send=link.send(packet);await eventLoop();await eventLoop();
  assert.equal(link.playing,true);assert.equal(contextCount,2,'send reuses original gesture-resumed context');
  assert.equal(renderWorkers,1,'canonical preparation and replay share one renderer Worker');
  assert.equal(renderJobs,2,'both canonical validation passes still run');
  assert.equal(lastGain.gain.value,1,'legacy volume input cannot attenuate the audio graph');
  assert.equal(lastSource.rateAtStart,1,'default nearby playback remains at the canonical rate');
  assert.ok(lastBuffer.every(value=>Number.isFinite(value)&&Math.abs(value)<=1),'verified PCM remains within unclipped sample bounds');
  assert.equal(audioSession.type,'play-and-record','send never switches a live microphone to playback session');
  const before=decoderWorker.messages.filter(message=>message.type==='samples').length;
  lastNode.port.onmessage({data:{samples:new Float32Array(2048),startFrame:0}});
  assert.equal(decoderWorker.messages.filter(message=>message.type==='samples').length,before,'own playback is not decoded');
  context.currentTime=pcm.length/48000;lastSource.onended();await send;
  assert.equal(link.metrics.txFrames,1);assert.equal(link.metrics.txBytes,packet.length);
  assert.equal(link.playing,false);assert.equal(link.running,true);assert.equal(contextCount,2);
  lastNode.port.onmessage({data:{samples:new Float32Array(2048),startFrame:Math.floor((context.currentTime+0.1)*48000)}});
  assert.equal(decoderWorker.messages.filter(message=>message.type==='samples').length,before,'queued echo-tail samples are dropped by audio timestamp');
  const levels=new Float32Array(2048).fill(0.25);levels[0]=1;
  lastNode.port.onmessage({data:{samples:levels,startFrame:Math.ceil((context.currentTime+0.36)*48000)}});
  await eventLoop();assert.equal(decoderWorker.messages.filter(message=>message.type==='samples').length,before+1);
  assert.ok(link.metrics.inputRms>=0.25&&link.metrics.inputRms<0.26);assert.equal(link.metrics.inputPeak,1);assert.equal(link.metrics.inputClippedSamples,1);
  const epoch=link.epoch;
  decoderWorker.onmessage({data:{type:'decoded',id:999,epoch:epoch-1,packets:[packet],metrics:{crcRejectedCandidates:99}}});
  assert.equal(received.length,0,'decoder responses from suppressed playback epoch ignored');
  assert.equal(link.metrics.crcRejectedCandidates,0,'stale decoder metrics cannot overwrite current totals');
  const metricCount=metrics.length;
  decoderWorker.onmessage({data:{type:'decoded',id:1000,epoch,packets:[packet],metrics:{crcRejectedCandidates:3,invalidPayloadCandidates:5,correctedNibbles:2}}});
  assert.deepEqual(received,[packet]);
  assert.equal(link.metrics.rxFrames,1);assert.equal(link.metrics.rxBytes,packet.length);
  for(let i=0;i<30;i++)decoderWorker.onmessage({data:{type:'decoded',id:2000+i,epoch,packets:[]}});
  assert.equal(metrics.length,metricCount,'worker chunk rate does not drive UI callback rate');
  await new Promise(resolve=>setTimeout(resolve,260));
  assert.equal(metrics.length,metricCount+1,'metrics are coalesced at four updates per second');
  assert.equal(metrics.at(-1).crcRejectedCandidates,3);assert.equal(metrics.at(-1).correctedNibbles,2);
  metrics.at(-1).rxFrames=999;assert.equal(link.metrics.rxFrames,1,'observers receive an independent snapshot');
  const secondPacket=packet.slice();secondPacket[0]^=1;
  await link.prepare(secondPacket,link.generation);
  assert.equal(renderWorkers,1,'later packets reuse the same renderer Worker');
  assert.equal(renderJobs,4,'later packets still run both validation passes');
  const retainedRenderer=link.renderWorker;
  link.volume=5;
  const cachedJobs=renderJobs;const repeat=link.send(packet);await eventLoop();assert.equal(renderJobs,cachedJobs,'exact retransmission reuses bounded PCM cache');
  assert.equal(lastGain.gain.value,1,'invalidly high playback levels cannot amplify verified PCM');
  assert.equal(new AutoAudioLink({volume:-1}).volume,1);
  assert.equal(new AutoAudioLink({volume:NaN}).volume,1);
  link.stop();await assert.rejects(repeat,{name:'AbortError'});
  assert.equal(link.running,false);assert.equal(link.cache.size,0);assert.equal(audioSession.type,'auto');assert.equal(errors.length,0);
  assert.equal(link.metrics.screenWakeLock,'idle');assert.equal(wakeRequests,wakeReleases,'Stop releases the active screen lock');
  assert.equal(metrics.at(-1).inputRms,0);assert.equal(metrics.at(-1).inputPeak,0);
  assert.equal(metrics.at(-1).txFrames,1,'Stop preserves completed playback counts without counting an aborted frame');
  assert.equal(retainedRenderer.ended,true,'Stop terminates the renderer and its engine cache');
  const telephone=new AutoAudioLink({profile:'telephone'});
  await telephone.start();
  const slowContext=lastContext;
  assert.equal(decoderWorker.messages.find(message=>message.type==='init').profile,'telephone');
  const slow=telephone.send(packet);await eventLoop();await eventLoop();
  assert.equal(lastSource.rateAtStart,0.75,'telephone playback is slowed before the source starts');
  assert.equal(lastBuffer.length,pcm.length,'slow playback retains the canonical verified PCM length');
  assert.ok(lastBuffer.every((sample,index)=>sample===pcm[index]/32768),'slow playback retains every verified PCM sample');
  assert.equal(telephone.playing,true);assert.equal(audioSession.type,'play-and-record');
  slowContext.currentTime=pcm.length/(48000*0.75);lastSource.onended();await slow;
  assert.equal(telephone.playing,false);assert.equal(telephone.running,true);
  assert.equal(telephone.allowedAfter,slowContext.currentTime+0.35,'echo guard uses physical context time after slow playback');
  const slowRepeat=telephone.send(packet);await eventLoop();
  telephone.stop();await assert.rejects(slowRepeat,{name:'AbortError'});
  assert.equal(telephone.running,false);assert.equal(telephone.cache.size,0);assert.equal(audioSession.type,'auto');
  renderPCM=ultrasonicResult.pcm;
  const ultrasonic=new AutoAudioLink({profile:'ultrasonic'});
  await ultrasonic.start();
  assert.equal(decoderWorker.messages.find(message=>message.type==='init').profile,'ultrasonic');
  const high=ultrasonic.send(packet);await eventLoop();await eventLoop();
  assert.equal(lastSource.rateAtStart,1,'near-ultrasonic plays its separate timeline without another slowdown');
  assert.equal(lastBuffer.length,ultrasonicResult.pcm.length,'the full 8.32-second verified packet fits the render limit');
  assert.ok(lastBuffer.every((sample,index)=>sample===ultrasonicResult.pcm[index]/32768));
  lastContext.currentTime=lastBuffer.length/48000;lastSource.onended();await high;
  assert.equal(ultrasonic.allowedAfter,lastContext.currentTime+0.35,'near-ultrasonic echo guard remains physical time');
  ultrasonic.stop();assert.equal(audioSession.type,'auto');renderPCM=pcm;
  await link.start();const liveContext=lastContext;liveContext.state='interrupted';liveContext.onstatechange();
  assert.equal(link.metrics.rxFrames,0,'a new run resets diagnostics');
  assert.equal(link.running,false);assert.match(errors.at(-1),/interrupted/);assert.equal(liveContext.state,'closed');
  holdInit=true;const revoked=link.start();await eventLoop();
  link.stream.getTracks()[0].readyState='ended';releaseInit();
  await assert.rejects(revoked,/Microphone access ended during setup/);assert.equal(link.running,false);holdInit=false;
  holdInit=true;const interruptedSetup=link.start();await eventLoop();lastContext.state='interrupted';releaseInit();
  await assert.rejects(interruptedSetup,/Audio was interrupted during setup/);assert.equal(link.running,false);holdInit=false;
  await link.start();suppressDecoded=true;
  for(let i=0;i<40&&link.running;i++)lastNode.port.onmessage({data:{samples:new Float32Array(2048),startFrame:i*2048}});
  assert.equal(link.running,false,'decoder backpressure stops rather than retaining unbounded PCM');
  assert.match(errors.at(-1),/cannot decode audio fast enough/);suppressDecoded=false;
  assert.equal(wakeRequests,wakeReleases,'interruption and backpressure paths release every screen lock');
  const requestWake=wakeLock.request;wakeLock.request=async()=>{throw new DOMException('power saver','NotAllowedError');};
  await link.start();assert.equal(link.running,true);assert.equal(link.metrics.screenWakeLock,'denied','power saving can deny the lock without failing audio');
  link.stop();wakeLock.request=requestWake;
  gum=async()=>{throw new DOMException('denied','NotAllowedError');};
  await assert.rejects(link.start(),{name:'NotAllowedError'});assert.equal(link.running,false);assert.equal(audioSession.type,'auto');
  assert.ok(stopped>=3&&closed>=3);
}finally{for(const [name,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
console.log('PASS automatic audio lifecycle: one gesture/context, persistent microphone, own-audio/echo suppression, bounded retransmission cache, late permission, interruption and cancellation.');
