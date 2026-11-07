// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Diagnostic telephone-channel experiments. A no-decode result is a measured
// incompatibility, not a test failure or a reason to weaken byte-exact checks.
// FFmpeg and SoX are optional local tools; this script never installs software.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {StreamingDecoder} from '../web/auto-decoder.mjs';
import {payloadTimeline,pcmWav,textPayload} from '../web/communication-codec.mjs';

const root=new URL('../',import.meta.url),dist=new URL('dist/',root);
const argv=process.argv.slice(2),options={ffmpeg:'ffmpeg',sox:'sox',output:new URL('out/telephone-channel.json',root)};
while(argv.length){const flag=argv.shift(),value=argv.shift();if(!value||!['--ffmpeg','--sox','--output'].includes(flag))throw Error('Usage: node tests/telephone-channel.mjs [--ffmpeg PATH] [--sox PATH] [--output FILE]');options[flag.slice(2)]=value;}
const inspect=command=>{const result=spawnSync(command,['-version'],{encoding:'utf8',timeout:60000});return result.error?null:(result.stdout||result.stderr||'').split('\n')[0];};
const ffmpegVersion=inspect(options.ffmpeg);
const soxProbe=spawnSync(options.sox,['--version'],{encoding:'utf8',timeout:60000}),soxVersion=soxProbe.error?null:(soxProbe.stdout||soxProbe.stderr||'').trim();
const encoders=ffmpegVersion?(spawnSync(options.ffmpeg,['-hide_banner','-encoders'],{encoding:'utf8',timeout:60000}).stdout||''):'';
const hasEncoder=name=>new RegExp('\\s'+name+'\\s').test(encoders);
const registry=JSON.parse(await fs.readFile(new URL('engines.json',dist),'utf8'));
const engine=registry.engines.find(item=>item.id===registry.default||item.release_id===registry.default);
assert.ok(engine,'Build the app before running the telephone experiment.');
const {runCLI}=await import(new URL(engine.runtime_module||'runtime.mjs',dist));
const synthBytes=await fs.readFile(new URL(engine.browser_wasm,dist)),receiverBytes=await fs.readFile(new URL('communication-decoder.wasm',dist));
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
assert.equal(await hash(synthBytes),engine.browser_sha256);
const synth=await WebAssembly.compile(synthBytes),receiver=await WebAssembly.compile(receiverBytes);
const packetFixtures={short:textPayload('Telephone fixture'),handshakeSize:Uint8Array.from({length:84},(_,index)=>(index*71+19)&255),maximum:Uint8Array.from({length:128},(_,index)=>(index*73+3)&255)};
const fixtures={},events=[];
let cursor=0.25;
for(const [name,packet] of Object.entries(packetFixtures)){
  const first=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':payloadTimeline(packet,engine.identity)});
  assert.equal(first.code,0,first.stderr);
  const replay=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':new TextDecoder().decode(first.canonical)});
  assert.equal(replay.code,0,replay.stderr);assert.deepEqual(replay.pcm,first.pcm);
  fixtures[name]={packet,pcm:replay.pcm};events.push({name,startSeconds:cursor,packetBytes:packet.length,audioSeconds:replay.pcm.length/48000});
  cursor+=replay.pcm.length/48000+0.4;
}
const input=new Float32Array(Math.ceil((cursor+0.5)*48000));
for(const event of events){const pcm=fixtures[event.name].pcm,at=Math.round(event.startSeconds*48000);for(let i=0;i<pcm.length;i++)input[at+i]=pcm[i]/32768*0.8;}
function bandLimit(samples,low=300,high=3400,taps=1025){
  // Symmetric Blackman-windowed sinc bandpass, center compensated offline.
  // This deliberately explicit model is not an assertion about a real handset.
  const mid=(taps-1)/2,coefficients=new Float64Array(taps),sinc=x=>Math.abs(x)<1e-12?1:Math.sin(Math.PI*x)/(Math.PI*x);
  let normalization=0;
  for(let i=0;i<taps;i++){
    const n=i-mid,window=0.42-0.5*Math.cos(2*Math.PI*i/(taps-1))+0.08*Math.cos(4*Math.PI*i/(taps-1));
    coefficients[i]=(2*high/48000*sinc(2*high*n/48000)-2*low/48000*sinc(2*low*n/48000))*window;
    normalization+=coefficients[i]*Math.cos(2*Math.PI*2000*n/48000);
  }
  for(let i=0;i<taps;i++)coefficients[i]/=normalization;
  const result=new Float32Array(samples.length);
  for(let i=0;i<samples.length;i++){
    let value=0;const first=Math.max(0,mid-i),last=Math.min(taps,samples.length+mid-i);
    for(let tap=first;tap<last;tap++)value+=samples[i+tap-mid]*coefficients[tap];
    result[i]=value;
  }
  return result;
}
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'audio-phone-test-'));
const cases=[];
function command(program,args){const result=spawnSync(program,args,{encoding:null,maxBuffer:16*1024*1024,timeout:60000});if(result.error)throw result.error;if(result.status!==0)throw Error(`${path.basename(program)} refused telephone fixture: ${result.stderr?.toString().trim()}`);return result.stdout;}
async function saveWav(name,samples){const file=path.join(temporary,name);const pcm=Int16Array.from(samples,value=>Math.max(-32768,Math.min(32767,Math.round(value*32768))));await fs.writeFile(file,pcmWav(pcm));return file;}
function decodeFFmpeg(file,inputArgs=[]){const output=command(options.ffmpeg,['-v','error',...inputArgs,'-i',file,'-ac','1','-ar','48000','-f','f32le','pipe:1']);assert.equal(output.length%4,0);return new Float32Array(Uint8Array.from(output).buffer);}
async function examine(name,samples,transform,codecWallMs=0,{required=false}={}){
  assert.ok(samples.length&&samples.length<=48000*20,'Diagnostic waveform must fit decoder limits');
  assert.ok(samples.every(Number.isFinite),'Converted audio must be finite');
  const decoder=await StreamingDecoder.create(receiver,48000),decoded=[],started=performance.now();
  for(let offset=0;offset<samples.length;offset+=2048){
    for(const packet of decoder.push(samples.slice(offset,offset+2048))){
      const fixture=Object.entries(fixtures).find(([,value])=>Buffer.from(packet).equals(Buffer.from(value.packet)))?.[0];
      assert.ok(fixture,`${name}: decoded bytes do not match any source fixture`);
      assert.ok(!decoded.some(item=>item.fixture===fixture),`${name}: duplicate application packet`);
      decoded.push({fixture,atMs:Number((Math.min(samples.length,offset+2048)/48).toFixed(3))});
    }
  }
  const success=decoded.length===events.length;
  if(required)assert.deepEqual(decoded.map(item=>item.fixture),events.map(event=>event.name),'Unimpaired control must decode every packet');
  const row={name,status:success?'decoded-all':decoded.length?'partial':'no-decode',channelSuccess:success,integrityPassed:true,byteExact:decoded.length?true:null,
    transform,expectedPackets:events.length,decodedPackets:decoded.length,decoded,audioDurationMs:Number((samples.length/48).toFixed(3)),
    codecWallMs:Number(codecWallMs.toFixed(3)),decoderWallMs:Number((performance.now()-started).toFixed(3)),corruptPacketsAccepted:0};
  cases.push(row);console.log(`${row.status.toUpperCase()} ${name}: ${decoded.length}/${events.length} exact packets`);
}
async function encodedCase(name,inputFile,codec,rate,format,extra=[],inputArgs=[]){
  if(!ffmpegVersion||!hasEncoder(codec)){cases.push({name,status:'skipped',reason:`Local FFmpeg encoder ${codec} is unavailable`});return;}
  const file=path.join(temporary,`channel-${cases.length}.${format}`),start=performance.now();
  command(options.ffmpeg,['-v','error','-y','-i',inputFile,'-ar',String(rate),'-ac','1','-c:a',codec,...extra,'-f',format,file]);
  const samples=decodeFFmpeg(file,inputArgs);
  await examine(name,samples,{tool:'FFmpeg',codec,sampleRate:rate,format,options:extra,source:path.basename(inputFile)},performance.now()-start);
}
try{
  const source=await saveWav('source.wav',input);
  await examine('Unimpaired 48 kHz control',input,{sampleRate:48000},0,{required:true});
  const filtered=bandLimit(input),telephone=await saveWav('band-300-3400.wav',filtered);
  await examine('300–3400 Hz synthetic telephone band',filtered,{filter:'1025-tap Blackman-windowed sinc',lowHz:300,highHz:3400,offlineCenterCompensation:true});
  if(ffmpegVersion){
    const start=performance.now(),raw=path.join(temporary,'linear-8k.wav');
    command(options.ffmpeg,['-v','error','-y','-i',source,'-ar','8000','-ac','1','-c:a','pcm_s16le',raw]);
    await examine('8 kHz linear PCM round trip',decodeFFmpeg(raw),{codec:'pcm_s16le',sampleRate:8000,resampler:'FFmpeg default'},performance.now()-start);
  }else cases.push({name:'8 kHz linear PCM round trip',status:'skipped',reason:'FFmpeg unavailable'});
  await encodedCase('G.711 μ-law at 8 kHz',source,'pcm_mulaw',8000,'wav');
  await encodedCase('G.711 A-law at 8 kHz',source,'pcm_alaw',8000,'wav');
  await encodedCase('300–3400 Hz plus G.711 μ-law',telephone,'pcm_mulaw',8000,'wav');
  await encodedCase('G.722 wideband at 16 kHz / 64 kbit/s',source,'g722',16000,'g722',['-b:a','64k'],['-f','g722']);
  await encodedCase('Opus VoIP narrowband 8 kHz / 12 kbit/s',telephone,'libopus',8000,'ogg',['-application','voip','-b:a','12k','-vbr','off','-frame_duration','20']);
  await encodedCase('Opus VoIP wideband 16 kHz / 24 kbit/s',source,'libopus',16000,'ogg',['-application','voip','-b:a','24k','-vbr','off','-frame_duration','20']);
  if(soxVersion&&ffmpegVersion){
    const start=performance.now(),file=path.join(temporary,'full-rate.gsm');
    const result=spawnSync(options.sox,[telephone,'-r','8000','-c','1',file],{encoding:'utf8',timeout:60000});
    if(result.error||result.status!==0)cases.push({name:'GSM full rate at 8 kHz',status:'skipped',reason:'Local SoX GSM encoding unavailable: '+(result.error?.message||result.stderr.trim())});
    else await examine('GSM full rate at 8 kHz',decodeFFmpeg(file,['-f','gsm']),{tool:'SoX encoder / FFmpeg decoder',codec:'GSM full rate',sampleRate:8000,source:path.basename(telephone)},performance.now()-start);
  }else cases.push({name:'GSM full rate at 8 kHz',status:'skipped',reason:'Local SoX and FFmpeg are required'});
  cases.push({name:'AMR-NB / AMR-WB cellular codec',status:'skipped',reason:'AMR is not exercised by this diagnostic. The initial local FFmpeg build had no AMR encoder; GSM full rate and Opus are not substitutes for AMR qualification.'});
  const report={schemaVersion:1,createdAt:new Date().toISOString(),kind:'Telephone-channel diagnostics; not actual call qualification',
    route:'laptop speaker → phone microphone → call codec/network → phone speaker → laptop microphone',
    renderer:engine.id,rendererBrowserSha256:engine.browser_sha256,receiverSha256:await hash(receiverBytes),tools:{ffmpeg:ffmpegVersion,sox:soxVersion},
    profile:{toneMinHz:600,toneMaxHz:3750,symbolMs:20,simultaneousTones:4},fixtures:events,
    limitations:['The FIR bandpass is an explicit synthetic model, not a measured handset response.','No real microphones, speakers, room echo, AGC, noise suppression, VAD/DTX, packet concealment, or network are included.','A successful individual codec pass does not qualify a landline, GSM, VoLTE, or VoIP call path.','Opus is a VoIP comparison; it is not AMR. GSM full rate is a different codec from AMR-NB and AMR-WB.'],
    sources:[{title:'ITU-T P.341 conventional300–3400Hz telephony definition',url:'https://www.itu.int/epublications/publication/itu-t-p-341-2011-03-transmission-characteristics-for-wideband-digital-loudspeaking-and-hands-free-telephony-terminals'},
      {title:'ITU-T G.711 PCM',url:'https://www.itu.int/rec/T-REC-G.711-198811-I/en'},
      {title:'RFC4867 AMR/AMR-WB rates and VAD/DTX',url:'https://datatracker.ietf.org/doc/html/rfc4867#section-3'}],
    cases,summary:{tested:cases.filter(row=>row.status!=='skipped').length,decodedAll:cases.filter(row=>row.channelSuccess).length,partial:cases.filter(row=>row.status==='partial').length,noDecode:cases.filter(row=>row.status==='no-decode').length,skipped:cases.filter(row=>row.status==='skipped').length,corruptPacketsAccepted:0}};
  const destination=options.output;await fs.mkdir(destination instanceof URL?new URL('./',destination):path.dirname(destination),{recursive:true});
  await fs.writeFile(destination,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary));
}finally{await fs.rm(temporary,{recursive:true,force:true});}
