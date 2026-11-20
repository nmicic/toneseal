// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {protocolTest as test} from './protocol-clock.mjs';
import {AutoTransfer} from '../web/auto-transfer.mjs';
import {getAudioProfile} from '../web/audio-profiles.mjs';
import {encodePayload, preamble} from '../web/communication-codec.mjs';
import {encodeClearData, decodeClearPacket, clearControl, sameClearTransfer} from '../web/clear-session.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(predicate, limit=3000) {
  const end=Date.now()+limit;
  while (!predicate()) { if (Date.now()>end) throw Error('Timed out waiting for test condition'); await delay(2); }
}
const timing={retryMs:25,retryJitterMs:4,turnaroundMs:3,initialDelayMs:2,maxRunMs:2500,lingerMs:160,maxAttempts:8};
function pair({drop=()=>false, failSend, open, timingOverride={}, acousticTiming=null, duplicateBatch=false, cryptoCheck}={}) {
  const links=[], packets=[], states=[[],[]], messages=[[],[]], counts=new Map();
  let initialId;
  function kind(packet,side) {
    if (packet[0]===0xa8) return ['','clear-data','clear-ack','clear-fin'][packet[2]];
    if (packet[2]===1) return 'offer';
    if (packet[2]===2) return 'answer';
    const id=Buffer.from(packet.subarray(3,11)).toString('hex');
    initialId??=id;
    const seq=new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false);
    if (seq<0x80000000) return 'message';
    if (id===initialId) return seq===0x80000001 ? side===0?'sender-ready':'receiver-ready' : side===0?'rekey-offer':'rekey-answer';
    return seq===0x80000001 ? side===0?'rekey-commit':'rekey-final' : 'ack';
  }
  const controllers=[0,1].map(side=>new AutoTransfer({
    cryptoCheck,
    timing:{...timing,...timingOverride},random:()=>0.5,
    onChange:state=>states[side].push(state),onMessage:message=>messages[side].push(message),
    transportFactory:callbacks=>{
      const link={running:false,playing:false,startCalls:0,stopCalls:0,
        async start() { this.startCalls++; if(open) await open(side); this.running=true; },
        async send(packet) {
          if (!this.running) throw new DOMException('Stopped','AbortError');
          const label=kind(packet,side), count=(counts.get(label)||0)+1;counts.set(label,count);
          packets.push({side,label,packet:packet.slice(),count});
          if (failSend?.(label,side)) throw Error('Synthetic local playback failure');
          if (acousticTiming) await delay(acousticTiming.prepareMs);
          this.playing=true;
          await delay(acousticTiming ? (80 + (preamble.length + encodePayload(packet).length) * 20) / acousticTiming.scale / getAudioProfile(callbacks.profile).playbackRate : 2);
          if (!this.running) throw new DOMException('Stopped','AbortError');
          const peer=links[1-side];
          if (peer?.running && !peer.playing && !drop(label,count,side)) {
            // Real transport callback does not await protocol responses.
            queueMicrotask(()=>peer.callbacks.onPackets(duplicateBatch?[packet.slice(),packet.slice()]:[packet.slice()]));
          }
          // Native decoding can return at the end of the sound while its sender
          // is still suppressing microphone echo. Responses must respect that.
          if (acousticTiming) await delay(acousticTiming.echoMs);
          this.playing=false;
        },
        stop() {this.running=false;this.playing=false;this.stopCalls++;},callbacks};
      links[side]=link;return link;
    },
  }));
  return {a:controllers[0],b:controllers[1],links,packets,states,messages,counts,
    close(){controllers.forEach(controller=>controller.stop());}};
}
async function startBoth(p, sender={},receiver={}) {
  await Promise.all([p.a.start({mode:'message',text:'Dummy message',...sender}),p.b.start({mode:'message',text:'',...receiver})]);
}
async function delivered(p,limit=3000) {
  await until(()=>p.a.state.phase==='delivered' || p.a.state.phase==='error',limit);
  assert.equal(p.a.state.phase,'delivered',p.a.state.status);
  assert.equal(p.b.state.phase,'received',p.b.state.status);
}

