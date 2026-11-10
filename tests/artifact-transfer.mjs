// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ArtifactTransfer,ArtifactAssembler,encodeArtifactFrames,MAX_ARTIFACT_BYTES} from '../web/artifact-transfer.mjs';
import {AutoTransfer} from '../web/auto-transfer.mjs';
import {AutoAudioLink} from '../web/auto-audio-link.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bytes=(size=500)=>Uint8Array.from({length:size},(_,index)=>(index*73+index%7)&255);
async function until(predicate,limit=4000){const end=Date.now()+limit;while(!predicate()){if(Date.now()>end)throw Error('Artifact test timed out.');await delay(2);}}
const timing={retryMs:18,retryJitterMs:2,turnaroundMs:2,initialDelayMs:1,maxRunMs:2500,lingerMs:100,maxAttempts:4};
function pair({drop=()=>false,duplicate=false,autoConfirm=true,receiverClass=ArtifactTransfer,timingOverride={}}={}){
  const links=[],packets=[],messages=[[],[]],states=[[],[]],counts=new Map(),confirmation=[false,false];let initialId;
  const label=(packet,side)=>{
    if(packet[2]===1)return'offer';if(packet[2]===2)return'answer';
    const id=Buffer.from(packet.subarray(3,11)).toString('hex');initialId??=id;
    const counter=new DataView(packet.buffer,packet.byteOffset,packet.length).getUint32(11,false);
    if(counter<0x80000000)return side===0?'fragment':'completion';
    if(id===initialId)return counter===0x80000001?side===0?'sender-ready':'receiver-ready':side===0?'rekey-offer':'rekey-answer';
    if(counter===0x80000001)return side===0?'rekey-commit':'rekey-final';
    return side===0?'completion-ack':'fragment-ack';
  };
  const controllers=[ArtifactTransfer,receiverClass].map((Class,side)=>new Class({
    timing:{...timing,...timingOverride},random:()=>0.5,
    onChange(state){
      states[side].push(state);
      if(autoConfirm&&state.phase==='verify'&&!confirmation[side]){confirmation[side]=true;queueMicrotask(()=>controllers[side].confirm());}
    },
    onMessage(message){messages[side].push(message);},
    transportFactory:callbacks=>{
      const link={callbacks,running:false,playing:false,
        async start(){this.running=true;},
        async send(packet){
          if(!this.running)throw new DOMException('Stopped','AbortError');
          assert.ok(packets.length<300,'Artifact exchanges must remain bounded.');
          const kind=label(packet,side),count=(counts.get(`${side}/${kind}`)||0)+1;counts.set(`${side}/${kind}`,count);
          packets.push({side,kind,count,packet:packet.slice()});this.playing=true;
          await delay(2);
          if(!this.running)throw new DOMException('Stopped','AbortError');
          const peer=links[1-side];
          if(peer?.running&&!peer.playing&&!drop(kind,count,side,packet))queueMicrotask(()=>peer.callbacks.onPackets(duplicate?[packet.slice(),packet.slice()]:[packet.slice()]));
          this.playing=false;
        },
        stop(){this.running=false;this.playing=false;}};
      links[side]=link;return link;
    },
  }));
  return{a:controllers[0],b:controllers[1],links,packets,messages,states,counts,close(){controllers.forEach(controller=>controller.stop());}};
}
async function startBoth(p,{input=bytes(),kind='enrollment',cryptoProfile='x25519',receiverCryptoProfile=cryptoProfile,profile='nearby',ordinary=false}={}){
  await Promise.all([
    p.a.start({bytes:input,kind,cryptoProfile,profile,verifyPeer:true}),
    ordinary?p.b.start({text:'',mode:'message',cryptoProfile:receiverCryptoProfile,profile,verifyPeer:true}):p.b.start({bytes:null,kind,cryptoProfile:receiverCryptoProfile,profile,verifyPeer:true}),
  ]);
}
async function delivered(p){
  await until(()=>p.a.state.phase==='delivered'||p.a.state.phase==='error');
  assert.equal(p.a.state.phase,'delivered',p.a.state.status);
  await until(()=>!p.b.state.active);
  assert.equal(p.b.state.phase,'received',p.b.state.status);
}

