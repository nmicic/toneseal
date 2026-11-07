// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Experimental reversible time scaling of the existing verified modem. This
// does not alter its framing, native decoder, session protocol, or browser UI.
// Requires a built dist/, FFmpeg, and SoX with GSM support. Examples:
//   node tests/telephone-profiles.mjs
//   node tests/telephone-profiles.mjs --rates 0.75 --patterns 12 --output out/telephone-profiles-extended.json
// Channel failures are diagnostic results; clean failures or corrupt accepted
// packets are fatal. Real phone-call qualification is a separate experiment.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {StreamingDecoder} from '../web/auto-decoder.mjs';
import {payloadTimeline,pcmWav} from '../web/communication-codec.mjs';

const root=new URL('../',import.meta.url),dist=new URL('dist/',root);
const args=process.argv.slice(2),options={ffmpeg:'ffmpeg',sox:'sox',rates:[1,0.75,2/3,0.5],
  patterns:3,output:new URL('out/telephone-profiles.json',root)};
while(args.length){
  const flag=args.shift(),value=args.shift();
  if(!value)throw Error('Every option requires a value.');
  if(flag==='--rates')options.rates=value.split(',').map(Number);
  else if(flag==='--patterns')options.patterns=Number(value);
  else if(['--ffmpeg','--sox','--output'].includes(flag))options[flag.slice(2)]=value;
  else throw Error('Usage: node tests/telephone-profiles.mjs [--rates 1,0.75,0.6666666666666666,0.5] [--patterns 3] [--ffmpeg PATH] [--sox PATH] [--output FILE]');
}
assert.ok(options.rates.length&&options.rates.every(rate=>Number.isFinite(rate)&&rate>=0.25&&rate<=1),'Playback rates must be 0.25–1.');
assert.ok(Number.isInteger(options.patterns)&&options.patterns>=1&&options.patterns<=12,'Use 1–12 deterministic patterns.');
function command(program,argv){
  const result=spawnSync(program,argv,{encoding:null,maxBuffer:256*1024*1024,timeout:60000});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`${path.basename(program)}: ${result.stderr?.toString().trim()}`);
  return result.stdout;
}
const tools={ffmpeg:command(options.ffmpeg,['-version']).toString().split('\n')[0],
  sox:command(options.sox,['--version']).toString().trim()};