test('Simple starts audio immediately, negotiates, refreshes keys and confirms delivery without user actions',async()=>{
  const p=pair();
  try {
    const starting=p.a.start({text:'Dummy password',mode:'password'});
    assert.equal(p.links[0].startCalls,1,'audio startup occurs synchronously in Start gesture');
    await p.b.start({text:'',mode:'password'});await starting;await delivered(p);
    assert.deepEqual(p.messages[1],[{type:'password',text:'Dummy password'}]);
    for(const state of [...p.states[0],...p.states[1]]) {
      assert.equal(state.peerVerified,false);assert.equal(state.verification,'automatic');
      assert.equal(JSON.stringify(state).includes('Dummy password'),false,'status does not contain a secret');
    }
    const order=p.packets.map(packet=>packet.label);
    for(const label of ['offer','answer','sender-ready','receiver-ready','rekey-offer','rekey-answer','rekey-commit','rekey-final','message','ack']) assert.ok(order.includes(label),label);
    assert.ok(order.indexOf('message')>order.indexOf('rekey-final'));
    assert.equal(p.links[0].running,false,'sender closes media after authenticated ACK');
    assert.equal(p.links[1].running,true,'receiver lingers to repair a lost ACK');
    await until(()=>!p.b.state.active);
    assert.equal(p.links[1].running,false);
    assert.equal(p.b.state.phase,'received');
  } finally {p.close();}
});

test('shorter automatic waits allow full-size acoustic responses without colliding or retrying healthy flights',async()=>{
  // Run the real framing durations at 10x speed with a conservative 1.2-second
  // preparation budget per packet and the unchanged 350ms echo suppression.
  for(const [mode,profile] of [['password','nearby'],['clear','nearby'],['password','telephone'],['clear','telephone']]) {
    const p=pair({acousticTiming:{scale:10,prepareMs:120,echoMs:35},
      timingOverride:{retryMs:800,retryJitterMs:100,turnaroundMs:50,initialDelayMs:25,lingerMs:6000,maxRunMs:15000}});
    try {
      await startBoth(p,{mode,text:'x'.repeat(96),profile},{mode,profile});
      await delivered(p,14000);
      assert.equal(p.messages[1][0].text.length,96);
      for(const [kind,count] of p.counts) assert.equal(count,1,kind+' should not overlap a healthy response');
      if(mode==='clear')assert.equal(p.b.state.active,false,'FIN closes capture after the full-size exchange');
    } finally {p.close();}
  }
});

test('profile selection is validated before capture and retry timing resets between runs',async()=>{
  const p=pair();
  try {
    await assert.rejects(p.a.start({profile:'unknown'}),/supported audio profile/);
    await assert.rejects(p.a.start({cryptoProfile:'unknown'}),/crypto|cryptographic|key.exchange/i);
    assert.equal(p.links.length,0,'an invalid profile must not request microphone access');
    for(const profile of ['telephone','telephone','nearby']) {
      await p.a.start({text:'',profile});
      assert.equal(p.links[0].callbacks.profile,profile);
      assert.equal(p.a.state.profile,profile);
      assert.equal(p.a._timing.retryMs,timing.retryMs*getAudioProfile(profile).timingScale);
      assert.equal(p.a._timing.maxRunMs,timing.maxRunMs,'absolute timeout stays bounded');
      assert.equal(p.a._timing.turnaroundMs,timing.turnaroundMs);
      p.a.stop();
    }
  } finally {p.close();}
});

test('compact crypto uses short records through verification, rekey and delivery in both encrypted modes',async()=>{
  for(const mode of ['message','password']) {
    const p=pair();
    try {
      const options={mode,cryptoProfile:'x25519',verifyPeer:true};
      await startBoth(p,{...options,text:'Compact bytes é 🗝️'},options);
      await until(()=>p.a.state.phase==='verify'&&p.b.state.phase==='verify');
      assert.equal(p.a.state.cryptoProfile,'x25519');
      assert.equal(p.a.state.fingerprint,p.b.state.fingerprint);
      assert.equal(p.messages[1].length,0);
      await p.a.confirm();await delay(30);
      assert.equal(p.messages[1].length,0,'Both confirmations remain required');
      await p.b.confirm();await delivered(p);
      assert.deepEqual(p.messages[1],[{type:mode,text:'Compact bytes é 🗝️'}]);
      assert.equal(p.a.state.peerVerified,true);
      for(const {label,packet} of p.packets) {
        assert.equal(packet[1],3,'Every compact record remains in its selected version');
        if(['offer','answer'].includes(label))assert.equal(packet.length,51);
        if(['rekey-offer','rekey-answer'].includes(label))assert.equal(packet.length,80);
      }
    } finally {p.close();}
  }
});