test('artifact framing is bounded, canonical, binary exact, and typed',async()=>{
  for(const kind of ['enrollment','approval'])for(const size of [1,48,49,2048]){
    const input=bytes(size),encoded=await encodeArtifactFrames(input,kind),assembler=new ArtifactAssembler({kind});
    assert.ok(encoded.frames.every(frame=>frame.length<=96));assert.equal(encoded.frames.length,1+Math.ceil(size/48));
    let result;
    for(const frame of encoded.frames)result=await assembler.accept(frame);
    assert.equal(result.complete,true);assert.equal(result.kind,kind);assert.deepEqual(result.bytes,input);assert.equal(result.sha256,encoded.sha256);
    await assert.rejects(assembler.accept(encoded.frames.at(-1)),/closed/);
  }
  assert.equal(MAX_ARTIFACT_BYTES,2048);
  for(const invalid of [new Uint8Array(),new Uint8Array(2049),[1,2]])await assert.rejects(encodeArtifactFrames(invalid,'enrollment'),/1–2048/);
  await assert.rejects(encodeArtifactFrames(bytes(),'private-key'),/enrollment or approval/);
  const buffer=Buffer.from(bytes(60)),copy=Buffer.from(buffer);
  await encodeArtifactFrames(buffer,'enrollment');assert.deepEqual(buffer,copy,'Buffer input must not be wiped through a shared slice.');
});

test('manifest, sequence, type and encoding violations poison assembly without releasing partial bytes',async()=>{
  const encoded=await encodeArtifactFrames(bytes(70),'enrollment'),other=await encodeArtifactFrames(bytes(70),'enrollment');
  const mutations=[
    [encoded.frames[0].replace('|0046|','|0801|')],
    [encoded.frames[0].replace('|02|','|01|')],
    [encoded.frames[0].replace('|enrollment|','|approval|')],
    [encoded.frames[0],other.frames[1]],
    [encoded.frames[0],encoded.frames[2]],
    [encoded.frames[0],encoded.frames[1],encoded.frames[1]],
    [encoded.frames[0],encoded.frames[1]+'='],
  ];
  for(const frames of mutations){
    const assembler=new ArtifactAssembler({kind:'enrollment'});let failed=false;
    for(const frame of frames){try{const result=await assembler.accept(frame);assert.equal(result.complete,false);}catch{failed=true;break;}}
    assert.equal(failed,true);assert.equal(assembler.failed,true);assert.equal(assembler.parts.length,0);
    await assert.rejects(assembler.accept(encoded.frames[0]),/closed/);
  }
});

test('full artifact digest must match before any result is released',async()=>{
  const encoded=await encodeArtifactFrames(bytes(70),'approval'),assembler=new ArtifactAssembler({kind:'approval'});
  const manifest=encoded.frames[0].slice(0,-43)+'A'.repeat(43);
  await assembler.accept(manifest);await assembler.accept(encoded.frames[1]);
  await assert.rejects(assembler.accept(encoded.frames[2]),/digest/);
  assert.equal(assembler.failed,true);assert.equal(assembler.parts.length,0);
});

test('reset during final digest cannot poison a new assembly',async()=>{
  const first=await encodeArtifactFrames(bytes(10),'enrollment'),second=await encodeArtifactFrames(bytes(20),'enrollment');
  const assembler=new ArtifactAssembler({kind:'enrollment'});await assembler.accept(first.frames[0]);
  const original=crypto.subtle.digest.bind(crypto.subtle);let release;
  crypto.subtle.digest=(...args)=>new Promise(resolve=>{release=()=>resolve(original(...args));});
  const pending=assembler.accept(first.frames[1]);
  try{
    assert.equal(typeof release,'function');assembler.reset();await assembler.accept(second.frames[0]);
    release();await assert.rejects(pending,/reset/);
    assert.equal(assembler.failed,false);assert.equal(assembler.meta.id,second.id);
  }finally{crypto.subtle.digest=original;}
  const result=await assembler.accept(second.frames[1]);assert.equal(result.complete,true);assert.deepEqual(result.bytes,bytes(20));
});

