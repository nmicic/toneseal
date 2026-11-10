// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {acousticLimits,textPayload,messageTimeline,readCaptureWav,pcmWav} from './communication-codec.mjs';
import {selectEngine} from './policy.mjs';
import {MAX_PLAYBACK_GAIN,ScreenAwake,installPlaybackHints} from './audio-environment.mjs';
const screenAwake=new ScreenAwake();installPlaybackHints();
const element=id=>document.getElementById(id),status=text=>{element('communication-status').textContent=text;};
let generation=0,abort=null,jobCancel=null,audio=null,source=null,microphone=null,captureNode=null,captureTimeout=null;
let prepared=null,captured=null,captureParts=[],captureFrames=0,captureRate=0,busy=false;
function controls(){for(const id of ['prepare','capture','capture-file'])element(id).disabled=busy;
  for(const id of ['play-message','save-tl','save-wav','loopback'])element(id).disabled=busy||!prepared;
  element('stop-message').disabled=!source;element('finish-capture').disabled=!microphone;element('save-capture').disabled=busy||!captured;}
function haltMedia(){screenAwake.stop();clearTimeout(captureTimeout);captureTimeout=null;try{source?.stop();}catch{}source=null;captureNode?.disconnect();captureNode=null;
  microphone?.getTracks().forEach(track=>track.stop());microphone=null;audio?.close().catch(()=>{});audio=null;try{if(navigator.audioSession)navigator.audioSession.type='auto';}catch{}}