test('compact crypto cannot negotiate down to a mismatched peer',async()=>{
  for(const [left,right] of [['x25519','p256'],['p256','x25519']]) {
    const p=pair({timingOverride:{maxRunMs:180,maxAttempts:2}});
    try {
      await startBoth(p,{cryptoProfile:left},{cryptoProfile:right});
      await until(()=>!p.a.state.active&&!p.b.state.active);
      assert.equal(p.messages.flat().length,0);
      assert.equal(p.states.flat().some(state=>state.phase==='delivered'),false);
      assert.equal(p.a.state.cryptoProfile,left);assert.equal(p.b.state.cryptoProfile,right);
      for(const {side,packet} of p.packets)assert.equal(packet[1],(side===0?left:right)==='x25519'?3:2);
    } finally {p.close();}
  }
});

test('unsupported compact crypto and interrupted capability checks close audio without sending',async()=>{
  const unavailable=pair({cryptoCheck:async id=>{assert.equal(id,'x25519');throw Error('Compact key exchange is unavailable. Choose Compatible on both devices.');}});
  try {
    await startBoth(unavailable,{cryptoProfile:'x25519'},{cryptoProfile:'x25519'});
    for(const controller of [unavailable.a,unavailable.b]) {
      assert.equal(controller.state.phase,'error');assert.match(controller.state.status,/unavailable/);
      assert.equal(controller.state.cryptoProfile,'x25519');
    }
    assert.equal(unavailable.links.every(link=>!link.running),true);
    assert.equal(unavailable.packets.length,0);
  } finally {unavailable.close();}
  let release;
  const waiting=pair({cryptoCheck:()=>new Promise(resolve=>{release=resolve;})});
  try {
    const opening=waiting.a.start({cryptoProfile:'x25519',text:'Never sent'});
    assert.equal(waiting.links[0].startCalls,1,'Audio activation remains synchronous');
    waiting.a.stop();release();await opening;await delay(40);
    assert.equal(waiting.a.state.phase,'stopped');assert.equal(waiting.links[0].running,false);
    assert.equal(waiting.packets.length,0);
  } finally {waiting.close();}
});

test('Verify mode sends no payload until both humans confirm and preserves verified continuity through fresh rekey',async()=>{
  const p=pair();
  try {
    await startBoth(p,{verifyPeer:true},{verifyPeer:true});
    await until(()=>p.a.state.phase==='verify' && p.b.state.phase==='verify');
    assert.equal(p.a.state.fingerprint,p.b.state.fingerprint);
    const initial=p.a.state.fingerprint;
    assert.equal(p.packets.some(packet=>packet.label==='message'),false);
    await p.a.confirm();await delay(50);
    assert.equal(p.messages[1].length,0);
    assert.equal(p.b.state.verification,'required');
    await p.b.confirm();await delivered(p);
    assert.equal(p.a.state.peerVerified,true);assert.equal(p.b.state.peerVerified,true);
    assert.notEqual(p.a.state.fingerprint,initial,'fresh rekey changes fingerprint');
    assert.equal(p.a.state.fingerprint,p.b.state.fingerprint);
    assert.equal(p.a.state.verification,'verified');
  } finally {p.close();}
});

test('one verified side can wait independently while the other uses Simple',async()=>{
  for(const verifyingSide of [0,1]) {
    const p=pair();
    try {
      await startBoth(p,{verifyPeer:verifyingSide===0},{verifyPeer:verifyingSide===1});
      const verifier=verifyingSide===0?p.a:p.b;
      await until(()=>verifier.state.phase==='verify');
      await delay(40);assert.equal(p.messages[1].length,0);
      await verifier.confirm();await delivered(p);
      assert.equal(p.a.state.peerVerified,verifyingSide===0);
      assert.equal(p.b.state.peerVerified,verifyingSide===1);
    } finally {p.close();}
  }
});

test('sender or receiver may Start first and missing initial offers recover',async()=>{
  for(const senderFirst of [true,false]) {
    const p=pair();
    try {
      if(senderFirst) {await p.a.start({text:'Either order'});await delay(50);await p.b.start({text:''});}
      else {await p.b.start({text:''});await delay(50);await p.a.start({text:'Either order'});}
      await delivered(p);assert.equal(p.messages[1][0].text,'Either order');
    } finally {p.close();}
  }
});

