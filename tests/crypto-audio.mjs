// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Real compact-session records travel through the synth and native decoder
// before reaching their peer. This is synthetic PCM, not a physical call test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {AudioSession} from '../web/session.mjs';
import {getAudioProfile} from '../web/audio-profiles.mjs';
import {StreamingDecoder} from '../web/auto-decoder.mjs';
import {payloadTimeline} from '../web/communication-codec.mjs';

const dist=new URL('../dist/',import.meta.url),utf8=new TextEncoder();
const registry=JSON.parse(await fs.readFile(new URL('engines.json',dist),'utf8'));
const engine=registry.engines.find(item=>item.id===registry.default||item.release_id===registry.default);
assert.ok(engine,'Build the app before running the crypto/audio check.');
const {runCLI}=await import(new URL(engine.runtime_module||'runtime.mjs',dist));
const synthBytes=await fs.readFile(new URL(engine.browser_wasm,dist));
const receiverBytes=await fs.readFile(new URL('communication-decoder.wasm',dist));
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
const rendererBrowserSha256=await hash(synthBytes),receiverSha256=await hash(receiverBytes);
assert.equal(rendererBrowserSha256,engine.browser_sha256);
const synth=await WebAssembly.compile(synthBytes),receiver=await WebAssembly.compile(receiverBytes);
const rounded=value=>Number(value.toFixed(3));
const key=packet=>Buffer.from(packet).toString('hex');
function random(seed){let state=seed>>>0;return()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/0x100000000;};}

function capture(pcm,{sampleRate,playbackRate,noisePeak,seed}){
  const lead=Math.round(sampleRate*0.1),tail=Math.round(sampleRate*0.3);
  const step=48000*playbackRate/sampleRate,length=Math.ceil(pcm.length/step);
  const samples=new Float32Array(lead+length+tail),rng=random(seed);
  for(let i=0;i<length;i++){
    const position=i*step,index=Math.floor(position),fraction=position-index;
    samples[lead+i]=(pcm[Math.min(index,pcm.length-1)]*(1-fraction)+pcm[Math.min(index+1,pcm.length-1)]*fraction)/32768*0.6;
  }
  for(let i=0;i<samples.length;i++)samples[i]+=(rng()*2-1)*noisePeak;
  assert.ok(samples.every(value=>Number.isFinite(value)&&Math.abs(value)<=1));
  return samples;
}

