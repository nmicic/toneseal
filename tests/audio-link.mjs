// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {payloadTimeline, messageTimeline, textPayload, decodePCM, receiverPCM} from '../web/communication-codec.mjs';

const dist = new URL('../dist/', import.meta.url);
const registry = JSON.parse(await fs.readFile(new URL('engines.json', dist), 'utf8'));
const engine = registry.engines.find(entry => entry.id === registry.default || entry.release_id === registry.default);
const {runCLI} = await import(new URL(engine.runtime_module || 'runtime.mjs', dist));
const synth = await WebAssembly.compile(await fs.readFile(new URL(engine.browser_wasm, dist)));
const decoder = await WebAssembly.compile(await fs.readFile(new URL('communication-decoder.wasm', dist)));
assert.deepEqual(WebAssembly.Module.imports(decoder), []);
assert.equal(payloadTimeline(textPayload('Hello'),engine.identity),messageTimeline('Hello',engine.identity));
assert.throws(() => payloadTimeline(new Uint8Array(129),engine.identity));
assert.throws(() => payloadTimeline([1,2,3],engine.identity));
assert.throws(() => payloadTimeline(Uint8Array.of(1),'wrong engine'));

const vectors = [Uint8Array.of(255), Uint8Array.from({length:79},(_,i)=>(i*71)&255),
  Uint8Array.from({length:128},(_,i)=>i), Uint8Array.from({length:128},(_,i)=>128+i)];
let lastPCM;
for (const packet of vectors) {
  const authored = payloadTimeline(packet,engine.identity);
  const first = await runCLI(synth, ['--play','record.tl','--merged','canonical.tl'], {'record.tl':authored});
  assert.equal(first.code,0,first.stderr);
  assert.ok(first.canonical.length);
  const replay = await runCLI(synth, ['--play','record.tl','--metrics'], {'record.tl':first.canonical});
  assert.equal(replay.code,0,replay.stderr);
  assert.match(replay.stdout,/match=yes/); assert.match(replay.stdout,/block_indep=yes/);
  assert.match(replay.stdout,/clipped=0/);
  assert.deepEqual(replay.pcm,first.pcm);
  assert.ok(replay.pcm.length <= 4.16 * 48000);
  const clean = await decodePCM(decoder,replay.pcm);
  assert.equal(clean.messages.length,1); assert.deepEqual(clean.messages[0].bytes,packet);
  const offset = new Int16Array(replay.pcm.length+317); offset.set(replay.pcm,317);
  const shifted = await decodePCM(decoder,offset);
  assert.equal(shifted.messages.length,1); assert.deepEqual(shifted.messages[0].bytes,packet);
  const source = replay.pcm;
  const samples44100 = Float32Array.from({length:Math.floor(source.length*44100/48000)},(_,i)=>{
    const position=i*48000/44100, at=Math.floor(position), mix=position-at;
    return (source[at]*(1-mix)+source[Math.min(at+1,source.length-1)]*mix)/32768;
  });
  const converted = await decodePCM(decoder,receiverPCM(samples44100,44100).pcm);
  assert.equal(converted.messages.length,1); assert.deepEqual(converted.messages[0].bytes,packet);
  lastPCM = replay.pcm;
}
const repeated = new Int16Array(lastPCM.length*2+4800);
repeated.set(lastPCM); repeated.set(lastPCM,lastPCM.length+4800);
assert.equal((await decodePCM(decoder,repeated)).messages.length,2);
assert.equal((await decodePCM(decoder,new Int16Array(48000))).messages.length,0);
assert.equal((await decodePCM(decoder,lastPCM.slice(0,5000))).messages.length,0);
console.log('PASS binary synth → canonical replay → decoder: full byte alphabet, 128-byte packets, offsets, 44.1 kHz, duplicate packets and refusal.');