test('loss of every flight recovers with exact retransmission, authenticated receipts, and no duplicate display',async()=>{
  for(const lost of ['offer','answer','sender-ready','receiver-ready','rekey-offer','rekey-answer','rekey-commit','rekey-final','message','ack']) {
    const p=pair({drop:(label,count)=>label===lost && count===1});
    try {
      await startBoth(p);await delivered(p);
      assert.equal(p.messages[1].length,1,lost+' must deliver only once');
      const messages=p.packets.filter(packet=>packet.label==='message');
      for(const retry of messages.slice(1)) assert.deepEqual(retry.packet,messages[0].packet,'message retries retain identical ciphertext');
      assert.ok(p.counts.get(lost)>=2,lost+' must be retried or answered again');
    } finally {p.close();}
  }
});

test('duplicate Confirm clicks share a single confirmation and do not abort the transfer',async()=>{
  const p=pair();
  try {
    await startBoth(p,{verifyPeer:true},{verifyPeer:true});
    await until(()=>p.a.state.phase==='verify' && p.b.state.phase==='verify');
    await Promise.all([p.a.confirm(),p.a.confirm(),p.b.confirm(),p.b.confirm()]);
    await delivered(p);assert.equal(p.messages[1].length,1);
  } finally {p.close();}
});

test('cleartext DATA / checksum ACK / FIN confirms delivery and closes both audio links',async()=>{
  const p=pair();
  try {
    await startBoth(p,{mode:'clear',text:'Clear dummy'},{mode:'clear'});
    await delivered(p);
    assert.equal(p.a.state.peerVerified,false);
    assert.match(p.a.state.status,/not authenticated/);
    assert.deepEqual(p.messages[1],[{type:'clear',text:'Clear dummy'}]);
    assert.deepEqual(p.packets.map(packet=>packet.label),['clear-data','clear-ack','clear-fin']);
    assert.equal(p.links[0].running,false);assert.equal(p.links[1].running,false);
    assert.equal(p.a.state.fingerprint,'');assert.equal(p.b.state.fingerprint,'');
  } finally {p.close();}
});

test('same-callback decoder duplicates do not schedule extra replies while later loss retries still work',async()=>{
  for(const mode of ['message','clear']) {
    const p=pair({duplicateBatch:true});
    try {
      await startBoth(p,{mode,text:'One physical occurrence'},{mode});await delivered(p);
      assert.equal(p.messages[1].length,1);
      for(const [kind,count] of p.counts)assert.equal(count,1,kind+' should be answered once per callback batch');
    } finally {p.close();}
    const lost=pair({duplicateBatch:true,drop:(kind,count)=>kind===(mode==='clear'?'clear-ack':'ack')&&count===1});
    try {
      await startBoth(lost,{mode,text:'Later acoustic retry'},{mode});await delivered(lost);
      assert.equal(lost.messages[1].length,1);
      assert.equal(lost.counts.get(mode==='clear'?'clear-data':'message'),2,'later callback with identical data gets another receipt');
      assert.equal(lost.counts.get(mode==='clear'?'clear-ack':'ack'),2);
    } finally {lost.close();}
  }
});

test('cleartext repairs lost DATA and ACK with exact retransmission and no repeated display',async()=>{
  for(const lost of ['clear-data','clear-ack']) {
    const p=pair({drop:(label,count)=>label===lost && count===1});
    try {
      await startBoth(p,{mode:'clear',text:'Clear retry é'},{mode:'clear'});await delivered(p);
      assert.deepEqual(p.messages[1],[{type:'clear',text:'Clear retry é'}]);
      assert.equal(p.counts.get('clear-data'),2);
      const data=p.packets.filter(packet=>packet.label==='clear-data');
      assert.deepEqual(data[0].packet,data[1].packet);
      const receipts=p.packets.filter(packet=>packet.label==='clear-ack');
      for(const retry of receipts.slice(1))assert.deepEqual(retry.packet,receipts[0].packet);
      assert.equal(p.links[0].running,false);assert.equal(p.links[1].running,false);
    } finally {p.close();}
  }
});

test('a lost cleartext FIN preserves delivery and stops the receiver after bounded successful linger',async()=>{
  for(const timingOverride of [{lingerMs:100},{lingerMs:300,maxRunMs:90}]) {
    const p=pair({drop:label=>label==='clear-fin',timingOverride});
    try {
      await startBoth(p,{mode:'clear',text:'Already received'},{mode:'clear'});await delivered(p);
      assert.equal(p.links[1].running,true);
      await until(()=>!p.b.state.active);
      assert.equal(p.b.state.phase,'received');assert.equal(p.links[1].running,false);
      assert.match(p.b.state.status,/Final confirmation was not heard/);
      assert.deepEqual(p.messages[1],[{type:'clear',text:'Already received'}]);
    } finally {p.close();}
  }
});