function cancel(message='Cancelled. Nothing is recording.'){generation++;abort?.abort();abort=null;jobCancel?.();jobCancel=null;haltMedia();captureParts=[];captureFrames=0;busy=false;controls();status(message);}
function failure(error,token){if(token!==generation)return;cancel(error.message||String(error));}
function workerJob(filename,data,transfer=[]){return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(filename,import.meta.url),{type:'module'});let finished=false;
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);worker.terminate();if(jobCancel===stop)jobCancel=null;error?reject(error):resolve(value);};
  const stop=()=>finish(new DOMException('Cancelled','AbortError'));
  const timer=setTimeout(()=>finish(Error('Work exceeded the 60-second budget. Try a shorter capture.')),acousticLimits.workerSeconds*1000);jobCancel=stop;
  worker.onerror=event=>finish(Error(event.message||'Worker failed.'));worker.onmessage=event=>finish(null,event.data);worker.postMessage(data,transfer);
});}
function save(bytes,type,name){const url=URL.createObjectURL(new Blob([bytes],{type})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function registry(){const response=await fetch(new URL('./engines.json',import.meta.url),{signal:abort.signal});if(!response.ok)throw Error('Synth registry is unavailable.');return selectEngine(await response.json());}
async function prepare(){cancel('Preparing native synth audio…');const token=generation;busy=true;prepared=null;controls();abort=new AbortController();
  try {const engine=await registry();if(token!==generation)return;
    const recordText=messageTimeline(element('message').value,engine.identity);
    let result=await workerJob('./worker.mjs',{recordText,engine,mode:'verify'});
    if(token!==generation)return;
    if(result.verdict!=='valid'||!result.canonical?.length)throw Error(result.stderr||'Synth refused the message timeline.');
    // A newly authored record has no saved hash; replay the native canonical output.
    result=await workerJob('./worker.mjs',{recordText:new TextDecoder().decode(result.canonical),engine,mode:'verify'});
    if(token!==generation)return;
    if(!result.verified||result.channels!==1||result.sampleRate!==48000||result.play?.clipped!=='0'||!result.pcm?.length)throw Error(result.stderr||'Canonical packet verification did not complete.');
    prepared=result;busy=false;controls();status(`Ready: ${(result.pcm.length/48000).toFixed(2)} seconds of verified native synth audio. Press Play; nothing has played yet.`);
  } catch(error){failure(error,token);}}
async function play(){if(!prepared||busy)return;cancel('Starting playback…');const token=generation;
  try {try{if(navigator.audioSession)navigator.audioSession.type='playback';}catch{}
    const context=new AudioContext({sampleRate:48000});audio=context;void screenAwake.start();await context.resume();if(token!==generation)return;
    const buffer=context.createBuffer(1,prepared.pcm.length,48000);buffer.getChannelData(0).set(Float32Array.from(prepared.pcm,value=>value/32768));
    const voice=context.createBufferSource(),gain=context.createGain();gain.gain.value=MAX_PLAYBACK_GAIN;voice.buffer=buffer;voice.connect(gain).connect(context.destination);source=voice;
    voice.onended=()=>{if(token!==generation)return;source=null;screenAwake.stop();context.close().catch(()=>{});audio=null;try{if(navigator.audioSession)navigator.audioSession.type='auto';}catch{}controls();status('Message playback finished.');};voice.start();controls();status('Playing cleartext message.');
  }catch(error){failure(error,token);}}
async function decode(samples,rate,label){cancel('Decoding '+label+'…');const token=generation;busy=true;controls();element('received').replaceChildren();
  try {const result=await workerJob('./communication-worker.mjs',{samples,rate},[samples.buffer]);if(token!==generation)return;if(!result.ok)throw Error(result.error);
    for(const message of result.messages){const paragraph=document.createElement('p');paragraph.textContent=message.text;element('received').append(paragraph);}
    busy=false;controls();status(result.messages.length?`${result.messages.length} message occurrence(s) recovered from ${label}; unauthenticated. ${result.resampled?'Nominal 44.1 kHz input resampled to 48 kHz. ':''}${result.clipped} clipped input samples.`:`No valid packet recovered from ${label}. Nothing was accepted; try a closer/quieter placement or another capture.`);
  }catch(error){failure(error,token);}}
async function startCapture(){cancel('Requesting microphone access…');const token=generation;busy=true;captured=null;captureParts=[];captureFrames=0;controls();
  try {if(!navigator.mediaDevices?.getUserMedia)throw Error('Microphone capture needs a supported browser and secure HTTPS page.');
    try{if(navigator.audioSession)navigator.audioSession.type='play-and-record';}catch{}
    const context=new AudioContext({sampleRate:48000});audio=context;const resumed=context.resume();resumed.catch(()=>{});
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
    if(token!==generation){stream.getTracks().forEach(track=>track.stop());return;}microphone=stream;void screenAwake.start();
    // Bound ownership from permission grant, including suspended audio or module loading.
    let wallCutoff=()=>{if(token===generation)cancel('Microphone stopped after 20 seconds: audio setup did not finish. Try again.');};
    captureTimeout=setTimeout(()=>wallCutoff(),20000);await resumed;
    if(token!==generation)return;if(![44100,48000].includes(context.sampleRate))throw Error('This input rate is unsupported; use 44.1 or 48 kHz.');captureRate=context.sampleRate;
    await context.audioWorklet.addModule(new URL('./communication-capture.mjs',import.meta.url));if(token!==generation)return;
    captureNode=new AudioWorkletNode(context,'bounded-communication-capture',{processorOptions:{maximum:captureRate*20}});
    const finish=()=>{if(token!==generation||!microphone)return;const samples=new Float32Array(captureFrames);let offset=0;for(const part of captureParts){samples.set(part,offset);offset+=part.length;}
      captured={samples:samples.slice(),rate:captureRate};const rate=captureRate;haltMedia();captureParts=[];captureFrames=0;decode(samples,rate,'microphone capture');};
    captureNode.port.onmessage=({data})=>{if(token!==generation||!microphone)return;
      if(data.samples){captureFrames+=data.samples.length;if(captureFrames>captureRate*20){failure(Error('Capture exceeded its limit.'),token);return;}captureParts.push(data.samples);}
      if(data.done)finish();};
    const input=context.createMediaStreamSource(stream);input.connect(captureNode).connect(context.destination);
    // The wall-clock cutoff closes tracks even if the audio graph stops delivering.
    // At most one unfinished 2048-frame chunk is omitted at that cutoff.
    wallCutoff=finish;
    controls();status('Recording locally for at most 20 seconds. Play the message on the other device, then Stop and decode.');
  }catch(error){failure(error,token);}}
element('prepare').onclick=prepare;element('play-message').onclick=play;element('stop-message').onclick=()=>cancel('Playback stopped.');
element('capture').onclick=startCapture;element('finish-capture').onclick=()=>captureNode?.port.postMessage({finish:true});element('cancel').onclick=()=>cancel();
element('loopback').onclick=()=>{if(prepared)decode(Float32Array.from(prepared.pcm,value=>value/32768),48000,'generated audio (local file test, not an air test)');};
element('save-tl').onclick=()=>prepared&&save(prepared.canonical,'text/plain','message.tl');
element('save-wav').onclick=()=>prepared&&save(pcmWav(prepared.pcm),'audio/wav','message.wav');
element('save-capture').onclick=()=>{if(captured)save(pcmWav(Int16Array.from(captured.samples,value=>Math.max(-32768,Math.min(32767,Math.round(value*32768)))),captured.rate),'audio/wav','capture.wav');};
element('capture-file').onchange=async event=>{const file=event.target.files?.[0];if(!file)return;cancel('Reading selected WAV…');const token=generation;
  try {if(file.size>acousticLimits.fileBytes)throw Error('WAV exceeds the 4 MiB limit.');busy=true;controls();const bytes=await file.arrayBuffer();if(token!==generation)return;const input=readCaptureWav(bytes);captured={samples:input.samples.slice(),rate:input.rate};await decode(input.samples,input.rate,'selected WAV (channel 1)');}
  catch(error){failure(error,token);}finally{event.target.value='';}};
function messageChanged(){cancel('Message changed. Prepare it before playback.');prepared=null;controls();try{element('bytes').textContent=(textPayload(element('message').value).length-1)+' / 127 UTF-8 bytes';}catch(error){element('bytes').textContent=error.message;}}
element('message').oninput=messageChanged;document.addEventListener('visibilitychange',()=>{if(document.hidden)cancel('Paused for privacy: capture/playback stopped while page is hidden.');});
window.addEventListener('pagehide',()=>cancel());messageChanged();