test('a concurrent invalid fragment cancels a pending final digest result',async()=>{
  const encoded=await encodeArtifactFrames(bytes(10),'enrollment'),assembler=new ArtifactAssembler({kind:'enrollment'});
  await assembler.accept(encoded.frames[0]);
  const original=crypto.subtle.digest.bind(crypto.subtle);let release;
  crypto.subtle.digest=(...args)=>new Promise(resolve=>{release=()=>resolve(original(...args));});
  const pending=assembler.accept(encoded.frames[1]);
  try{
    await assert.rejects(assembler.accept(encoded.frames[1]),/closed/);
    release();await assert.rejects(pending,/closed/);assert.equal(assembler.failed,true);
  }finally{crypto.subtle.digest=original;}
});

test('verified public artifacts use one pairing and rekey, deliver once, and close on completion receipt',async()=>{
  for(const cryptoProfile of ['p256','x25519'])for(const profile of ['nearby','telephone']){
    const p=pair(),input=bytes(cryptoProfile==='x25519'&&profile==='telephone'?2048:500);
    try{
      await startBoth(p,{input,kind:'approval',cryptoProfile,profile});await delivered(p);
      assert.equal(p.messages[1].length,1);assert.equal(p.messages[0].length,0);
      assert.equal(p.messages[1][0].kind,'approval');assert.deepEqual(p.messages[1][0].bytes,input);assert.match(p.messages[1][0].sha256,/^[a-f0-9]{64}$/);
      // Real crypto can outlast the shortened retry timer under browser-test
      // load. An exact repeated flight is still the same pairing/key refresh.
      for(const flight of ['offer','answer','rekey-offer','rekey-answer','completion','completion-ack']){
        const records=p.packets.filter(packet=>packet.kind===flight);
        assert.equal(new Set(records.map(({packet})=>Buffer.from(packet).toString('hex'))).size,1,`${flight} has one distinct record; retries preserve its bytes`);
      }
      assert.equal(p.a.state.peerVerified,true);assert.equal(p.b.state.peerVerified,true);
      assert.equal(p.a.state.artifactProgress,Math.ceil(input.length/48));
      assert.equal(p.links[0].callbacks.maxRunMs,timing.maxRunMs);assert.equal(p.links[1].callbacks.maxRunMs,timing.maxRunMs);
    }finally{p.close();}
  }
});

test('both verification decisions precede the first artifact fragment',async()=>{
  const p=pair({autoConfirm:false});
  try{
    await startBoth(p);await until(()=>p.a.state.phase==='verify'&&p.b.state.phase==='verify');
    assert.equal(p.packets.some(packet=>packet.kind==='fragment'),false);await p.a.confirm();await delay(30);
    assert.equal(p.packets.some(packet=>packet.kind==='fragment'),false);await p.b.confirm();await delivered(p);
  }finally{p.close();}
});

test('Start snapshots caller bytes before later mutation',async()=>{
  const p=pair(),input=Buffer.from(bytes(200)),expected=new Uint8Array(input);
  try{
    const starting=startBoth(p,{input});input.fill(0);await starting;await delivered(p);
    assert.deepEqual(p.messages[1][0].bytes,expected);
  }finally{p.close();}
});