test('cleartext FIN playback failure preserves the matching receipt and successful receiver result',async()=>{
  const p=pair({failSend:label=>label==='clear-fin',timingOverride:{lingerMs:70}});
  try {
    await startBoth(p,{mode:'clear',text:'Receipt already arrived'},{mode:'clear'});await delivered(p);
    assert.match(p.a.state.status,/Final confirmation could not be sent/);
    assert.equal(p.links[0].running,false);
    await until(()=>!p.b.state.active);
    assert.equal(p.b.state.phase,'received');assert.equal(p.messages[1].length,1);
  } finally {p.close();}
});

test('cleartext rejects corrupted data, stale/wrong receipts, reflections and unrelated messages',async()=>{
  let dropAll=true;
  const p=pair({drop:()=>dropAll});
  try {
    await startBoth(p,{mode:'clear',text:'Bound receipt'},{mode:'clear'});
    await until(()=>p.packets.some(packet=>packet.label==='clear-data'));
    const packet=p.packets.find(packet=>packet.label==='clear-data').packet;
    const other=await encodeClearData('Other transfer');
    const corrupt=packet.slice();corrupt[corrupt.length-1]^=1;
    const alteredAck=clearControl(packet,'ack');alteredAck[20]^=1;
    await p.b.receive([corrupt,clearControl(packet,'fin'),Uint8Array.of(0,65)]);
    assert.equal(p.messages[1].length,0);
    await p.a.receive([packet,clearControl(other,'ack'),alteredAck,clearControl(packet,'fin')]);
    assert.equal(p.a.state.phase,'sending');assert.equal(p.a.state.active,true);
    await p.b.receive([packet]);
    assert.equal(p.messages[1].length,1);
    await p.b.receive([other,clearControl(other,'fin')]);
    assert.equal(p.messages[1].length,1);assert.equal(p.b.state.active,true);
    dropAll=false;await delivered(p);
    assert.equal(p.messages[1].length,1);
  } finally {p.close();}
});

test('cleartext timeout and Stop never claim delivery without a matching receipt',async()=>{
  const missing=pair({drop:label=>label==='clear-ack',timingOverride:{maxAttempts:2}});
  try {
    await startBoth(missing,{mode:'clear',text:'No receipt'},{mode:'clear'});
    await until(()=>missing.a.state.phase==='error');
    assert.equal(missing.links[0].running,false);assert.equal(missing.messages[1].length,1);
    assert.equal(missing.states[0].some(state=>state.phase==='delivered'),false);
  } finally {missing.close();}
  const stopped=pair({drop:()=>true});
  try {
    await startBoth(stopped,{mode:'clear',text:'Stop clear retries'},{mode:'clear'});
    await until(()=>stopped.packets.length>0);stopped.a.stop();stopped.b.stop();
    const count=stopped.packets.length;await delay(80);
    assert.equal(stopped.packets.length,count);assert.equal(stopped.messages[1].length,0);
    assert.equal(stopped.a.state.phase,'stopped');assert.equal(stopped.links[0].running,false);
  } finally {stopped.close();}
});

test('cleartext wire validates checksum, grammar, Unicode, lengths and independent transfer IDs',async()=>{
  const first=await encodeClearData('x'.repeat(96)),second=await encodeClearData('x'.repeat(96));
  assert.equal(first.length,127);
  const a=await decodeClearPacket(first),b=await decodeClearPacket(second);
  assert.equal(a.text,'x'.repeat(96));assert.equal(sameClearTransfer(a,b),false);
  for(const kind of ['ack','fin']) {
    const control=clearControl(first,kind),record=await decodeClearPacket(control);
    assert.equal(control.length,31);assert.equal(record.kind,kind);assert.equal(sameClearTransfer(a,record),true);
    await assert.rejects(decodeClearPacket(Uint8Array.from([...control,0])));
  }
  for(const text of ['','x'.repeat(97),'\ud800']) await assert.rejects(encodeClearData(text));
  for(const offset of [0,1,2,4,16,31]) {
    const corrupt=first.slice();corrupt[offset]^=0x40;await assert.rejects(decodeClearPacket(corrupt));
  }
  await assert.rejects(decodeClearPacket(first.slice(0,31)));
  // Check strict UTF-8 independently of checksum validation.
  const invalid=await encodeClearData('x');invalid[31]=0xff;
  const domain=new TextEncoder().encode('audio-text-lab/clear/v1\0');
  const digest=await crypto.subtle.digest('SHA-256',Uint8Array.from([...domain,...invalid.slice(3,15),0xff]));
  invalid.set(new Uint8Array(digest).slice(0,16),15);
  await assert.rejects(decodeClearPacket(invalid));
});

