// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
// Production C controller <-> production browser controller, one modeled audio
// timeline, real OpenSSL/Web Crypto and frame airtime. No microphone is opened.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {setTimeout as realTimeout,clearTimeout as realClear} from 'node:timers';
import fs from 'node:fs/promises';
import {AutoTransfer} from '../web/auto-transfer.mjs';
import {ChatTransfer} from '../web/chat-transfer.mjs';
import {encodePayload,preamble} from '../web/communication-codec.mjs';
import {createPCMChannel} from './native-pcm-channel.mjs';

const command=process.env.TONESEAL_TRANSFER_COMMAND?JSON.parse(process.env.TONESEAL_TRANSFER_COMMAND):['build/transfer-driver'];
if(!process.env.TONESEAL_TRANSFER_COMMAND)execFileSync('python3',['scripts/build-cli.py','--transfer-driver',...(process.env.TONESEAL_SANITIZE?['--sanitize']:[])],{stdio:'pipe'});
if(process.env.TONESEAL_TRANSFER_PCM&&!process.env.TONESEAL_MODEM)execFileSync('python3',['scripts/build-cli.py','--modem-driver'],{stdio:'pipe'});
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
const hex=bytes=>Buffer.from(bytes).toString('hex');
const bytes=text=>Uint8Array.from(Buffer.from(text,'hex'));
const encoder=new TextEncoder();
class Clock {
  constructor(){this.now=0;this.serial=0;this.timers=new Map();this.cryptoJobs=[];this.io=new Set();this.revision=0;}
  schedule(callback,delay=0){const id=++this.serial;this.timers.set(id,{id,at:this.now+Math.max(0,delay),callback});this.revision++;return id;}
  cancel(id){if(this.timers.delete(id))this.revision++;}
  track(promise){this.io.add(promise);promise.then(()=>this.io.delete(promise),()=>this.io.delete(promise));return promise;}
  install(){
    this.saved={timeout:globalThis.setTimeout,clear:globalThis.clearTimeout,crypto:Object.getOwnPropertyDescriptor(globalThis,'crypto'),performance:Object.getOwnPropertyDescriptor(globalThis,'performance')};
    const clock=this,native=globalThis.crypto;
    const subtle=new Proxy(native.subtle,{get(target,property){const value=Reflect.get(target,property,target);return typeof value!=='function'?value:(...args)=>new Promise((resolve,reject)=>{
      const result=Promise.resolve().then(()=>value.apply(target,args)).then(value=>({value}),error=>({error}));clock.cryptoJobs.push({result,resolve,reject});clock.revision++;
    });}});
    const crypto=new Proxy(native,{get(target,property){if(property==='subtle')return subtle;const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
    globalThis.setTimeout=(callback,delay,...args)=>this.schedule(()=>callback(...args),delay);
    globalThis.clearTimeout=id=>this.cancel(id);
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:crypto});
    Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>this.now}});
  }
  restore(){globalThis.setTimeout=this.saved.timeout;globalThis.clearTimeout=this.saved.clear;Object.defineProperty(globalThis,'crypto',this.saved.crypto);Object.defineProperty(globalThis,'performance',this.saved.performance);}
  async flush(){
    for(let cycle=0;cycle<1000;cycle++){
      await immediate();
      if(this.io.size){await Promise.all([...this.io]);continue;}
      if(this.cryptoJobs.length){const batch=this.cryptoJobs.splice(0),results=await Promise.all(batch.map(job=>job.result));batch.forEach((job,i)=>results[i].error?job.reject(results[i].error):job.resolve(results[i].value));continue;}
      const revision=this.revision;await immediate();if(!this.io.size&&!this.cryptoJobs.length&&revision===this.revision)return;
    }
    throw Error('Simulation did not settle before the next audio deadline.');
  }
  async run(done,limit=650000){
    for(let step=0;step<20000;step++){
      await this.flush();if(done())return;
      const next=[...this.timers.values()].sort((a,b)=>a.at-b.at||a.id-b.id)[0];
      assert.ok(next,'Active peers need a bounded next deadline');assert.ok(next.at<=limit,'Simulation exceeded its maximum session lifetime');
      this.timers.delete(next.id);this.now=next.at;next.callback();
    }
    throw Error('Simulation timer bound exceeded.');
  }
}
class Native {
  constructor(args,clock){
    this.clock=clock;this.jobs=[];this.stderr='';
    this.child=spawn(command[0],[...command.slice(1),...args],{stdio:['pipe','pipe','pipe']});
    this.child.stderr.on('data',data=>this.stderr=(this.stderr+data).slice(-4000));
    createInterface({input:this.child.stdout}).on('line',line=>{const job=this.jobs.shift();if(!job)return;realClear(job.timer);try{job.resolve(JSON.parse(line));}catch(error){job.reject(error);}});
    this.child.on('error',error=>this.abort(error));
    this.child.on('exit',(code,signal)=>{if(this.jobs.length)this.abort(Error(`C controller exited ${code}/${signal}: ${this.stderr}`));});
  }
  abort(error){for(const job of this.jobs.splice(0)){realClear(job.timer);job.reject(error);}}
  call(line){return this.clock.track(new Promise((resolve,reject)=>{const timer=realTimeout(()=>{this.child.kill();this.abort(Error('C controller timed out.'));},15000);this.jobs.push({resolve,reject,timer});this.child.stdin.write(line+'\n');}));}
  async close(){this.child.stdin.end();await new Promise(resolve=>this.child.exitCode!==null?resolve():this.child.once('exit',resolve));assert.equal(this.child.exitCode,0,`C controller process exited ${this.child.exitCode}: ${this.stderr}`);}
}