test('an older Start cannot clear the artifact belonging to a newer run',async()=>{
  const openings=[];
  const transfer=new ArtifactTransfer({timing,transportFactory:()=>({start:()=>new Promise(resolve=>openings.push(resolve)),stop(){},send:async()=>{}})});
  try{
    const invalid=transfer.start({bytes:bytes(10),kind:'enrollment',cryptoProfile:'invalid'});
    const current=transfer.start({bytes:bytes(20),kind:'enrollment'});
    await assert.rejects(invalid,/cryptographic profile/);
    assert.deepEqual(transfer._artifactBytes,bytes(20));
    transfer.stop();
    const next=transfer.start({bytes:bytes(30),kind:'approval'});
    openings[0]();await current;
    assert.deepEqual(transfer._artifactBytes,bytes(30));
    openings[1]();await next;
    assert.equal(transfer.state.artifactKind,'approval');
  }finally{transfer.stop();}
});

test('packet loss and duplicate callbacks preserve exact retry and one object delivery',async()=>{
  for(const lost of ['offer','answer','rekey-offer','rekey-final','fragment','fragment-ack','completion','completion-ack']){
    const p=pair({duplicate:true,drop:(kind,count)=>kind===lost&&count===1});
    try{
      await startBoth(p,{input:bytes(200)});await delivered(p);assert.equal(p.messages[1].length,1,lost);
      const bySequence=new Map();
      for(const {kind,packet} of p.packets.filter(frame=>frame.kind==='fragment')){
        const counter=new DataView(packet.buffer,packet.byteOffset,packet.length).getUint32(11,false);
        if(bySequence.has(counter))assert.deepEqual(packet,bySequence.get(counter),`${kind} retry preserves ciphertext`);else bySequence.set(counter,packet);
      }
      assert.ok(p.packets.filter(packet=>packet.kind===lost).length>=1);
    }finally{p.close();}
  }
});

test('complete-object proof repairs a lost final fragment ACK',async()=>{
  const input=bytes(100),lastAck=1+Math.ceil(input.length/48),p=pair({drop:(kind,count)=>kind==='fragment-ack'&&count===lastAck});
  try{await startBoth(p,{input});await delivered(p);assert.equal(p.messages[1].length,1);assert.equal(p.counts.get('1/completion'),1);}finally{p.close();}
});

test('authenticated malformed metadata or chunks fail closed before the final fragment ACK',async()=>{
  for(const mutation of ['oversized','kind','mixed','digest']){
    const p=pair(),original=p.a._sendMessage.bind(p.a);
    p.a._sendMessage=async generation=>{
      if(!p.a._artifactFrames){
        const encoded=await encodeArtifactFrames(p.a._artifactBytes,p.a._artifactKind);
        p.a._artifactMeta=encoded;p.a._artifactFrames=encoded.frames;
        if(mutation==='oversized')encoded.frames[0]=encoded.frames[0].replace('|0064|','|0801|');
        if(mutation==='kind')encoded.frames[0]=encoded.frames[0].replace('|enrollment|','|approval|');
        if(mutation==='mixed')encoded.frames[1]=encoded.frames[1].replace(encoded.id,'AAAAAAAAAAAAAAAAAAAAAA');
        if(mutation==='digest')encoded.frames[0]=encoded.frames[0].slice(0,-43)+'A'.repeat(43);
      }
      return original(generation);
    };
    try{
      await startBoth(p,{input:bytes(100)});await until(()=>p.b.state.phase==='error');await until(()=>!p.a.state.active);
      assert.equal(p.messages[1].length,0,mutation);assert.equal(p.states[0].some(state=>state.phase==='delivered'),false);
      assert.equal(p.packets.some(packet=>packet.kind==='completion'),false);
      if(mutation==='digest')assert.equal(p.counts.get('1/fragment-ack'),3,'Manifest and two partial fragments ACK; invalid final fragment never ACKs.');
    }finally{p.close();}
  }
});

test('ordinary Message receipts cannot falsely confirm complete artifact validation',async()=>{
  const p=pair({receiverClass:AutoTransfer,timingOverride:{maxRunMs:600}});
  try{
    await startBoth(p,{input:bytes(50),ordinary:true});await until(()=>!p.a.state.active);
    assert.equal(p.a.state.phase,'error');assert.equal(p.states[0].some(state=>state.phase==='delivered'),false);
    assert.equal(p.packets.some(packet=>packet.kind==='completion'),false);
  }finally{p.close();}
});