test('a decoded competing sender reports the role conflict instead of negotiating over it',async()=>{
  for(const [mode,cryptoProfile] of [['message','p256'],['message','x25519'],['clear','p256']]) {
    const p=pair({drop:()=>true});
    try {
      await startBoth(p,{mode,cryptoProfile,text:'First sender'},{mode,cryptoProfile,text:'Second sender'});
      await until(()=>p.packets.some(packet=>packet.side===0) && p.packets.some(packet=>packet.side===1));
      const first=p.packets.find(packet=>packet.side===0).packet,second=p.packets.find(packet=>packet.side===1).packet;
      await Promise.all([p.a.receive([second]),p.b.receive([first])]);
      assert.equal(p.a.state.phase,'error');assert.equal(p.b.state.phase,'error');
      assert.match(p.a.state.status,/Both devices are sending/);assert.match(p.b.state.status,/Both devices are sending/);
      assert.equal(p.messages[0].length+p.messages[1].length,0);
      assert.equal(p.links[0].running,false);assert.equal(p.links[1].running,false);
    } finally {p.close();}
  }
});

test('untrusted frames, reflections, and a wrong peer cannot skip confirmation or mark delivery',async()=>{
  const p=pair();
  try {
    await startBoth(p,{verifyPeer:true},{verifyPeer:true});
    await until(()=>p.a.state.phase==='verify' && p.b.state.phase==='verify');
    const ownOffer=p.packets.find(packet=>packet.label==='offer').packet;
    await p.a.receive([ownOffer,Uint8Array.of(0,...new TextEncoder().encode('injected')),Uint8Array.of(0xa7,2,3,0)]);
    assert.equal(p.a.state.phase,'verify');assert.equal(p.a.state.active,true);
    assert.equal(p.messages[1].length,0);
    assert.equal(p.a.state.peerVerified,false);
    await Promise.all([p.a.confirm(),p.b.confirm()]);await delivered(p);
  } finally {p.close();}
});

test('permission denial and local playback failure close media and surface errors',async()=>{
  const denied=pair({open:async()=>{throw new DOMException('Permission denied','NotAllowedError');}});
  try {
    await denied.a.start({text:'Dummy'});
    assert.equal(denied.a.state.phase,'error');assert.match(denied.a.state.status,/Permission denied/);
    assert.equal(denied.links[0].running,false);
  } finally {denied.close();}
  const playback=pair({failSend:label=>label==='answer'});
  try {
    await startBoth(playback);await until(()=>playback.b.state.phase==='error');
    assert.match(playback.b.state.status,/playback failure/);
    assert.equal(playback.links[1].running,false);
  } finally {playback.close();}
});

test('Stop cancels opening, queued crypto, retries and future message delivery',async()=>{
  let release, openings=0;
  const p=pair({open:side=>side===0 && openings++===0?new Promise(resolve=>{release=resolve;}):Promise.resolve()});
  try {
    const starting=p.a.start({text:'Discarded dummy'});p.a.stop();release();await starting;
    assert.equal(p.a.state.phase,'stopped');assert.equal(p.a.state.active,false);
    await delay(40);assert.equal(p.packets.length,0);
    await p.a.start({text:'Restarted dummy'});await p.b.start({text:'',verifyPeer:true});
    await until(()=>p.b.state.phase==='verify');p.a.stop();p.b.stop();
    const count=p.packets.length;await delay(70);
    assert.equal(p.packets.length,count);assert.equal(p.messages[1].length,0);
  } finally {p.close();}
});

test('bounded attempts and overall verification timeout stop the microphone',async()=>{
  const lonely=pair({timingOverride:{maxAttempts:2,maxRunMs:250}});
  try {
    await lonely.a.start({text:'Nobody listening'});await until(()=>lonely.a.state.phase==='error');
    assert.equal(lonely.links[0].running,false);
  } finally {lonely.close();}
  const waiting=pair({timingOverride:{maxRunMs:100}});
  try {
    await startBoth(waiting,{verifyPeer:true},{verifyPeer:true});
    await until(()=>!waiting.a.state.active && !waiting.b.state.active);
    assert.equal(waiting.messages[1].length,0);
    assert.equal(waiting.links[0].running,false);assert.equal(waiting.links[1].running,false);
  } finally {waiting.close();}
});