async function runCase({profile,sampleRate,noisePeak=0,loseAck=false}){
  const audio=getAudioProfile(profile),started=performance.now(),cache=new Map(),frames=[],applications=[];
  const a=new AudioSession({cryptoProfile:'x25519'}),b=new AudioSession({cryptoProfile:'x25519'});
  const decoders=new Map([[a,await StreamingDecoder.create(receiver,sampleRate,profile)],[b,await StreamingDecoder.create(receiver,sampleRate,profile)]]);
  async function render(packet){
    const id=key(packet);if(cache.has(id))return{pcm:cache.get(id),cached:true,renderMs:0};
    const begin=performance.now();
    const first=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':payloadTimeline(packet,engine.identity)});
    assert.equal(first.code,0,first.stderr);
    const second=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':new TextDecoder().decode(first.canonical)});
    assert.equal(second.code,0,second.stderr);assert.deepEqual(second.pcm,first.pcm,'Canonical replay must retain the waveform exactly.');
    cache.set(id,second.pcm);
    return{pcm:second.pcm,cached:false,renderMs:performance.now()-begin};
  }
  async function transmit(packet,peer,kind,{discard=false}={}){
    assert.ok(packet instanceof Uint8Array&&packet.length<=128);
    assert.equal(packet[1],3,'Every compact-session frame uses its bound protocol version.');
    assert.ok(frames.length<12,'A lost receipt must recover within one exact retry.');
    const waveform=await render(packet),samples=capture(waveform.pcm,{sampleRate,playbackRate:audio.playbackRate,noisePeak,seed:0x7a651213+frames.length});
    const decoder=decoders.get(peer),decoded=[],begin=performance.now();
    // Automatic transport resets capture around each local playback. Reset at
    // a listening turn here; continuous-window boundaries have their own suite.
    decoder.reset();
    const chunks=[1,127,2048,4096,513,8192];let offset=0,chunk=0;
    while(offset<samples.length){const end=Math.min(samples.length,offset+chunks[chunk++%chunks.length]);decoded.push(...decoder.push(samples.slice(offset,end)));offset=end;}
    assert.equal(decoded.length,1,`${profile}/${sampleRate} ${kind}: exactly one physical packet must decode`);
    assert.deepEqual(decoded[0],packet,`${kind}: only byte-exact received records may reach the peer session`);
    frames.push({kind,bytes:packet.length,byteExact:true,discardedAfterDecode:discard,cachedWaveform:waveform.cached,
      canonicalSamples:waveform.pcm.length,waveformAirMs:rounded(waveform.pcm.length/48/audio.playbackRate),captureDurationMs:rounded(samples.length/sampleRate*1000),
      renderWallMs:rounded(waveform.renderMs),decodeWallMs:rounded(performance.now()-begin)});
    if(discard)return null;
    const result=await peer.receive(decoded[0]);
    if(result.type==='password'||result.type==='message')applications.push({peer:peer===a?'A':'B',type:result.type,text:result.text});
    return result;
  }
  try{
    const offer=await a.offer();assert.equal(offer.length,51);
    const answer=(await transmit(offer,b,'offer')).outbound;assert.equal(answer.length,51);
    await transmit(answer,a,'answer');
    const initialFingerprint=a.info.fingerprint;
    assert.ok(initialFingerprint);assert.equal(initialFingerprint,b.info.fingerprint);
    await transmit(await a.confirm(),b,'ready-a');await transmit(await b.confirm(),a,'ready-b');
    let packet=await a.rekey(),peer=b,step=0;
    const labels=['rekey-offer','rekey-answer','rekey-ready-a','rekey-ready-b'];
    while(packet){
      assert.ok(step<labels.length,'Rekey has a bounded four-flight exchange.');
      if(step<2)assert.equal(packet.length,80);
      const result=await transmit(packet,peer,labels[step++]);packet=result.outbound;peer=peer===a?b:a;
    }
    assert.equal(step,4);assert.equal(frames.length,8);
    assert.equal(a.info.state,'ready');assert.equal(b.info.state,'ready');
    assert.equal(a.info.fingerprint,b.info.fingerprint);assert.notEqual(a.info.fingerprint,initialFingerprint);
    assert.equal(applications.length,0,'Key exchange never releases application data.');
    const text='é'.repeat(48);assert.equal(utf8.encode(text).length,96);
    const data=await a.send('password',text);assert.equal(data.length,128);
    const received=await transmit(data,b,'password');assert.equal(received.type,'password');assert.equal(received.receipt,true);
    assert.equal(received.outbound.length,44);
    await transmit(received.outbound,a,'ack',{discard:loseAck});
    if(loseAck){
      assert.equal(a.info.pendingCount,1,'A dropped receipt cannot confirm delivery.');
      const retry=a.retryPending();assert.deepEqual(retry,data,'Retry must preserve the original ciphertext and nonce.');
      const repeated=await transmit(retry,b,'password-retry');
      assert.equal(repeated.type,'duplicate');assert.equal(repeated.receipt,true);
      assert.equal(repeated.text,undefined,'Duplicate ciphertext must not release plaintext a second time.');
      await transmit(repeated.outbound,a,'ack-retry');
    }
    assert.equal(a.info.pendingCount,0);assert.equal(b.info.pendingCount,0);
    assert.deepEqual(applications,[{peer:'B',type:'password',text}]);
    assert.equal(frames.length,loseAck?12:10);
    if(loseAck)assert.equal(frames.find(frame=>frame.kind==='password-retry').cachedWaveform,true);
    const result={name:`compact ${profile} ${sampleRate} Hz${loseAck?' / lost ACK':''}`,passed:true,cryptoProfile:'x25519',audioProfile:profile,sampleRate,
      noisePeak,gain:0.6,lostReceipts:loseAck?1:0,applicationBytes:96,applicationDeliveries:applications.length,
      byteExact:true,decodedPackets:frames.length,corruptPacketsAccepted:0,
      waveformAirMs:rounded(frames.reduce((sum,frame)=>sum+frame.canonicalSamples,0)/48/audio.playbackRate),wallDurationMs:rounded(performance.now()-started),frames};
    console.log(`PASS ${result.name}: ${frames.length} exact decoded records, one 96-byte password, ${result.waveformAirMs} ms waveform airtime`);
    return result;
  }finally{a.reset();b.reset();cache.clear();}
}

const cases=[];
for(const config of [
  {profile:'nearby',sampleRate:48000},
  {profile:'telephone',sampleRate:48000,noisePeak:0.001},
  {profile:'telephone',sampleRate:44100,noisePeak:0.001,loseAck:true},
])cases.push(await runCase(config));
const report={schemaVersion:1,createdAt:new Date().toISOString(),kind:'Real compact session over synthetic PCM and native decoding',
  renderer:engine.id,rendererBrowserSha256,receiverSha256,
  model:{limitations:'No microphone, physical call, speech codec, room echo, or hardware latency. Each listening turn resets its decoder. Airtime excludes turnaround, preparation, retry waits, and synthetic capture padding; wall duration measures local test execution.',
    capture:'Linear interpolation applies playback speed and capture rate; fixed-seed uniform white noise is added before the production profile-aware streaming decoder.',
    keys:'Fresh real native Web Crypto keys; payload is dummy data. No keys, packet contents, or fingerprints are written to this report.'},
  cases,summary:{cases:cases.length,passed:cases.length,decodedPackets:cases.reduce((sum,item)=>sum+item.decodedPackets,0),applicationDeliveries:cases.length,corruptPacketsAccepted:0}};
await fs.mkdir(new URL('../out/',import.meta.url),{recursive:true});
await fs.writeFile(new URL('../out/crypto-audio.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log('Report: out/crypto-audio.json');
