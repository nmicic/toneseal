#!/usr/bin/env node
// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {messageTimeline,readCaptureWav,receiverPCM,payloadText,acousticLimits} from './web/communication-codec.mjs';
const lab=path.dirname(fileURLToPath(import.meta.url));
const synth=path.resolve(process.env.JOTTUNE_SYNTH_ROOT||path.resolve(lab,'../jottune-synth')),args=process.argv.slice(2),command=args.shift();
function option(name,fallback){const index=args.indexOf(name);if(index<0)return fallback;if(!args[index+1])throw Error(name+' needs a value.');return args.splice(index,2)[1];}
function run(executable,argv){const result=spawnSync(executable,argv,{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});if(result.status!==0)throw Error(result.stderr||result.error?.message||'Native operation failed.');return result.stdout;}
try {
 if(command==='encode'){
  const text=option('--text'),out=option('--out'),harness=path.resolve(option('--harness',path.join(synth,'build/s12e10p1v1/harness')));
  if(args.length||text===undefined||!out)throw Error('encode requires --text MESSAGE --out NEW_DIRECTORY [--harness PATH].');
  const identity=run(harness,['--engine']).trim().slice(7),timeline=messageTimeline(text,identity),directory=path.resolve(out);
  fs.mkdirSync(directory);let complete=false;
  try {const draft=path.join(directory,'draft.tl'),record=path.join(directory,'message.tl'),wav=path.join(directory,'message.wav');fs.writeFileSync(draft,timeline,{flag:'wx'});
   const rendered=run(harness,['--play',draft,'--merged',record,'--wav',wav,'--metrics']);
   if(!/clipped=0/.test(rendered)||!/block_indep=yes/.test(rendered)||!/match=yes/.test(run(harness,['--play',record])))throw Error('Native canonical verification failed.');
   fs.unlinkSync(draft);complete=true;console.log(JSON.stringify({ok:true,experimental:true,encrypted:false,authenticated:false,record,wav}));
  }finally{if(!complete)fs.rmSync(directory,{recursive:true,force:true});}
 }else if(command==='decode'){
  const input=option('--wav'),decoder=path.resolve(option('--decoder',path.join(lab,'build/receiver')));
  if(args.length||!input)throw Error('decode requires --wav CAPTURE.wav [--decoder PATH].');
  if(fs.statSync(input).size>acousticLimits.fileBytes)throw Error('Capture exceeds 4 MiB.');
  const bytes=fs.readFileSync(input),capture=readCaptureWav(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),converted=receiverPCM(capture.samples,capture.rate);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'jottune-receive-'));
  try {const pcm=path.join(temporary,'capture.pcm');fs.writeFileSync(pcm,Buffer.from(converted.pcm.buffer));
   const rows=run(decoder,['stream',pcm,'irregular']).trim().split('\n').map(JSON.parse),messages=rows.filter(row=>row.kind==='packet').map(row=>({text:payloadText(Uint8Array.from(Buffer.from(row.payload_hex,'hex'))),sender:row.sender,onsetSample:row.inferred_onset_sample}));
   console.log(JSON.stringify({ok:messages.length>0,experimental:true,authenticated:false,inputRate:capture.rate,resampled:converted.resampled,clipped:converted.clipped,messages}));process.exitCode=messages.length?0:1;
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
 }else throw Error('Use encode --text MESSAGE --out NEW_DIRECTORY, or decode --wav CAPTURE.wav. This experimental channel is cleartext and unauthenticated.');
}catch(error){console.error(error.message);process.exitCode=2;}