const registry=JSON.parse(await fs.readFile(new URL('engines.json',dist),'utf8'));
const engine=registry.engines.find(item=>item.id===registry.default||item.release_id===registry.default);
assert.ok(engine,'Build the app before testing profiles.');
const {runCLI}=await import(new URL(engine.runtime_module||'runtime.mjs',dist));
const synthBytes=await fs.readFile(new URL(engine.browser_wasm,dist));
const receiverBytes=await fs.readFile(new URL('communication-decoder.wasm',dist));
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
assert.equal(await hash(synthBytes),engine.browser_sha256);
const synth=await WebAssembly.compile(synthBytes),receiver=await WebAssembly.compile(receiverBytes);
function seededBytes(size,seed){let state=seed>>>0;return Uint8Array.from({length:size},()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state&255;});}
const fixtures=[];
for(const size of [84,113,128])for(let pattern=0;pattern<options.patterns;pattern++){
  const seed=(0x4b1d239a+pattern*0x9e3779b9+size)>>>0;
  const packet=pattern?seededBytes(size,seed):Uint8Array.from({length:size},(_,index)=>(index*73+size)&255);
  const first=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':payloadTimeline(packet,engine.identity)});
  assert.equal(first.code,0,first.stderr);
  const second=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':new TextDecoder().decode(first.canonical)});
  assert.equal(second.code,0,second.stderr);assert.deepEqual(second.pcm,first.pcm);
  fixtures.push({name:`${size}-${pattern?'seed-'+seed.toString(16):'ramp'}`,seed:pattern?seed:null,packet,
    pcm:Float32Array.from(second.pcm,value=>value/32768*0.8)});
}
let cursor=0.3;
for(const fixture of fixtures){fixture.startSeconds=cursor;cursor+=fixture.pcm.length/48000+0.5;}
const original=new Float32Array(Math.ceil((cursor+0.3)*48000));
for(const fixture of fixtures)original.set(fixture.pcm,Math.round(fixture.startSeconds*48000));
function changeRate(samples,rate){
  if(rate===1)return samples;
  const result=new Float32Array(Math.ceil(samples.length/rate));
  for(let i=0;i<result.length;i++){
    const position=i*rate,index=Math.floor(position),fraction=position-index;
    result[i]=samples[Math.min(index,samples.length-1)]*(1-fraction)+samples[Math.min(index+1,samples.length-1)]*fraction;
  }
  return result;
}
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'toneseal-profiles-')),profiles=[];
async function save(name,samples){
  const file=path.join(temporary,name);
  const pcm=Int16Array.from(samples,value=>Math.max(-32768,Math.min(32767,Math.round(value*32768))));
  await fs.writeFile(file,pcmWav(pcm));return file;
}
function readAudio(file,inputArgs=[]){
  const raw=command(options.ffmpeg,['-v','error',...inputArgs,'-i',file,'-ac','1','-ar','48000','-f','f32le','pipe:1']);
  assert.equal(raw.length%4,0);return new Float32Array(Uint8Array.from(raw).buffer);
}
async function examine(profile,channel,samples,{required=false}={}){
  const normalized=changeRate(samples,1/profile.playbackRate),decoder=await StreamingDecoder.create(receiver,48000),decoded=[];
  const started=performance.now();
  for(let at=0;at<normalized.length;at+=2048){
    for(const packet of decoder.push(normalized.slice(at,at+2048))){
      const fixture=fixtures.find(item=>Buffer.from(item.packet).equals(Buffer.from(packet)));
      assert.ok(fixture,`${channel}@${profile.playbackRate}: corrupt or unknown packet accepted`);
      assert.ok(!decoded.some(item=>item.fixture===fixture.name),`${channel}@${profile.playbackRate}: duplicate packet`);
      decoded.push({fixture:fixture.name,packetBytes:packet.length,physicalAtMs:Number((Math.min(at+2048,normalized.length)/48/profile.playbackRate).toFixed(3))});
    }
  }
  if(required)assert.deepEqual(decoded.map(item=>item.fixture),fixtures.map(item=>item.name),'Clean reversible time scaling must preserve every packet.');
  const row={channel,status:decoded.length===fixtures.length?'decoded-all':decoded.length?'partial':'no-decode',
    expectedPackets:fixtures.length,decodedPackets:decoded.length,corruptPacketsAccepted:0,byteExact:decoded.length?true:null,
    physicalAudioDurationMs:Number((samples.length/48).toFixed(3)),decoderWallMs:Number((performance.now()-started).toFixed(3)),decoded,
    missed:fixtures.filter(fixture=>!decoded.some(item=>item.fixture===fixture.name)).map(fixture=>fixture.name)};
  profile.cases.push(row);console.log(`${row.status.toUpperCase()} rate ${profile.playbackRate} ${channel}: ${decoded.length}/${fixtures.length} exact packets`);
}
const started=performance.now();
try{
  for(const rate of options.rates){
    const profile={playbackRate:rate,symbolMs:20/rate,toneMinHz:600*rate,toneMaxHz:3750*rate,
      airtimeMultiplier:1/rate,maxPacketAudioMs:4160/rate,cases:[]};profiles.push(profile);
    const stretched=changeRate(original,rate),source=await save(`source-${rate}.wav`,stretched);
    await examine(profile,'clean',stretched,{required:true});
    const band=path.join(temporary,`band-${rate}.wav`);
    command(options.sox,[source,band,'sinc','300-3400']);
    await examine(profile,'300–3400 Hz SoX sinc bandpass',readAudio(band));
    const g711=path.join(temporary,`g711-${rate}.wav`);
    command(options.ffmpeg,['-v','error','-y','-i',band,'-ar','8000','-ac','1','-c:a','pcm_mulaw',g711]);
    await examine(profile,'bandpass + G.711 μ-law 8 kHz',readAudio(g711));
    const gsm=path.join(temporary,`gsm-${rate}.gsm`);
    command(options.sox,[band,'-r','8000','-c','1',gsm]);
    await examine(profile,'bandpass + GSM full rate 8 kHz',readAudio(gsm,['-f','gsm']));
  }
  const report={schemaVersion:1,createdAt:new Date().toISOString(),kind:'Experimental reversible speed profiles; not real telephone acceptance',tools,
    renderer:engine.id,rendererBrowserSha256:engine.browser_sha256,receiverSha256:await hash(receiverBytes),
    model:{renderRate:48000,playbackGain:0.8,rateConversion:'Linear interpolation; physical sample i reads canonical sample i*rate. Receiver reverses by reading physical sample i/rate.',
      bandpass:'SoX sinc 300–3400 Hz, default transition/phase settings',
      limitations:['No actual handset, echo, AGC, VAD/DTX, network, or capture clock drift.','Codec paths are isolated experiments, not proof of a landline or GSM call.','No AMR-NB/AMR-WB codec is tested.','Both peers must use the same rate; automatic rate negotiation is not implemented.']},
    fixtures:fixtures.map(({name,seed,packet,pcm,startSeconds})=>({name,seed,packetBytes:packet.length,canonicalAudioMs:pcm.length/48,canonicalStartSeconds:startSeconds})),profiles,
    summary:{profiles:profiles.length,cases:profiles.reduce((sum,profile)=>sum+profile.cases.length,0),
      decodedPackets:profiles.reduce((sum,profile)=>sum+profile.cases.reduce((count,row)=>count+row.decodedPackets,0),0),corruptPacketsAccepted:0,
      wallDurationMs:Number((performance.now()-started).toFixed(3))}};
  const output=options.output;await fs.mkdir(output instanceof URL?new URL('./',output):path.dirname(output),{recursive:true});
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.summary));
}finally{await fs.rm(temporary,{recursive:true,force:true});}