async function scenario(config){
  const clock=new Clock(),frames=[],links=[null,null],messages=[[],[]],deliveries=[[],[]],counts=new Map(),errors=[];
  const initial='  é🔑\n\u0000exact bytes  ',expected=[[],[hex(encoder.encode(initial))]];
  let native,js,nativeTimer,nativeBusy=false,nativeState={active:true},started=false,burst=false,closing=false,confirmed=false,failure;
  const chat=config.mode==='chat',nativeSender=config.nativeSender!==false,profile=config.telephone?'telephone':'nearby';
  const pcm=process.env.TONESEAL_TRANSFER_PCM?await createPCMChannel(profile):null;
  const sender=nativeSender?0:1,receiver=1-sender;
  expected[sender]=[];expected[receiver]=[hex(encoder.encode(initial))];
  const received=(side,text)=>messages[side].push(hex(encoder.encode(text)));
  const pause=ms=>new Promise(resolve=>clock.schedule(resolve,ms));
  function classify(packet,side){
    if(packet[0]===0xa8)return ['','data','ack','fin'][packet[2]];
    if(packet[2]===1)return 'offer';if(packet[2]===2)return 'answer';
    if(new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false)<0x80000000)return 'data';
    if(packet.length===51){
      if(side===sender&&(side===0?nativeState.reason.includes('sending final confirmation'):js?.state.close?.stage==='finalizing'))return 'final';
      return side===sender?'poll':'response';
    }
    return 'handshake';
  }
  function link(side,callbacks){return links[side]={running:false,playing:false,allowedAfter:0,callbacks,
    async start(){await pause(150);this.running=true;},
    async send(packet){
      assert.ok(this.running&&!this.playing,'A device cannot play two frames at once');
      await pause(config.prepareMs??180);if(!this.running)throw new DOMException('Stopped','AbortError');
      if(pcm)packet=await clock.track(pcm.transmit(side,packet));
      const kind=classify(packet,side),key=`${side}/${kind}`,ordinal=(counts.get(key)||0)+1;counts.set(key,ordinal);
      const duration=(80+(preamble.length+encodePayload(packet).length)*20)*(config.telephone?4/3:1)*(1+(config.driftPpm??0)*(side?1:-1)/1e6);
      const peer=links[1-side],frame={side,kind,ordinal,hex:hex(packet),start:clock.now,end:clock.now+duration,dropped:Boolean(config.drop?.({side,kind,ordinal,at:clock.now})),collided:false,ready:Boolean(peer?.running&&!peer.playing&&peer.allowedAfter<=clock.now)};
      frames.push(frame);this.playing=true;
      for(const other of frames)if(other!==frame&&other.side!==side&&other.end>frame.start&&other.start<frame.end){frame.collided=true;other.collided=true;}
      await pause(duration);if(!this.running)throw new DOMException('Stopped','AbortError');
      if(frame.ready&&!frame.collided&&!frame.dropped&&peer?.running)clock.schedule(()=>{
        if(peer.running&&!peer.playing&&peer.allowedAfter<=clock.now){
          const received=packet.slice();if(config.corrupt?.({kind,ordinal}))received[received.length-1]^=1;
          peer.callbacks.onPackets(config.duplicate?[received,received.slice()]:[received]);
        }
      },config.decodeMs??45);
      this.allowedAfter=clock.now+350;await pause(350);if(!this.running)throw new DOMException('Stopped','AbortError');this.playing=false;
    },stop(){this.running=false;this.playing=false;}};}
  function maybe(){
    if(config.verify&&!confirmed&&nativeState.phase==='verify'&&js.state.phase==='verify'){
      assert.equal(nativeState.fingerprint,js.state.fingerprint);assert.deepEqual(messages,[[],[]],'No app data before explicit confirmation');confirmed=true;
      clock.schedule(()=>{request('confirm');js.confirm().catch(error=>errors.push(error.message));},config.confirmDelay??4000);
    }
    if(chat&&!config.autoClose&&!burst&&nativeState.connected&&js.state.connected){
      burst=true;
      clock.schedule(()=>{
        for(let side=0;side<2;side++)for(let i=0;i<(config.burst??2);i++){
          const text=`${side} reply ${i}: `+'x'.repeat(config.maxPayload?85:3),value=hex(encoder.encode(text));expected[1-side].push(value);
          if(side===0)request('enqueue',value);else js.enqueue(text).catch(error=>errors.push(error.message));
        }
      },0);
    }
    if(chat&&(burst||config.autoClose)&&!closing&&messages.every((list,i)=>list.length===expected[i].length)&&nativeState.pending===0&&js.state.pendingCount===0){
      closing=true;clock.schedule(()=>{if(config.closeFrom==='browser')js.close();else request('close');},0);
    }
  }
  function update(result){
    nativeState=result.state;
    for(const event of result.events){if(event.type==='message')messages[0].push(event.hex);else deliveries[0].push(event.counter);}
    if(result.packet){
      assert.ok(!nativeBusy);nativeBusy=true;
      links[0].send(bytes(result.packet)).then(()=>{nativeBusy=false;request('sent');},error=>{if(links[0].running)errors.push(error.message);});
    }
    clock.cancel(nativeTimer);nativeTimer=undefined;
    if(nativeState.active&&!nativeBusy)nativeTimer=clock.schedule(()=>request('tick'),Math.max(.1,nativeState.nextDue-clock.now));
    if(!nativeState.active)links[0].stop();maybe();return result;
  }
  function request(command,arg=''){
    // Track the complete IO/update step so virtual time never outruns C output.
    return clock.track(native.call(`${command} ${clock.now.toFixed(3)}${arg?' '+arg:''}`).then(update));
  }
  clock.install();
  try{
    native=new Native([config.crypto??'p256',config.mode,nativeSender?'send':'receive',String(Number(Boolean(config.verify))),String(Number(Boolean(config.autoClose))),nativeSender?hex(encoder.encode(initial)):'',String(config.timeout??60000),String(Number(Boolean(config.telephone)))],clock);
    link(0,{onPackets:packets=>{for(const packet of packets)request('receive',hex(packet));}});
    const Constructor=chat?ChatTransfer:AutoTransfer;
    js=new Constructor({now:()=>clock.now,random:()=>.5,onChange:()=>maybe(),onMessage:record=>{received(1,record.text);maybe();},onDelivery:record=>{deliveries[1].push(record.counter);maybe();},transportFactory:callbacks=>link(1,callbacks)});
    clock.schedule(()=>{links[0].running=true;started=true;request('tick');},nativeSender?0:config.receiverDelay??0);
    clock.schedule(()=>js.start({mode:config.browserMode??(chat?'message':config.mode),text:(!nativeSender||config.bothSend)?initial:'',profile,cryptoProfile:config.browserCrypto??config.crypto??'p256',verifyPeer:config.verify,idleTimeoutMs:config.timeout??60000}).catch(error=>errors.push(error.message)),nativeSender?config.receiverDelay??0:0);
    await clock.run(()=>started&&!nativeState.active&&!js.state.active);
    assert.deepEqual(errors,[],config.name);
    for(let side=0;side<2;side++)for(const counter of deliveries[side])assert.ok(messages[1-side].includes(expected[1-side][counter-1]),'Every delivery claim needs byte-exact receiver evidence, including expected failures');
    if(config.failure){
      assert.ok(nativeState.phase==='error'||js.state.phase==='error');
      if(config.bothSend)assert.deepEqual(messages,[[],[]]);
    }else{
      assert.deepEqual(messages,expected,config.name+' must deliver exact bytes once');
      assert.equal(frames.filter(frame=>frame.collided).length,0,config.name+' must not overlap speaking turns');
      if(chat){assert.equal(nativeState.closeConfirmed,!config.loseFinal||sender===0);assert.equal(js.state.close.outcome,config.loseFinal&&receiver===1?'unconfirmed':'confirmed');}
      else assert.equal(nativeSender?nativeState.phase:js.state.phase,'delivered');
    }
    // Every retained DATA retry must reuse the exact ciphertext, never a nonce.
    const retained=new Map();for(const frame of frames.filter(frame=>frame.kind==='data'&&frame.hex.startsWith('a7'))){const packet=bytes(frame.hex),id=`${frame.side}/${hex(packet.subarray(3,15))}`;if(retained.has(id))assert.equal(frame.hex,retained.get(id));else retained.set(id,frame.hex);}
    const result={name:config.name,pcmVerified:Boolean(pcm),ms:Math.round(clock.now),frames:frames.length,dropped:frames.filter(frame=>frame.dropped).length,collisions:frames.filter(frame=>frame.collided).length,messages:messages.map(list=>list.length),nativeOutcome:nativeState.phase,browserOutcome:js.state.phase};
    console.log('PASS '+JSON.stringify(result));return result;
  }catch(error){failure=error;const detail=`\n${config.name} at ${clock.now}: native=${JSON.stringify(nativeState)} browser=${JSON.stringify(js?.state)} tail=${JSON.stringify(frames.slice(-5).map(({hex,...frame})=>frame))}`;error.message+=detail;error.stack+=detail;throw error;
  }finally{
    js?.stop();links[0]?.stop();
    try{await clock.flush();if(native)await native.close();}catch(error){if(failure)failure.message+='\nCleanup: '+error.message;else throw error;}
    finally{clock.restore();if(pcm)await pcm.close();}
  }
}

