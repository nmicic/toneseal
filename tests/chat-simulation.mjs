// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Shared-clock half-duplex chat simulation with production timing and actual
// Web Crypto/frame lengths. Acoustic reception is modeled, not physical audio.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ChatTransfer} from '../web/chat-transfer.mjs';
import {getAudioProfile} from '../web/audio-profiles.mjs';
import {encodePayload,preamble} from '../web/communication-codec.mjs';
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
const key=packet=>Buffer.from(packet).toString('hex');
const abort=()=>new DOMException('Stopped','AbortError');
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

async function scenario(config) {
  const clock=new VirtualClock(),links=[],controllers=[],frames=[],messages=[[],[]],deliveries=[[],[]],errors=[],counts=new Map();
  const expected=[[],['Initial encrypted chat']],seenData=new Map(),enqueued=[new Map(),new Map()];
  let initialEpoch=null,burst=false,finishedAt=null,snapshots=null;
  const pause=ms=>new Promise(resolve=>clock.schedule(resolve,ms));
  const burstCount=config.burstCount??3;
  function classify(side,packet) {
    if(packet[2]===1)return 'offer';if(packet[2]===2)return 'answer';
    const epoch=key(packet.subarray(3,11));initialEpoch??=epoch;
    const counter=new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false);
    if(counter<0x80000000)return 'data';
    return epoch!==initialEpoch&&packet.length===51?(side===0?'poll':'response'):'handshake';
  }
  function maybeFinish() {
    if(finishedAt!==null||deliveries[0].length!==burstCount+1||deliveries[1].length!==burstCount)return;
    finishedAt=clock.now;snapshots=controllers.map(peer=>peer.state);
    clock.schedule(()=>controllers.forEach(peer=>peer.stop()),1000);
  }
  clock.install();
  try {
    for(let side=0;side<2;side++)controllers.push(new ChatTransfer({
      timing:{maxRunMs:config.maxRunMs??600000},
      random:()=>.5,
      onMessage:message=>messages[side].push(message.text),
      onDelivery:record=>{
        deliveries[side].push({counter:record.counter,atMs:clock.now,latencyMs:clock.now-(enqueued[side].get(record.counter)??0)});
        if(side===0&&!burst){
          burst=true;
          clock.schedule(()=>{
            for(let device=0;device<2;device++)for(let i=0;i<burstCount;i++){
              const prefix=`${device?'B':'A'} queued ${i}: é 🗝️ `;
              const text=prefix+'x'.repeat(config.maxPayload?96-new TextEncoder().encode(prefix).length:config.payloadPadding??10);
              expected[1-device].push(text);
              controllers[device].enqueue(text).then(({counter})=>enqueued[device].set(counter,clock.now)).catch(error=>errors.push(error.message));
            }
          },0);
        }
        maybeFinish();
      },
      transportFactory:callbacks=>{
        const profile=getAudioProfile(callbacks.profile),seen=new Set();
        const link={running:false,busy:false,playing:false,allowedAfter:0,callbacks,
          async start(){await pause(150);this.running=true;},
          async send(input){
            assert.ok(this.running&&!this.busy&&!this.playing,'one outstanding local playback');this.busy=true;
            const packet=input.slice(),id=key(packet),cached=seen.has(id);
            const preparation=controllers[side].state.connected?config.chatPrepareMs?.[side]??config.prepareMs??180:config.prepareMs??180;
            await pause(cached?0:preparation);if(!this.running)throw abort();seen.add(id);
            const kind=classify(side,packet),countKey=`${side}/${kind}`,ordinal=(counts.get(countKey)||0)+1;counts.set(countKey,ordinal);
            if(kind==='data'){
              const counter=new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false),dataKey=`${side}/${counter}`;
              if(seenData.has(dataKey))assert.equal(id,seenData.get(dataKey),'every repair uses exact retained ciphertext');else seenData.set(dataKey,id);
            }
            const ppm=(config.driftPpm??0)*(side?1:-1);
            const duration=(80+(preamble.length+encodePayload(packet).length)*20)/profile.playbackRate*(1+ppm/1e6);
            const peer=links[1-side],frame={side,kind,ordinal,bytes:packet.length,startMs:clock.now,endMs:clock.now+duration,
              dropped:Boolean(config.drop?.({side,kind,ordinal,atMs:clock.now})),collided:false,
              ready:Boolean(peer?.running&&!peer.playing&&peer.allowedAfter<=clock.now)};
            frames.push(frame);this.playing=true;
            for(const other of frames)if(other!==frame&&other.side!==side&&other.endMs>frame.startMs&&other.startMs<frame.endMs){frame.collided=true;other.collided=true;}
            await pause(duration);if(!this.running)throw abort();
            if(frame.ready&&!frame.collided&&!frame.dropped&&peer?.running){
              clock.schedule(()=>{
                if(peer.running&&!peer.playing&&peer.allowedAfter<=clock.now){
                  const input=config.duplicate?[packet.slice(),packet.slice()]:[packet.slice()];
                  peer.callbacks.onPackets(input);
                }
              },config.decodeMs??45);
            }
            this.allowedAfter=clock.now+350;await pause(350);if(!this.running)throw abort();
            this.playing=false;this.busy=false;
          },stop(){this.running=false;this.busy=false;this.playing=false;}};
        links[side]=link;return link;
      },
    }));
    const options={profile:config.profile??'nearby',cryptoProfile:config.cryptoProfile??'p256'};
    clock.schedule(()=>controllers[1].start(options).catch(error=>errors.push(error.message)),config.receiverDelay??0);
    clock.schedule(()=>controllers[0].start({...options,text:'Initial encrypted chat'}).catch(error=>errors.push(error.message)),0);
    await clock.run(650000);
    assert.deepEqual(errors,[],config.name);
    if(config.expectFailure){
      assert.equal(finishedAt,null,'Over-budget processing cannot falsely complete all admitted messages');
      assert.equal(controllers.every(peer=>!peer.state.active),true);assert.equal(links.every(link=>!link.running),true);
      for(let side=0;side<2;side++)for(const delivered of deliveries[side])assert.ok(messages[1-side].includes(expected[1-side][delivered.counter-1]),'Every reported delivery has matching receiver evidence');
      const result={name:config.name,expectedFailure:true,confirmed:deliveries.flat().length,frames:frames.length,collisions:frames.filter(frame=>frame.collided).length};
      console.log(`PASS ${config.name}: bounded stop, ${result.confirmed} evidenced receipts, ${result.collisions} collided frames after processing exceeds the turn budget.`);
      return result;
    }
    assert.notEqual(finishedAt,null,config.name+' must confirm every admitted message');
    assert.deepEqual(messages,expected,config.name+' byte exact once-only ordered delivery');
    assert.equal(frames.filter(frame=>frame.collided).length,0,config.name+' must not overlap speaking turns');
    assert.equal(controllers.every(peer=>!peer.state.active),true);
    assert.equal(links.every(link=>!link.running),true);
    assert.equal(snapshots.every(state=>state.pendingCount===0),true);
    const result={name:config.name,profile:options.profile,cryptoProfile:options.cryptoProfile,messages:messages.flat().length,
      confirmedAtMs:Math.round(finishedAt),airtimeMs:Math.round(frames.reduce((sum,frame)=>sum+frame.endMs-frame.startMs,0)),
      frames:frames.length,dropped:frames.filter(frame=>frame.dropped).length,collisions:0,
      retries:snapshots.reduce((sum,state)=>sum+state.chatStats.retries,0),maximumDeliveryLatencyMs:Math.round(Math.max(...deliveries.flat().map(item=>item.latencyMs))),
      timeline:frames.map(frame=>({...frame,startMs:Math.round(frame.startMs),endMs:Math.round(frame.endMs)}))};
    console.log(`PASS ${config.name}: ${result.messages} messages, ${result.confirmedAtMs} ms to all receipts, ${result.frames} frames, no collisions.`);
    return result;
  } finally {controllers.forEach(peer=>peer.stop());await clock.flush();clock.restore();}
}
const configs=[
  {name:'nearby-bidirectional'},
  {name:'telephone-compact',profile:'telephone',cryptoProfile:'x25519'},
  {name:'maximum-payload-telephone',profile:'telephone',cryptoProfile:'x25519',maxPayload:true},
  {name:'delayed-receiver',receiverDelay:9000},
  {name:'missing-data-both-directions',drop:({kind,ordinal})=>kind==='data'&&ordinal===2},
  {name:'lost-poll-and-response',drop:({kind,ordinal})=>['poll','response'].includes(kind)&&ordinal===2},
  {name:'duplicate-decode-and-clock-drift',duplicate:true,driftPpm:250,decodeMs:250},
  {name:'slow-rendering',prepareMs:1200,decodeMs:120},
  {name:'two-full-outboxes',burstCount:8,payloadPadding:40},
  {name:'temporary-one-way-outage',drop:({side,atMs})=>side===1&&atMs>40000&&atMs<70000},
  {name:'processing-budget-exceeded',chatPrepareMs:[180,60000],maxRunMs:180000,expectFailure:true},
];
const rows=[];for(const config of configs)rows.push(await scenario(config));
await fs.mkdir('out',{recursive:true});
await fs.writeFile('out/chat-simulation.json',JSON.stringify({scope:'Shared-clock modeled acoustic transport; real session crypto and framing',cases:rows},null,2)+'\n');