// Browser lifecycle tests use explicit microphone/worker substitutes. These
// exercise ownership and cancellation, not real device or permission behavior.
const {AudioLink} = await import(new URL('audio-link.mjs',dist));
const saved = new Map(['navigator','AudioContext','AudioWorkletNode','Worker'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
let grant, stopped=0, closed=0, terminated=0, callbackCount=0, lastSource, lastGain;
const stream = {getTracks:()=>[{stop(){stopped++;}}]};
class MockContext {
  constructor() { this.sampleRate=48000; this.audioWorklet={addModule:async()=>{}}; }
  resume() { return Promise.resolve(); }
  close() { closed++; return Promise.resolve(); }
  createMediaStreamSource() { return {connect:node=>node}; }
  createBuffer(channels,length) { return {getChannelData:()=>new Float32Array(length)}; }
  createGain() { lastGain={gain:{value:1},connect(){return this;}};return lastGain; }
  createBufferSource() {
    lastSource={connect:node=>node,start(){},stop(){queueMicrotask(()=>this.onended?.());}};
    return lastSource;
  }
}
class MockNode {
  constructor() {
    this.port={postMessage:()=>queueMicrotask(()=>{
      this.port.onmessage({data:{samples:Float32Array.from(lastPCM,value=>value/32768)}});
      this.port.onmessage({data:{done:true}});
    })};
  }
  connect() { return this; }
  disconnect() {}
}
class MockWorker {
  postMessage(data) {
    queueMicrotask(async()=>{
      const result=await decodePCM(decoder,receiverPCM(data.samples,data.rate).pcm);
      if (!this.ended) this.onmessage({data:{ok:true,packets:result.messages.map(message=>message.bytes)}});
    });
  }
  terminate() { this.ended=true; terminated++; }
}
try {
  // Safari exposes Audio Session: explicit playback is incompatible with a
  // microphone capture track. Enforce the spec's capture-compatible types so
  // the send→receive transition cannot silently pass in Chromium-only tests.
  const audioSession = {type:'playback'};
  const captureCompatible = () => assert.equal(audioSession.type,'play-and-record',
    'listen must leave playback mode before requesting microphone access');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{audioSession,
    mediaDevices:{getUserMedia:()=>{captureCompatible();return new Promise(resolve=>{grant=resolve;});}}}});
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:MockContext});
  Object.defineProperty(globalThis,'AudioWorkletNode',{configurable:true,value:MockNode});
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:MockWorker});
  const late=new AudioLink();
  const pending=late.listen();
  if (!grant) await pending; // Surface an early capture-policy failure directly.
  late.cancel(); grant(stream);
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(stopped,1,'permission arriving after cancellation closes microphone tracks');
  assert.equal(closed,1,'cancel closes the already-created audio context');
  assert.equal(late.recording,false);
  assert.equal(audioSession.type,'auto','cancel releases the explicit audio-session override');
  navigator.mediaDevices.getUserMedia=async()=>{captureCompatible();return stream;};
  const link=new AudioLink({onPackets:packets=>{
    callbackCount++; assert.deepEqual(packets,[vectors.at(-1)]);
  }});
  await link.listen(); assert.equal(link.recording,true);
  const packets=await link.finish();
  assert.deepEqual(packets,[vectors.at(-1)]);
  assert.equal(callbackCount,1,'manual completion delivers packets once');
  assert.equal(link.recording,false); assert.equal(link.busy,false);
  assert.equal(audioSession.type,'auto','finishing capture releases audio-session override');
  assert.equal(stopped,2,'completion stops microphone tracks');
  assert.equal(terminated,1,'completion terminates decoder worker');
  await link.listen();
  link.cancel(); assert.equal(link.recording,false); assert.equal(stopped,3);
  await assert.rejects(link.finish(),/Start listening/);
  link.clear(); assert.equal(link.prepared,null);
  link.prepared={pcm:lastPCM,seconds:lastPCM.length/48000};
  link.volume=0.2; // Old callers cannot attenuate the fixed full-level signal.
  let completed=false;
  const played=link.play().then(()=>{completed=true;});
  await Promise.resolve();
  assert.equal(link.playing,true); assert.equal(completed,false,'play waits for natural playback completion');
  assert.equal(audioSession.type,'playback','playback uses the speaker playback session');
  assert.equal(lastGain.gain.value,1,'manual playback is always 100%');
  lastSource.onended(); await played;
  assert.equal(completed,true); assert.equal(link.playing,false);
  assert.equal(audioSession.type,'auto','completed playback releases the explicit override');
  await link.listen();
  assert.equal(link.recording,true,'microphone can reopen after this device played a packet');
  link.cancel();
  const interrupted=link.play(); await Promise.resolve();
  link.cancel();
  await assert.rejects(interrupted,{name:'AbortError'});
  assert.equal(link.playing,false,'cancel rejects playback without hanging');
  assert.equal(audioSession.type,'auto','cancelled playback releases the explicit override');
  navigator.mediaDevices.getUserMedia=async()=>{captureCompatible();throw new DOMException('Microphone denied','NotAllowedError');};
  await assert.rejects(link.listen(),{name:'NotAllowedError'});
  assert.equal(audioSession.type,'auto','microphone permission failure releases the override');
} finally {
  for (const [key,descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
  }
}
console.log('PASS audio lifecycle: late permission, capture flush, media/worker cleanup, playback completion/cancellation, and capture-compatible audio-session transitions.');