const configs=[];
for(const mode of ['clear','password','message','chat'])for(const nativeSender of [true,false])configs.push({name:`${mode}-C-${nativeSender?'sender':'receiver'}`,mode,nativeSender});
configs.push(
  {name:'x25519-chat-C-receiver',mode:'chat',crypto:'x25519',nativeSender:false},
  {name:'verified-password',mode:'password',verify:true,confirmDelay:12000},
  {name:'delayed-browser',mode:'message',receiverDelay:9000},
  {name:'delayed-C',mode:'message',nativeSender:false,receiverDelay:9000},
  {name:'lost-clear-ack-and-fin',mode:'clear',drop:({kind,ordinal})=>(kind==='ack'&&ordinal===1)||kind==='fin'},
  {name:'lost-handshake-and-data',mode:'password',drop:({kind,ordinal})=>(kind==='handshake'&&ordinal===2)||(kind==='data'&&ordinal===1)},
  {name:'altered-ciphertext-retries-exactly',mode:'password',corrupt:({kind,ordinal})=>kind==='data'&&ordinal===1},
  {name:'chat-selective-loss',mode:'chat',drop:({kind,ordinal})=>['data','poll','response'].includes(kind)&&ordinal===2},
  {name:'chat-duplicate-slow-decode',mode:'chat',nativeSender:false,duplicate:true,decodeMs:250,driftPpm:250},
  {name:'chat-browser-closes',mode:'chat',closeFrom:'browser'},
  {name:'chat-C-sender-auto-close',mode:'chat',autoClose:true},
  {name:'chat-C-receiver-auto-close',mode:'chat',nativeSender:false,autoClose:true},
  {name:'chat-lost-final-C-sender',mode:'chat',loseFinal:true,drop:({kind})=>kind==='final'},
  {name:'chat-lost-final-C-receiver',mode:'chat',nativeSender:false,loseFinal:true,drop:({kind})=>kind==='final'},
  {name:'telephone-chat',mode:'chat',crypto:'x25519',telephone:true},
  {name:'chat-eight-outstanding',mode:'chat',burst:7,maxPayload:true},
  {name:'clear-short-idle-after-receipt',mode:'clear',timeout:10000,drop:({kind})=>kind==='fin'},
  {name:'both-senders-clear',mode:'clear',bothSend:true,failure:true},
  {name:'both-senders-encrypted',mode:'password',bothSend:true,failure:true},
  {name:'mismatched-mode',mode:'clear',browserMode:'password',failure:true},
  {name:'native-receiver-wrong-record-kind',mode:'password',browserMode:'message',nativeSender:false,failure:true},
  {name:'mismatched-crypto-profile',mode:'password',browserCrypto:'x25519',failure:true},
  {name:'one-way-outage-bounded',mode:'chat',drop:({side,at})=>side===1&&at>38000,failure:true},
);
const rows=[];for(const config of configs.filter(config=>!process.env.TONESEAL_CASE||config.name===process.env.TONESEAL_CASE))rows.push(await scenario(config));
await fs.mkdir('out',{recursive:true});await fs.writeFile('out/native-transfer.json',JSON.stringify({scope:'C and browser controllers; real crypto; modeled half-duplex audio, not a physical sound test',cases:rows},null,2)+'\n');
