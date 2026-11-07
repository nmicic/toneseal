// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Real session crypto and production timers over one shared half-duplex clock.
// The channel models encoded waveform airtime, preparation, echo guards and
// loss; it does not synthesize PCM, open microphones or model a physical room.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ChatTransfer} from '../web/chat-transfer.mjs';
import {getAudioProfile} from '../web/audio-profiles.mjs';
import {encodePayload,preamble} from '../web/communication-codec.mjs';

const immediate=()=>new Promise(resolve=>setImmediate(resolve));
const key=packet=>Buffer.from(packet).toString('hex');
const abort=()=>new DOMException('Stopped','AbortError');
class VirtualClock {
  constructor(){this.now=0;this.serial=0;this.revision=0;this.timers=new Map();this.cryptoJobs=[];this.cryptoSerial=0;this.steps=0;}
  schedule(callback,delay=0,...args){
    if(typeof callback!=='function')throw Error('Simulation timers require functions.');
    const id=++this.serial;this.timers.set(id,{id,at:this.now+Math.max(0,Number(delay)||0),callback,args});this.revision++;return id;
  }
  cancel(id){if(this.timers.delete(id))this.revision++;}
  cryptoCall(target,property,args){
    const id=++this.cryptoSerial;let resolve,reject;
    const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const native=Promise.resolve().then(()=>target[property](...args)).then(value=>({value}),error=>({error}));
    this.cryptoJobs.push({id,native,resolve,reject});this.revision++;return pending;
  }
  install(){
    this.originalTimeout=globalThis.setTimeout;this.originalClear=globalThis.clearTimeout;
    this.originalCrypto=Object.getOwnPropertyDescriptor(globalThis,'crypto');
    this.originalPerformance=Object.getOwnPropertyDescriptor(globalThis,'performance');this.originalDateNow=Date.now;
    const nativeCrypto=globalThis.crypto,nativePerformance=globalThis.performance,clock=this;
    const subtle=new Proxy(nativeCrypto.subtle,{get(target,property){const value=Reflect.get(target,property,target);return typeof value==='function'?(...args)=>clock.cryptoCall(target,property,args):value;}});
    const cryptoProxy=new Proxy(nativeCrypto,{get(target,property){if(property==='subtle')return subtle;const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
    const performanceProxy=new Proxy(nativePerformance,{get(target,property){if(property==='now')return()=>clock.now;const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
    globalThis.setTimeout=(callback,delay,...args)=>this.schedule(callback,delay,...args);globalThis.clearTimeout=id=>this.cancel(id);
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:cryptoProxy});
    Object.defineProperty(globalThis,'performance',{configurable:true,value:performanceProxy});Date.now=()=>clock.now;
  }
  restore(){
    globalThis.setTimeout=this.originalTimeout;globalThis.clearTimeout=this.originalClear;Date.now=this.originalDateNow;
    if(this.originalCrypto)Object.defineProperty(globalThis,'crypto',this.originalCrypto);else delete globalThis.crypto;
    if(this.originalPerformance)Object.defineProperty(globalThis,'performance',this.originalPerformance);else delete globalThis.performance;
  }
  async flush(){
    for(let cycle=0;cycle<1000;cycle++){
      await immediate();
      if(this.cryptoJobs.length){const batch=this.cryptoJobs.splice(0).sort((a,b)=>a.id-b.id),results=await Promise.all(batch.map(job=>job.native));batch.forEach((job,index)=>results[index].error?job.reject(results[index].error):job.resolve(results[index].value));continue;}
      const revision=this.revision;await immediate();if(!this.cryptoJobs.length&&this.revision===revision)return;
    }
    throw Error('Async work did not become quiescent before advancing virtual time.');
  }
  async run(maximumMs=650000){
    for(;;){
      await this.flush();if(!this.timers.size)return;
      const next=[...this.timers.values()].sort((a,b)=>a.at-b.at||a.id-b.id)[0];
      if(next.at>maximumMs)throw Error(`Virtual deadline exceeded ${maximumMs}ms with ${this.timers.size} timers.`);
      if(++this.steps>40000)throw Error('Simulation timer budget exceeded.');
      this.timers.delete(next.id);this.now=next.at;next.callback(...next.args);
    }
  }
}

async function scenario(config){
  const clock=new VirtualClock(),links=[],controllers=[],frames=[],messages=[[],[]],deliveries=[[],[]],errors=[],states=[[],[]];
  const expected=[[],['Initial encrypted chat']],admitted=[new Map([[1,'Initial encrypted chat']]),new Map()],turns=new Map(),counts=new Map(),retries=new Map();
  const closedAt=[null,null],requestAt=[null,null],lastState=[null,null];
  const pause=ms=>new Promise(resolve=>clock.schedule(resolve,ms));
  const maxRunMs=config.maxRunMs??600000;
  let launched=false,closingAt=null,forceDone=false,firstClosePacketAt=null;
  class ObservedChat extends ChatTransfer {
    _createSession(profile){
      const session=super._createSession(profile),original=session.turn.bind(session),send=session.send.bind(session);
      session.turn=async options=>{const packet=await original(options);turns.set(key(packet),{...options,close:options.close??'open'});return packet;};
      session.send=async(...args)=>{if(launched&&config.reservationDelayMs)await pause(config.reservationDelayMs);return send(...args);};
      return session;
    }
  }
  function invokeClose(side){
    requestAt[side]??=clock.now;closingAt??=clock.now;
    Promise.resolve(controllers[side].close()).catch(error=>errors.push(error.message));
    assert.equal(controllers[side].state.canSend,false,'Close freezes new admissions synchronously');
    controllers[side].enqueue('Must not be admitted after close').then(()=>errors.push('Close accepted a new message'),()=>{});
  }
  function beginClose(){
    for(const side of config.closeSides??[0])invokeClose(side);
    if(config.forceOtherAfterMs!==undefined)clock.schedule(()=>{const side=1-(config.closeSides??[0])[0];controllers[side].stop();},config.forceOtherAfterMs);
  }
  function beginWork(){
    if(launched)return;launched=true;
    clock.schedule(()=>{
      const pending=[];
      for(let side=0;side<2;side++)for(let index=0;index<(config.burstCount??0);index++){
        const prefix=`${side?'B':'A'} pending ${index}: é 🗝️ `;
        const text=prefix+'x'.repeat(config.fullPayload?96-new TextEncoder().encode(prefix).length:12);
        expected[1-side].push(text);
        pending.push(controllers[side].enqueue(text).then(({counter})=>admitted[side].set(counter,text)));
      }
      Promise.all(pending).catch(error=>errors.push(error.message));
      // Calling close immediately is intentional: asynchronous crypto reservations
      // must finish and drain, even before enqueue promises resolve.
      if(config.closeAtMs!==undefined)clock.schedule(beginClose,Math.max(0,config.closeAtMs-clock.now));
      else beginClose();
    },0);
  }
  function frameKind(side,packet){
    const turn=turns.get(key(packet));
    if(turn)return {kind:turn.reply?'response':'poll',close:turn.close,number:turn.number,pending:Boolean(turn.pending)};
    if(packet[2]===1)return {kind:'offer'};if(packet[2]===2)return {kind:'answer'};
    const counter=new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false);
    return {kind:counter<0x80000000?'data':'handshake',counter};
  }
  clock.install();
  try{
    for(let side=0;side<2;side++)controllers.push(new ObservedChat({
      timing:{maxRunMs,...config.timing},random:()=>.5,
      onChange:state=>{
        if(state.closing)assert.equal(state.canSend,false,'Every closing state rejects new application admissions');
        const signature=JSON.stringify([state.active,state.phase,state.close?.stage,state.close?.outcome]);
        if(signature!==lastState[side]){lastState[side]=signature;states[side].push({atMs:clock.now,active:state.active,phase:state.phase,close:{...state.close}});}
        if(launched&&!state.active)closedAt[side]??=clock.now;
      },
      onMessage:message=>messages[side].push({counter:message.counter,text:message.text,atMs:clock.now}),
      onDelivery:record=>{
        deliveries[side].push({counter:record.counter,atMs:clock.now});
        if(side===0&&record.counter===1)beginWork();
      },
      transportFactory:callbacks=>{
        const audio=getAudioProfile(callbacks.profile),seen=new Set();
        const link={running:false,busy:false,playing:false,allowedAfter:0,currentFrame:null,callbacks,
          async start(){await pause(150);this.running=true;},
          async send(input){
            assert.ok(this.running&&!this.busy&&!this.playing,'One outstanding playback per device');this.busy=true;
            const packet=input.slice(),id=key(packet),cached=seen.has(id);
            await pause(cached?0:config.prepareMs??180);if(!this.running)throw abort();seen.add(id);
            const detail=frameKind(side,packet),countKey=`${side}/${detail.kind}/${detail.close??''}`,ordinal=(counts.get(countKey)||0)+1;counts.set(countKey,ordinal);
            if(['commit','ack','final'].includes(detail.close)){
              assert.equal(detail.pending,false,'Final close controls advertise no pending DATA');
              assert.ok(controllers.every(controller=>controller.state.pendingCount===0),'Both application outboxes drain before commit/ack/final');
            }
            const sequence=new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false);
            if(packet[2]===3){const identity=`${side}/${key(packet.subarray(3,11))}/${sequence}`;if(retries.has(identity))assert.equal(id,retries.get(identity),'Every retransmission uses exact retained ciphertext');else retries.set(identity,id);}
            const duration=(80+(preamble.length+encodePayload(packet).length)*20)/audio.playbackRate*(1+(config.driftPpm??0)*(side?1:-1)/1e6);
            const peer=links[1-side],frame={side,...detail,ordinal,bytes:packet.length,startMs:clock.now,endMs:clock.now+duration,
              localOutbox:controllers[side].state.pendingCount,
              dropped:false,collided:false,received:false,aborted:false,ready:Boolean(peer?.running&&!peer.playing&&peer.allowedAfter<=clock.now)};
            if(detail.close&&detail.close!=='open')firstClosePacketAt??=clock.now;
            frame.dropped=Boolean(config.drop?.({...frame,sinceCloseMs:closingAt===null?null:clock.now-closingAt}));
            frames.push(frame);link.currentFrame=frame;this.playing=true;
            for(const other of frames)if(other!==frame&&other.side!==side&&other.endMs>frame.startMs&&other.startMs<frame.endMs){frame.collided=true;other.collided=true;}
            if(config.forceOnClose&&!forceDone&&config.forceOnClose===detail.close){forceDone=true;clock.schedule(()=>controllers[config.forceSide??side].stop(),Math.min(duration/2,config.forceDelayMs??300));}
            await pause(duration);if(!this.running)throw abort();
            if(frame.ready&&!frame.collided&&!frame.dropped&&peer?.running){
              clock.schedule(()=>{
                if(peer.running&&!peer.playing&&peer.allowedAfter<=clock.now){frame.received=true;peer.callbacks.onPackets(config.duplicate?[packet.slice(),packet.slice()]:[packet.slice()]);}
              },config.decodeMs??45);
            }
            this.allowedAfter=clock.now+350;await pause(350);if(!this.running)throw abort();
            this.playing=false;this.busy=false;this.currentFrame=null;
          },
          stop(){
            if(this.currentFrame&&clock.now<this.currentFrame.endMs){this.currentFrame.endMs=clock.now;this.currentFrame.aborted=true;}
            this.running=false;this.busy=false;this.playing=false;this.currentFrame=null;
          },
        };
        links[side]=link;return link;
      },
    }));
    const options={profile:config.profile??'nearby',cryptoProfile:config.cryptoProfile??'p256'};
    clock.schedule(()=>controllers[1].start(options).catch(error=>errors.push(error.message)),0);
    clock.schedule(()=>controllers[0].start({...options,text:'Initial encrypted chat'}).catch(error=>errors.push(error.message)),0);
    await clock.run(maxRunMs+50000);
    const snapshots=controllers.map(controller=>controller.state);
    assert.deepEqual(errors,[],config.name);
    assert.ok(launched&&closingAt!==null,'Initial delivery must launch the close scenario');
    assert.ok(snapshots.every(state=>!state.active),'Every endpoint stops within its lifetime');
    assert.ok(links.every(link=>!link.running),'Every transport releases after close/timeout');
    assert.equal(frames.filter(frame=>frame.collided).length,0,config.name+' respects half-duplex turns');
    for(let side=0;side<2;side++){
      const received=messages[side].map(message=>message.text);
      assert.equal(new Set(messages[side].map(message=>message.counter)).size,messages[side].length,'Messages display once despite retries');
      for(const receipt of deliveries[side])assert.ok(messages[1-side].some(message=>message.counter===receipt.counter&&message.text===admitted[side].get(receipt.counter)),'Only matching peer delivery can justify a receipt');
      if(!config.partial)assert.deepEqual(received,expected[side],'Every admitted message drains byte-exact in order');
      if(!config.partial)assert.equal(deliveries[1-side].length,expected[side].length,'Every drained message has an explicit receipt');
      if(config.outcomes?.[side]!==undefined)assert.equal(snapshots[side].close.outcome,config.outcomes[side],`${config.name}: side ${side} outcome; ${snapshots[side].status}`);
    }
    const closureFrames=frames.filter(frame=>frame.close&&frame.close!=='open');
    assert.ok(closureFrames.every(frame=>frame.bytes===51),'Authenticated close keeps the 51-byte control size');
    const commits=frames.filter(frame=>frame.close==='commit');
    if(config.maxCommitAttempts!==undefined)assert.ok(commits.length<=config.maxCommitAttempts,'Commit retry budget is bounded');
    if(config.requireDrop)assert.ok(frames.some(frame=>frame.dropped),'The intended negative case must drop a frame');
    if(config.forceOnClose)assert.ok(forceDone,'Force stop must occur during the requested close stage');
    if(config.reservationDelayMs)assert.ok(frames.some(frame=>frame.close==='drain'&&frame.pending&&frame.localOutbox===0),'A reserved enqueue advertises pending before encryption populates the outbox');
    if(config.maxRunMs)assert.ok(closedAt.every(at=>at<=maxRunMs+150),'Close cannot extend the absolute session lifetime');
    const result={name:config.name,audioProfile:options.profile,cryptoProfile:options.cryptoProfile,
      closeRequestedAtMs:Math.round(closingAt),firstCloseFrameAtMs:firstClosePacketAt===null?null:Math.round(firstClosePacketAt),
      closedAtMs:closedAt.map(value=>Math.round(value)),closeDurationMs:Math.round(Math.max(...closedAt)-closingAt),
      messages:messages.flat().length,receipts:deliveries.flat().length,frames:frames.length,closeFrames:closureFrames.length,
      byteExact:true,onceOnly:true,receiptEvidence:true,
      dropped:frames.filter(frame=>frame.dropped).length,collisions:0,
      final:snapshots.map(state=>({phase:state.phase,close:state.close,pendingCount:state.pendingCount,status:state.status})),
      stateTimeline:states,timeline:frames.map(frame=>({...frame,startMs:Math.round(frame.startMs),endMs:Math.round(frame.endMs)}))};
    console.log(`PASS ${config.name}: ${result.messages} exact messages, ${result.closeDurationMs}ms close, ${result.closeFrames} close frames, ${result.dropped} drops, outcomes ${snapshots.map(state=>state.close.outcome).join('/')}, no collisions.`);
    return result;
  }catch(error){
    await fs.mkdir('out',{recursive:true});
    await fs.writeFile('out/chat-close-simulation-failure.json',JSON.stringify({name:config.name,nowMs:clock.now,states:controllers.map(controller=>controller.state),stateTimeline:states,frames},null,2)+'\n');
    error.message=`${config.name}: ${error.message}`;throw error;
  }
  finally{controllers.forEach(controller=>controller.stop());await clock.flush();clock.restore();}
}

const oneLoss=(close,kind)=>frame=>frame.close===close&&(!kind||frame.kind===kind)&&frame.ordinal===1;
const cases=[
  {name:'initiator-close',outcomes:['confirmed','confirmed']},
  {name:'responder-close',closeSides:[1],outcomes:['confirmed','confirmed']},
  {name:'simultaneous-close',closeSides:[0,1],outcomes:['confirmed','confirmed']},
  {name:'drain-reserved-bidirectional-queues',burstCount:8,reservationDelayMs:15000,closeSides:[0,1],outcomes:['confirmed','confirmed']},
  {name:'drain-full-telephone-queues',burstCount:8,fullPayload:true,profile:'telephone',cryptoProfile:'x25519',closeSides:[1],outcomes:['confirmed','confirmed']},
  {name:'lost-data-during-drain',burstCount:3,fullPayload:true,closeSides:[0,1],drop:frame=>frame.kind==='data'&&frame.ordinal===(frame.side===0?2:1),requireDrop:true,outcomes:['confirmed','confirmed']},
  {name:'lost-drain-poll',drop:oneLoss('drain','poll'),requireDrop:true,outcomes:['confirmed','confirmed']},
  {name:'lost-drain-response',closeSides:[1],drop:oneLoss('drain','response'),requireDrop:true,outcomes:['confirmed','confirmed']},
  {name:'lost-close-commit',drop:oneLoss('commit'),requireDrop:true,outcomes:['confirmed','confirmed']},
  {name:'lost-close-ack',drop:oneLoss('ack'),requireDrop:true,outcomes:['confirmed','confirmed']},
  {name:'lost-close-final',drop:oneLoss('final'),requireDrop:true,outcomes:['confirmed','unconfirmed']},
  {name:'all-close-acks-lost',drop:frame=>frame.close==='ack',requireDrop:true,maxCommitAttempts:3,outcomes:['unconfirmed','unconfirmed']},
  {name:'duplicate-close-decoding-and-drift',duplicate:true,driftPpm:250,decodeMs:250,outcomes:['confirmed','confirmed']},
  {name:'slow-close-rendering',prepareMs:1200,decodeMs:120,outcomes:['confirmed','confirmed']},
  {name:'temporary-one-way-close-outage',drop:frame=>frame.side===1&&frame.sinceCloseMs!==null&&frame.sinceCloseMs<30000,requireDrop:true,outcomes:['confirmed','confirmed']},
  {name:'permanent-close-outage',drop:frame=>frame.sinceCloseMs!==null,requireDrop:true,partial:true,outcomes:['unconfirmed',null]},
  {name:'force-stop-during-commit',forceOnClose:'commit',forceSide:0,partial:true,outcomes:['aborted','unconfirmed']},
  {name:'force-stop-during-drain',forceOnClose:'drain',forceSide:0,partial:true,outcomes:['aborted',null]},
  {name:'force-stop-during-ack',forceOnClose:'ack',forceSide:1,partial:true,outcomes:['unconfirmed','aborted']},
  {name:'force-stop-during-final',forceOnClose:'final',forceSide:0,partial:true,outcomes:['aborted','unconfirmed']},
  {name:'close-at-lifetime-boundary',maxRunMs:90000,closeAtMs:88000,partial:true,outcomes:['unconfirmed',null]},
];
const selected=process.argv.find(argument=>argument.startsWith('--case='))?.slice(7);
const selectedCases=selected?cases.filter(config=>config.name===selected):cases;
assert.ok(selectedCases.length,'Unknown --case selection');
const results=[];for(const config of selectedCases)results.push(await scenario(config));
await fs.mkdir('out',{recursive:true});
await fs.writeFile('out/chat-close-simulation.json',JSON.stringify({schemaVersion:1,scope:'Shared-clock modeled acoustic transport, production timing, actual crypto and frame airtime; no physical audio',cases:results},null,2)+'\n');
