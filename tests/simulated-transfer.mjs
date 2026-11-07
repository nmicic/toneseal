// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Deterministic shared-medium simulation of the real automatic controllers.
// This replaces the microphone/speaker only. Web Crypto, session records,
// controller timers, framing lengths, retransmission, and checksums are real.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {AutoTransfer} from '../web/auto-transfer.mjs';
import {ArtifactTransfer} from '../web/artifact-transfer.mjs';
import {getAudioProfile} from '../web/audio-profiles.mjs';
import {getCryptoProfile} from '../web/crypto-profiles.mjs';
import {encodePayload,preamble} from '../web/communication-codec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MODEL = Object.freeze({sampleRate:48000,framePaddingMs:80,glyphMs:20,
  microphoneSetupMs:150,firstPreparationMs:180,warmPreparationMs:70,
  echoGuardMs:350,decoderDelayMs:45,propagationMs:2});
const encoder = new TextEncoder(), bytes = text => encoder.encode(text);
const fingerprint = packet => Buffer.from(packet).toString('hex');
const round = value => Math.round(value*1000)/1000;
const abort = () => new DOMException('Simulated audio stopped.','AbortError');
const immediate = () => new Promise(resolve=>setImmediate(resolve));
function rng(seed) {
  let state=seed>>>0;
  return () => { state=(state+0x6d2b79f5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296; };
}
function nameSeed(seed,name) { let value=seed>>>0;for(const char of name)value=Math.imul(value^char.charCodeAt(0),16777619)>>>0;return value; }

class VirtualClock {
  constructor() { this.now=0;this.serial=0;this.revision=0;this.timers=new Map();this.cryptoJobs=[];this.cryptoSerial=0;this.steps=0; }
  schedule(callback,delay=0,...args) {
    if(typeof callback!=='function')throw Error('Simulation timers require functions.');
    const id=++this.serial;
    this.timers.set(id,{id,at:this.now+Math.max(0,Number(delay)||0),callback,args});this.revision++;
    return id;
  }
  cancel(id) { if(this.timers.delete(id))this.revision++; }
  cryptoCall(target,property,args) {
    // Real operations finish on Node's native worker pool, but their observable
    // completions are released in deterministic call-order batches. Virtual
    // deadlines never jump ahead while key generation/encryption is pending.
    const id=++this.cryptoSerial;
    let resolve,reject;
    const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const native=Promise.resolve().then(()=>target[property](...args)).then(value=>({value}),error=>({error}));
    this.cryptoJobs.push({id,native,resolve,reject});this.revision++;
    return pending;
  }
  install() {
    this.originalTimeout=globalThis.setTimeout;this.originalClear=globalThis.clearTimeout;
    this.originalCrypto=Object.getOwnPropertyDescriptor(globalThis,'crypto');
    const nativeCrypto=globalThis.crypto,clock=this;
    const subtle=new Proxy(nativeCrypto.subtle,{get(target,property){const value=Reflect.get(target,property,target);return typeof value==='function'?(...args)=>clock.cryptoCall(target,property,args):value;}});
    const cryptoProxy=new Proxy(nativeCrypto,{get(target,property){if(property==='subtle')return subtle;const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
    globalThis.setTimeout=(callback,delay,...args)=>this.schedule(callback,delay,...args);
    globalThis.clearTimeout=id=>this.cancel(id);
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:cryptoProxy});
  }
  restore() {
    globalThis.setTimeout=this.originalTimeout;globalThis.clearTimeout=this.originalClear;
    if(this.originalCrypto)Object.defineProperty(globalThis,'crypto',this.originalCrypto);else delete globalThis.crypto;
  }
  async flush() {
    for(let cycle=0;cycle<1000;cycle++) {
      await immediate();
      if(this.cryptoJobs.length) {
        const batch=this.cryptoJobs.splice(0).sort((a,b)=>a.id-b.id);
        const results=await Promise.all(batch.map(job=>job.native));
        batch.forEach((job,index)=>results[index].error?job.reject(results[index].error):job.resolve(results[index].value));
        continue;
      }
      const revision=this.revision;
      await immediate();
      if(!this.cryptoJobs.length && this.revision===revision)return;
    }
    throw Error('Async work did not become quiescent before advancing virtual time.');
  }
  async run(maximumMs=260000) {
    for(;;) {
      await this.flush();
      if(!this.timers.size)return;
      const next=[...this.timers.values()].sort((a,b)=>a.at-b.at||a.id-b.id)[0];
      if(next.at>maximumMs)throw Error(`Virtual deadline exceeded ${maximumMs} ms with ${this.timers.size} pending timers.`);
      if(++this.steps>30000)throw Error('Simulation timer budget exceeded.');
      this.timers.delete(next.id);this.now=next.at;next.callback(...next.args);
    }
  }
}

class SharedMedium {
  constructor(clock,scenario,seed,event) {
    this.clock=clock;this.scenario=scenario;this.event=event;this.random=rng(seed);
    this.links=[null,null];this.frames=[];this.packetIds=new Map();this.kindCounts=new Map();
    this.generations=[0,0];this.faults=[];
  }
  createLink(side,callbacks) {
    const link=new SimulatedLink(this,side,++this.generations[side],callbacks);
    this.links[side]=link;return link;
  }
  classify(link,packet) {
    if(packet[0]===0xa8)return ['invalid','clear-data','clear-ack','clear-fin'][packet[2]]||'invalid';
    if(packet[0]!==0xa7)return 'unknown';
    if(packet[2]===1)return 'offer';if(packet[2]===2)return 'answer';
    const epoch=fingerprint(packet.subarray(3,11));
    link.initialEpoch??=epoch;
    const counter=new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false);
    if(counter<0x80000000)return 'message';
    const sender=this.controllers[link.side].state.role==='sender';
    if(epoch===link.initialEpoch)return counter===0x80000001?(sender?'sender-ready':'receiver-ready'):(sender?'rekey-offer':'rekey-answer');
    return counter===0x80000001?(sender?'rekey-commit':'rekey-final'):'ack';
  }
  begin(link,packet,preparationMs) {
    const id=fingerprint(packet);if(!this.packetIds.has(id))this.packetIds.set(id,`p${String(this.packetIds.size+1).padStart(3,'0')}`);
    const kind=this.classify(link,packet),key=`${link.side}/${link.generation}/${kind}`;
    const occurrence=(this.kindCounts.get(key)||0)+1;this.kindCounts.set(key,occurrence);
    const duration=(MODEL.framePaddingMs+(preamble.length+encodePayload(packet).length)*MODEL.glyphMs)/link.profile.playbackRate;
    const peer=this.links[1-link.side],start=this.clock.now;
    const frame={id:`f${String(this.frames.length+1).padStart(3,'0')}`,packetId:this.packetIds.get(id),link,side:link.side,kind,occurrence,
      packet:new Uint8Array(packet),start,end:start+duration,actualEnd:null,duration,preparationMs,peer,
      peerReady:Boolean(peer?.running&&!peer.playing&&peer.allowedAfter<=start),active:true,collided:false};
    frame.fault=this.scenario.fault?.({kind,device:link.side===0?'A':'B',occurrence,round:link.generation,
      startMs:start,endMs:frame.end,random:this.random,frameIndex:this.frames.length})||{};
    this.frames.push(frame);link.frame=frame;
    this.event(link.side,'tx-start',{frameId:frame.id,packetId:frame.packetId,kind,packetBytes:packet.length,durationMs:duration,preparationMs,attempt:occurrence,round:link.generation});
    for(const other of this.frames) {
      if(other!==frame&&other.active&&other.side!==frame.side&&other.start<frame.end&&frame.start<other.end) {
        other.collided=true;frame.collided=true;
        this.event('medium','collision',{frameId:frame.id,otherFrameId:other.id,reason:'overlapping playback'});
      }
    }
    this.scenario.onFrame?.(frame,this);
    return frame;
  }
  abort(frame) {
    if(!frame?.active)return;
    frame.active=false;frame.actualEnd=this.clock.now;
    this.event(frame.side,'tx-end',{frameId:frame.id,kind:frame.kind,durationMs:frame.actualEnd-frame.start,aborted:true});
    this.event(1-frame.side,'drop',{frameId:frame.id,kind:frame.kind,reason:'sender stopped during playback'});
  }
  end(frame) {
    frame.active=false;frame.actualEnd=this.clock.now;frame.link.frame=null;
    this.event(frame.side,'tx-end',{frameId:frame.id,kind:frame.kind,durationMs:frame.duration});
    let reason=frame.collided?'overlapping playback':!frame.peerReady?'receiver missed the preamble':
      !frame.peer?.running||this.links[1-frame.side]!==frame.peer?'receiver stopped during playback':
      frame.peer.profile.id!==frame.link.profile.id?'audio profiles do not match':
      frame.fault.drop?(frame.fault.reason||'scripted loss'):null;
    const blackout=(this.scenario.blackouts||[]).find(([start,end])=>frame.start<end&&frame.end>start);
    if(blackout)reason=`audio blackout ${blackout[0]}–${blackout[1]} ms`;
    if(reason) { this.event(1-frame.side,'drop',{frameId:frame.id,kind:frame.kind,reason});return; }
    this.clock.schedule(()=>{
      const peer=frame.peer;
      if(!peer.running||this.links[1-frame.side]!==peer||peer.playing||peer.allowedAfter>this.clock.now) {
        this.event(1-frame.side,'drop',{frameId:frame.id,kind:frame.kind,reason:'decoder result arrived while receiver unavailable'});return;
      }
      const received=new Uint8Array(frame.packet);
      if(frame.fault.corrupt) { received[received.length-1]^=1;this.event('medium','action',{frameId:frame.id,kind:frame.kind,reason:'crafted packet mutation; protocol integrity must reject it'}); }
      const copies=frame.fault.duplicate?2:1;
      this.event(1-frame.side,'rx',{frameId:frame.id,packetId:frame.packetId,kind:frame.kind,packetBytes:received.length,peer:frame.side===0?'A':'B',duplicate:copies>1,copies});
      Promise.resolve(peer.callbacks.onPackets(Array.from({length:copies},()=>received.slice()))).catch(error=>this.errors.push(error));
    },MODEL.decoderDelayMs+MODEL.propagationMs);
  }
}

class SimulatedLink {
  constructor(medium,side,generation,callbacks) {
    this.medium=medium;this.clock=medium.clock;this.side=side;this.generation=generation;this.callbacks=callbacks;
    this.profile=getAudioProfile(callbacks.profile);
    this.running=false;this.busy=false;this.playing=false;this.allowedAfter=0;this.waiters=new Map();this.cache=new Map();this.warmed=false;
  }
  delay(ms) {
    if(!ms)return Promise.resolve();
    return new Promise((resolve,reject)=>{const id=this.clock.schedule(()=>{this.waiters.delete(id);resolve();},ms);this.waiters.set(id,reject);});
  }
  async start() {
    this.busy=true;this.medium.event(this.side,'capture-opening',{round:this.generation});
    await this.delay(MODEL.microphoneSetupMs);this.running=true;this.busy=false;
    this.medium.event(this.side,'capture-ready',{round:this.generation});this.callbacks.onStatus('Listening automatically.');
  }
  async send(input) {
    assert.ok(this.running&&!this.busy&&!this.playing,'controller must serialize playback');
    const packet=new Uint8Array(input),id=fingerprint(packet);this.busy=true;
    const preparationMs=this.cache.has(id)?0:this.warmed?MODEL.warmPreparationMs:MODEL.firstPreparationMs;
    this.callbacks.onStatus('Preparing automatic reply…');await this.delay(preparationMs);
    if(!this.running)throw abort();
    this.warmed=true;this.cache.set(id,true);while(this.cache.size>4)this.cache.delete(this.cache.keys().next().value);
    this.playing=true;const frame=this.medium.begin(this,packet,preparationMs);
    this.callbacks.onStatus('Sending automatically…');
    await this.delay(frame.duration);if(!this.running)throw abort();
    this.medium.end(frame);this.allowedAfter=this.clock.now+MODEL.echoGuardMs;
    await this.delay(MODEL.echoGuardMs);if(!this.running)throw abort();
    this.playing=false;this.busy=false;this.callbacks.onStatus('Listening automatically…');
  }
  stop() {
    const hadMedia=this.running||this.busy||this.playing;
    this.running=false;this.busy=false;this.playing=false;
    this.medium.abort(this.frame);this.frame=null;
    for(const [id,reject] of this.waiters){this.clock.cancel(id);reject(abort());}this.waiters.clear();this.cache.clear();
    if(hadMedia)this.medium.event(this.side,'stop',{round:this.generation});
  }
}

function occupiedAir(frames) {
  const intervals=frames.map(frame=>[frame.start,frame.actualEnd??frame.start]).filter(([start,end])=>end>start).sort((a,b)=>a[0]-b[0]);
  let total=0,start=0,end=0;
  for(const [a,b] of intervals){if(a>end){total+=end-start;start=a;end=b;}else end=Math.max(end,b);}return total+end-start;
}

async function runScenario(scenario,baseSeed) {
  const clock=new VirtualClock(),seed=nameSeed(baseSeed,scenario.name),timeline=[],messages=[[],[]],states=[[],[]],errors=[],assertions=[];
  const event=(side,event,fields={})=>timeline.push({atMs:round(clock.now),sequence:timeline.length+1,device:side===0?'A':side===1?'B':side,event,...fields});
  const medium=new SharedMedium(clock,scenario,seed^0xa511e9b3,event);medium.errors=errors;
  const previousState=['',''],confirmationScheduled=[false,false],controllerRandom=[rng(seed^0x12345678),rng(seed^0x87654321)];
  const configs=[{mode:scenario.mode||'message',text:scenario.text||'Byte-exact é 🌊 العربية 日本語',verifyPeer:Boolean(scenario.verify),profile:scenario.profile||'nearby',cryptoProfile:scenario.cryptoProfile||'p256'},
    {mode:scenario.receiverMode||scenario.mode||'message',text:scenario.bothSenders?'Second sender has a message':'',verifyPeer:Boolean(scenario.verify),profile:scenario.receiverProfile||scenario.profile||'nearby',cryptoProfile:scenario.receiverCryptoProfile||scenario.cryptoProfile||'p256'}];
  if(scenario.bothReceivers)configs[0].text='';
  const Controller=scenario.artifact?ArtifactTransfer:AutoTransfer;
  const controllers=[0,1].map(side=>new Controller({random:scenario.synchronizedJitter?()=>0.5:controllerRandom[side],
    transportFactory:callbacks=>medium.createLink(side,callbacks),
    onChange(state) {
      states[side].push({at:clock.now,...state});
      const summary=JSON.stringify([state.phase,state.active,state.role,state.attempt,state.status]);
      if(previousState[side]!==summary){previousState[side]=summary;event(side,'state',{phase:state.phase,active:state.active,role:state.role,attempt:state.attempt,status:state.status});}
      if(scenario.verify&&!scenario.neverConfirm&&state.phase==='verify'&&!confirmationScheduled[side]) {
        confirmationScheduled[side]=true;
        clock.schedule(()=>{event(side,'confirm');Promise.resolve(controllers[side].confirm()).catch(error=>errors.push(error));},side===0?1200:5000);
      }
    },
    onMessage(message) {
      if(scenario.artifact){
        assert.equal(message.kind,scenario.artifact);
        message={...message,type:configs[0].mode,text:new TextDecoder('utf-8',{fatal:true}).decode(message.bytes)};
      }
      messages[side].push({at:clock.now,...message});event(side,'message',{type:message.type,byteLength:bytes(message.text).length});
      if(scenario.stopReceiverAfterMessage)clock.schedule(()=>{event(side,'action',{reason:'user stops receiver before sending ACK'});controllers[side].stop();},1);
    },
  }));
  medium.controllers=controllers;
  const starts=scenario.starts||[0,0],startTimes=[[],[]];
  const start=(side,config=configs[side])=>{
    event(side,'start',{mode:config.mode,profile:config.profile,cryptoProfile:config.cryptoProfile,role:config.text?'sender':'receiver',inputBytes:bytes(config.text).length});startTimes[side].push(clock.now);
    const startConfig=scenario.artifact?{...config,kind:scenario.artifact,bytes:config.text?bytes(config.text):null}:config;
    Promise.resolve(controllers[side].start(startConfig)).catch(error=>errors.push(error));
  };
  const check=(condition,name)=>assertions.push({name,passed:Boolean(condition)});
  let executionError=null,result;
  clock.install();
  try {
    starts.forEach((at,side)=>clock.schedule(()=>start(side),at));
    if(scenario.stopAtMs!==undefined)clock.schedule(()=>{event('medium','action',{reason:'user stops both devices'});controllers.forEach(controller=>controller.stop());},scenario.stopAtMs);
    if(scenario.restartAtMs!==undefined)clock.schedule(()=>{
      event('medium','action',{reason:'user corrects two senders: Stop both, empty device B, then Start both'});
      controllers.forEach(controller=>controller.stop());configs[1].text='';start(1);start(0);
    },scenario.restartAtMs);
    await clock.run(scenario.maximumMs||260000);
    await clock.flush();
  } catch(error) { executionError=error; }
  try {
    check(!executionError,executionError?`Simulation completed: ${executionError.message}`:'Simulation completed within its virtual time budget');
    check(errors.length===0,errors.length?`No asynchronous errors: ${errors.map(error=>error.message).join('; ')}`:'No asynchronous errors');
    check(controllers.every(controller=>!controller.state.active)&&medium.links.every(link=>!link?.running),'Both devices release microphone/playback by the end');
    check(messages.every(list=>list.length<=1),'No application message is displayed twice');
    for(let side=0;side<2;side++)for(const state of states[side].filter(state=>state.phase==='delivered'))
      check(messages[1-side].some(message=>message.at<=state.at&&Buffer.from(bytes(message.text)).equals(Buffer.from(bytes(configs[side].text)))),'Every delivery confirmation follows receipt of the exact bytes on the other device');
    const exact=messages.flat().every(message=>Buffer.from(bytes(message.text)).equals(Buffer.from(bytes(configs[0].text))))&&messages[1].every(message=>message.type===configs[0].mode);
    if(messages.flat().length)check(exact,'Received application bytes and channel exactly match the source');
    const expected=scenario.expected||'delivered';
    if(expected==='delivered') {
      check(controllers[0].state.phase==='delivered',`Sender finishes delivered (actual ${controllers[0].state.phase})`);
      check(messages[1].length===1&&messages[0].length===0,'Only device B receives exactly one message');
      check(exact,'Successful transfer is byte exact');
    } else if(expected==='received-unconfirmed') {
      check(controllers[0].state.phase!=='delivered','Sender never claims delivery without its receipt');
      check(messages[1].length===1&&messages[0].length===0,'Receiver retains exactly one message despite lost receipt');
    } else {
      check(!states.flat().some(state=>state.phase==='delivered'),'No false delivery confirmation');
      check(messages.flat().length===0,'No unintended application delivery');
    }
    if(scenario.mustHaveCollision)check(timeline.some(row=>row.event==='collision'),'Shared medium detects simultaneous playback');
    if(scenario.mustHaveDiagnostic)check(states.flat().some(state=>/Both devices are sending/.test(state.status)),'A decoded competing sender produces a role diagnostic');
    if(scenario.fault&&!scenario.seededFault)check(medium.frames.some(frame=>frame.fault.drop||frame.fault.corrupt||frame.fault.duplicate),'The requested packet fault was actually exercised');
    if(scenario.blackouts)check(timeline.some(row=>row.event==='drop'&&row.reason.startsWith('audio blackout')),'The finite blackout overlaps an actual transmission');
    if(scenario.bothReceivers||scenario.stopAtMs===50)check(medium.frames.length===0,'No playback starts without sender input or after setup was cancelled');
    if(scenario.verify&&!scenario.neverConfirm) {
      const confirmations=timeline.filter(row=>row.event==='confirm');
      check(confirmations.length===2&&messages[1][0]?.at>=Math.max(...confirmations.map(row=>row.atMs)),'Verified mode waits for both human confirmations before delivery');
    }
    if(scenario.noFault) {
      check(!timeline.some(row=>row.event==='drop'||row.event==='collision'),'Healthy medium loses no frame');
      const expectedFrames=scenario.artifact?12+2*Math.ceil(bytes(configs[0].text).length/48):configs[0].mode==='clear'?3:10;
      check(medium.frames.length===expectedFrames,'Healthy exchange sends each protocol flight once');
    }
    const senderDelivery=states[0].find(state=>state.phase==='delivered')?.at??null,receiverDelivery=messages[1][0]?.at??null;
    const airtime=medium.frames.reduce((sum,frame)=>sum+(frame.actualEnd??frame.start)-frame.start,0);
    const transmitted=new Set();let repeatCount=0;
    for(const frame of medium.frames){const id=`${frame.side}/${frame.packetId}`;if(transmitted.has(id))repeatCount++;else transmitted.add(id);}
    const transferStart=startTimes[0].at(-1)??0,latency=senderDelivery===null?null:senderDelivery-transferStart;
    if(scenario.maximumDeliveryMs!==undefined)check(latency!==null&&latency<=scenario.maximumDeliveryMs,`Delivery within the ${scenario.maximumDeliveryMs} ms modeled budget`);
    result={name:scenario.name,mode:configs[0].mode,artifact:scenario.artifact||null,profile:configs[0].profile,receiverProfile:configs[1].profile,cryptoProfile:configs[0].cryptoProfile,receiverCryptoProfile:configs[1].cryptoProfile,seed,expected,passed:assertions.every(item=>item.passed),assertions,
      ...(executionError?{error:executionError.stack}:{}),
      metrics:{elapsedMs:round(clock.now),deliveryMs:senderDelivery===null?null:round(senderDelivery),receiverMs:receiverDelivery===null?null:round(receiverDelivery),
        transferLatencyMs:latency===null?null:round(latency),airtimeMs:round(airtime),occupiedAirMs:round(occupiedAir(medium.frames)),
        retryCount:repeatCount,frameCount:medium.frames.length,dropCount:timeline.filter(row=>row.event==='drop').length,collisionCount:timeline.filter(row=>row.event==='collision').length,
        deliveredBytes:messages[1].reduce((sum,message)=>sum+bytes(message.text).length,0),byteExact:messages.flat().length?exact:null,
        goodputBytesPerSecond:latency>0?round(bytes(configs[0].text).length/(latency/1000)):null},
      devices:controllers.map((controller,side)=>({id:side===0?'A':'B',role:controller.state.role,finalPhase:controller.state.phase,active:controller.state.active,
        receivedCount:messages[side].length,airtimeMs:round(medium.frames.filter(frame=>frame.side===side).reduce((sum,frame)=>sum+(frame.actualEnd??frame.start)-frame.start,0))})),
      timeline:timeline.slice()};
  } finally {
    // Restore process globals even after a failed assertion or a bounded run.
    controllers.forEach(controller=>controller.stop());
    try { await clock.flush(); } finally { clock.timers.clear();clock.restore(); }
  }
  return result;
}

const dropFirst=kind=>({kind:actual,occurrence})=>({drop:actual===kind&&occurrence===1,reason:`first ${kind} lost`});
const encryptedFlights=['offer','answer','sender-ready','receiver-ready','rekey-offer','rekey-answer','rekey-commit','rekey-final','message','ack'];
function scenarios() {
  const list=[
    {name:'message / healthy Unicode',mode:'message',noFault:true,maximumDeliveryMs:45000},
    {name:'message / maximum 96 bytes',mode:'message',text:'é'.repeat(48),noFault:true,maximumDeliveryMs:45000},
    {name:'password / healthy Unicode',mode:'password',text:'Dummy-Only_42! 🗝️',noFault:true,maximumDeliveryMs:45000},
    {name:'password / maximum 96 bytes',mode:'password',text:'P'.repeat(96),noFault:true,maximumDeliveryMs:45000},
    {name:'clear / healthy Unicode',mode:'clear',text:'Simulated clock: 12:34:56. é 🔊',noFault:true,maximumDeliveryMs:15000},
    {name:'clear / maximum 96 bytes',mode:'clear',text:'é'.repeat(48),noFault:true,maximumDeliveryMs:15000},
    {name:'message / receiver starts 5 seconds late',starts:[0,5000],maximumDeliveryMs:65000},
    {name:'clear / receiver starts 18 seconds late',mode:'clear',starts:[0,18000],maximumDeliveryMs:50000},
    {name:'password / sender starts 5 seconds late',mode:'password',starts:[5000,0],maximumDeliveryMs:45000},
    {name:'message / verified with human delay',verify:true,maximumDeliveryMs:55000},
    ...encryptedFlights.map(kind=>({name:`message / first ${kind} lost`,fault:dropFirst(kind),maximumDeliveryMs:75000})),
    ...['clear-data','clear-ack'].map(kind=>({name:`clear / first ${kind} lost`,mode:'clear',fault:dropFirst(kind),maximumDeliveryMs:40000})),
    {name:'message / three successive ACK losses',fault:({kind,occurrence})=>({drop:kind==='ack'&&occurrence<=3}),maximumDeliveryMs:100000},
    {name:'clear / three successive ACK losses',mode:'clear',fault:({kind,occurrence})=>({drop:kind==='clear-ack'&&occurrence<=3}),maximumDeliveryMs:65000},
    {name:'clear / FIN lost',mode:'clear',fault:({kind})=>({drop:kind==='clear-fin'}),maximumDeliveryMs:15000},
    {name:'message / duplicate decoded packets',fault:()=>({duplicate:true})},
    {name:'clear / duplicate decoded packets',mode:'clear',fault:()=>({duplicate:true})},
    {name:'message / finite room blackout',blackouts:[[7000,24000]],maximumDeliveryMs:100000},
    {name:'clear / finite room blackout',mode:'clear',blackouts:[[0,22000]],maximumDeliveryMs:65000},
    {name:'message / crafted payload corruption',fault:({kind,occurrence})=>({corrupt:kind==='message'&&occurrence===1}),maximumDeliveryMs:75000},
    {name:'clear / crafted payload corruption',mode:'clear',fault:({kind,occurrence})=>({corrupt:kind==='clear-data'&&occurrence===1}),maximumDeliveryMs:40000},
    ...[0,1,2].map(index=>({name:`message / seeded intermittent loss ${index+1}`,seededFault:true,fault:({random})=>({drop:random()<0.12,duplicate:random()<0.1})})),
    {name:'message / every ACK lost',expected:'received-unconfirmed',fault:({kind})=>({drop:kind==='ack'})},
    {name:'clear / every ACK lost',mode:'clear',expected:'received-unconfirmed',fault:({kind})=>({drop:kind==='clear-ack'})},
    {name:'message / permanent room blackout',expected:'bounded-failure',fault:()=>({drop:true})},
    {name:'message / both senders synchronized',bothSenders:true,synchronizedJitter:true,expected:'bounded-failure',mustHaveCollision:true},
    {name:'clear / both senders synchronized',mode:'clear',bothSenders:true,synchronizedJitter:true,expected:'bounded-failure',mustHaveCollision:true},
    {name:'message / competing sender can be heard',bothSenders:true,starts:[0,5000],expected:'bounded-failure',mustHaveDiagnostic:true},
    {name:'clear / competing sender can be heard',mode:'clear',bothSenders:true,starts:[0,7000],expected:'bounded-failure',mustHaveDiagnostic:true},
    {name:'message / correct two senders and retry',bothSenders:true,synchronizedJitter:true,restartAtMs:30000,mustHaveCollision:true,maximumDeliveryMs:45000},
    {name:'message / receiver selected clear mode',receiverMode:'clear',expected:'bounded-failure'},
    {name:'clear / receiver selected encrypted mode',mode:'clear',receiverMode:'message',expected:'bounded-failure'},
    {name:'message / both inputs empty',bothReceivers:true,expected:'bounded-failure'},
    {name:'message / verification never confirmed',verify:true,neverConfirm:true,expected:'bounded-failure'},
    {name:'message / Stop during audio setup',stopAtMs:50,expected:'bounded-failure'},
    {name:'message / Stop during application playback',expected:'bounded-failure',onFrame(frame,medium){if(frame.kind==='message')medium.clock.schedule(()=>{medium.event('medium','action',{reason:'user stops both devices during DATA'});medium.controllers.forEach(controller=>controller.stop());},frame.duration/2);}},
    {name:'clear / Stop during application playback',mode:'clear',expected:'bounded-failure',onFrame(frame,medium){if(frame.kind==='clear-data')medium.clock.schedule(()=>{medium.event('medium','action',{reason:'user stops both devices during DATA'});medium.controllers.forEach(controller=>controller.stop());},frame.duration/2);}},
    {name:'message / receiver stops before ACK',stopReceiverAfterMessage:true,expected:'received-unconfirmed'},
    {name:'clear / receiver stops before ACK',mode:'clear',stopReceiverAfterMessage:true,expected:'received-unconfirmed'},
    ...['message','password','clear'].map(mode=>({name:`telephone / ${mode} maximum 96 bytes`,profile:'telephone',mode,text:'é'.repeat(48),noFault:true,maximumDeliveryMs:mode==='clear'?18000:55000})),
    {name:'telephone / receiver starts 5 seconds late',profile:'telephone',starts:[0,5000],maximumDeliveryMs:85000},
    {name:'telephone / verified with human delay',profile:'telephone',verify:true,maximumDeliveryMs:65000},
    ...['rekey-offer','rekey-final','ack'].map(kind=>({name:`telephone / first ${kind} lost`,profile:'telephone',fault:dropFirst(kind),maximumDeliveryMs:95000})),
    {name:'telephone / duplicate decoded packets',profile:'telephone',fault:()=>({duplicate:true}),maximumDeliveryMs:55000},
    {name:'telephone / finite call blackout',profile:'telephone',blackouts:[[8000,25000]],maximumDeliveryMs:110000},
    {name:'telephone / both senders synchronized',profile:'telephone',bothSenders:true,synchronizedJitter:true,expected:'bounded-failure',mustHaveCollision:true},
    {name:'telephone / receiver chose nearby',profile:'telephone',receiverProfile:'nearby',expected:'bounded-failure'},
    {name:'nearby / receiver chose telephone',receiverProfile:'telephone',expected:'bounded-failure'},
    ...['nearby','telephone'].flatMap(profile=>[
      {name:`compact ${profile} / maximum encrypted message`,cryptoProfile:'x25519',profile,text:'é'.repeat(48),noFault:true,maximumDeliveryMs:profile==='nearby'?30000:38000},
      {name:`compact ${profile} / verified password`,cryptoProfile:'x25519',profile,mode:'password',text:'Dummy-short-secret_42',verify:true,maximumDeliveryMs:50000},
    ]),
    ...encryptedFlights.map(kind=>({name:`compact / first ${kind} lost`,cryptoProfile:'x25519',fault:dropFirst(kind),maximumDeliveryMs:75000})),
    {name:'compact telephone / duplicate decoded packets',cryptoProfile:'x25519',profile:'telephone',fault:()=>({duplicate:true}),maximumDeliveryMs:50000},
    {name:'compact / receiver starts 5 seconds late',cryptoProfile:'x25519',starts:[0,5000],maximumDeliveryMs:65000},
    {name:'compact / both senders synchronized',cryptoProfile:'x25519',bothSenders:true,synchronizedJitter:true,expected:'bounded-failure',mustHaveCollision:true},
    {name:'compact / receiver chose P-256',cryptoProfile:'x25519',receiverCryptoProfile:'p256',expected:'bounded-failure'},
    {name:'P-256 / receiver chose compact',receiverCryptoProfile:'x25519',expected:'bounded-failure'},
    {name:'showcase / 358-byte enrollment nearby',artifact:'enrollment',cryptoProfile:'x25519',text:'e'.repeat(358),verify:true,noFault:true,maximumMs:700000,maximumDeliveryMs:130000},
    {name:'showcase / 612-byte approval telephone',artifact:'approval',cryptoProfile:'x25519',profile:'telephone',text:'a'.repeat(612),verify:true,noFault:true,maximumMs:700000,maximumDeliveryMs:210000},
    {name:'showcase / first fragment receipt lost',artifact:'enrollment',cryptoProfile:'x25519',text:'e'.repeat(358),verify:true,fault:({kind,device,occurrence})=>({drop:kind==='ack'&&device==='B'&&occurrence===1}),maximumMs:700000,maximumDeliveryMs:160000},
    {name:'showcase / completion record lost',artifact:'approval',cryptoProfile:'x25519',text:'a'.repeat(612),verify:true,fault:({kind,device,occurrence})=>({drop:kind==='message'&&device==='B'&&occurrence===1}),maximumMs:700000,maximumDeliveryMs:180000},
    {name:'showcase / final completion ACK lost',artifact:'enrollment',cryptoProfile:'x25519',text:'e'.repeat(358),verify:true,fault:({kind,device,occurrence})=>({drop:kind==='ack'&&device==='A'&&occurrence===1}),maximumMs:700000,maximumDeliveryMs:130000},
  ];
  return list;
}

const args=process.argv.slice(2);let seed=0x6a09e667,output=path.join(root,'out/simulated-transfer.json'),filter='';
while(args.length) {
  const option=args.shift(),value=args.shift();
  if(option==='--seed'&&value!==undefined) { seed=Number(value);if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw Error('--seed requires a uint32.'); }
  else if(option==='--output'&&value)output=path.resolve(value);
  else if(option==='--scenario'&&value)filter=value;
  else throw Error('Usage: node tests/simulated-transfer.mjs [--seed UINT32] [--output FILE] [--scenario SUBSTRING]');
}
const started=performance.now(),selected=scenarios().filter(scenario=>scenario.name.includes(filter));
if(!selected.length)throw Error('No scenario matches the requested filter.');
const report={schemaVersion:1,seed,model:{...MODEL,
  timingSource:'Real production AutoTransfer defaults and profile retry scaling; packet airtime from real communication-codec framing divided by profile playback rate.',
  profiles:['nearby','telephone'].map(getAudioProfile),
  cryptoProfiles:['p256','x25519'].map(getCryptoProfile),
  retryCountDefinition:'Repeated byte-identical frames from the same device; new fragments and fresh cumulative ACK records are not retransmissions.',
  limitations:'Deterministic protocol/half-duplex model, not a physical acoustic benchmark. Preparation and decoder delays are explicit assumptions. Web Crypto is real but computation consumes zero modeled time. PCM/noise and physical devices require separate tests.'},summary:{},scenarios:[]};
for(const scenario of selected) {
  const result=await runScenario(scenario,seed);report.scenarios.push(result);
  console.log(`${result.passed?'PASS':'FAIL'} ${scenario.name}: ${result.metrics.transferLatencyMs??'—'} ms to confirmation, ${result.metrics.frameCount} frames, ${result.metrics.retryCount} repeated flights`);
  for(const failure of result.assertions.filter(item=>!item.passed))console.error(`  ${failure.name}`);
}
// Re-run the baseline and a seeded-loss scenario using fresh genuine keys.
// Keys never appear in the report, so identical timing/decisions demonstrate
// scheduling stability even through stochastic loss and retransmission.
const repeatScenarios=[...new Set([selected[0],selected.find(scenario=>scenario.seededFault)].filter(Boolean))],repeatChecks=[];
for(const scenario of repeatScenarios) {
  const repeated=await runScenario(scenario,seed),first=report.scenarios.find(result=>result.name===scenario.name);
  repeatChecks.push({name:scenario.name,passed:JSON.stringify({timeline:first.timeline,metrics:first.metrics})===JSON.stringify({timeline:repeated.timeline,metrics:repeated.metrics})});
}
const deterministic=repeatChecks.every(check=>check.passed);
report.summary={scenarios:report.scenarios.length,passed:report.scenarios.filter(scenario=>scenario.passed).length,
  failed:report.scenarios.filter(scenario=>!scenario.passed).length,deterministicRepeatCheck:deterministic,deterministicRepeatScenarios:repeatChecks,
  virtualDurationMs:round(report.scenarios.reduce((sum,scenario)=>sum+scenario.metrics.elapsedMs,0)),wallDurationMs:round(performance.now()-started)};
await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(`Report: ${output}`);console.log(JSON.stringify(report.summary));
if(report.summary.failed||!deterministic)process.exitCode=1;