test('an authenticated completion for another object cannot confirm the sender',async()=>{
  const p=pair();
  try{
    await startBoth(p,{input:bytes(100)});
    const send=p.b._session.send.bind(p.b._session);
    p.b._session.send=(kind,text)=>send(kind,text.startsWith('TS1F|')?text.replace(/^TS1F\|[^|]+\|/,'TS1F|AAAAAAAAAAAAAAAAAAAAAA|'):text);
    await until(()=>p.a.state.phase==='error');
    assert.equal(p.states[0].some(state=>state.phase==='delivered'),false);
    assert.match(p.a.state.status,/completion receipt/);
  }finally{p.close();}
});

test('cross-suite peers time out without artifact delivery',async()=>{
  const p=pair({timingOverride:{maxRunMs:300}});
  try{await startBoth(p,{receiverCryptoProfile:'p256'});await until(()=>!p.a.state.active&&!p.b.state.active);assert.equal(p.messages.flat().length,0);assert.equal(p.states.flat().some(state=>state.phase==='delivered'),false);}finally{p.close();}
});

test('Stop erases pending assembly and queued artifacts and prevents callbacks',async()=>{
  const p=pair({autoConfirm:false});
  try{
    await startBoth(p);await until(()=>p.a.state.phase==='verify'&&p.b.state.phase==='verify');
    const pending=p.a._artifactBytes;
    p.a.stop();p.b.stop();await delay(40);
    assert.equal(pending.every(value=>value===0),true);
    assert.equal(p.a._artifactBytes,null);assert.equal(p.a._artifactFrames,null);assert.equal(p.b._assembler,null);
    assert.equal(p.messages.flat().length,0);assert.equal(p.links.every(link=>!link.running),true);
  }finally{p.close();}
  const receiving=pair();
  try{
    await startBoth(receiving,{input:bytes(1000)});await until(()=>receiving.b.state.artifactProgress>=1);
    const partials=receiving.b._assembler.parts.slice();assert.ok(partials.length>0);
    receiving.a.stop();receiving.b.stop();await delay(40);
    assert.equal(partials.every(part=>part.every(value=>value===0)),true);
    assert.equal(receiving.messages.flat().length,0);assert.equal(receiving.b._assembler,null);
  }finally{receiving.close();}
});

test('artifact policy rejects invalid input before audio and bounds transport lifetime',async()=>{
  const p=pair();
  try{
    await assert.rejects(p.a.start({kind:'enrollment',bytes:bytes(),verifyPeer:false}),/require Verify/);
    await assert.rejects(p.a.start({kind:'private-key',bytes:bytes()}),/enrollment or approval/);
    await assert.rejects(p.a.start({kind:'approval',bytes:bytes(2049)}),/1–2048/);
    assert.equal(p.links.length,0);
  }finally{p.close();}
  assert.equal(new AutoAudioLink().maxRunMs,180000);
  assert.equal(new AutoAudioLink({maxRunMs:600000}).maxRunMs,600000);
  assert.equal(new AutoAudioLink({maxRunMs:7200000}).maxRunMs,7200000);
  for(const maxRunMs of [0,-1,7200001,NaN,Infinity,1.5])assert.throws(()=>new AutoAudioLink({maxRunMs}),/two hours/);
  const artifact=new ArtifactTransfer();assert.equal(artifact._baseTiming.maxRunMs,600000);artifact.stop();
  assert.throws(()=>new ArtifactTransfer({timing:{maxRunMs:600001}}),/ten minutes/);
  let ordinaryOptions;
  const ordinary=new AutoTransfer({transportFactory:options=>{ordinaryOptions=options;return{start:async()=>{},stop(){}};}});
  await ordinary.start({text:''});assert.equal(ordinary._baseTiming.maxRunMs,180000);assert.equal(Object.hasOwn(ordinaryOptions,'maxRunMs'),false);ordinary.stop();
});
