// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {protocolTest as test} from './protocol-clock.mjs';
import {ChatTransfer} from '../web/chat-transfer.mjs';
import {AudioSession} from '../web/session.mjs';

const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,limit=4000) {
  const stop=Date.now()+limit;
  while(!predicate()) { if(Date.now()>stop)throw Error('Chat test condition timed out');await wait(2); }
}
const bytesKey = bytes => Buffer.from(bytes).toString('hex');
const counter = packet => new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false);
const timings = {retryMs:90,retryJitterMs:0,turnaroundMs:5,initialDelayMs:2,turnTimeoutMs:100,idlePollMs:20,maxIdlePollMs:50,maxRunMs:6000,maxAttempts:5,closeTimeoutMs:2000,closeLingerMs:260,closeMaxAttempts:3};
function pair({drop=()=>false,delay=0,duplicate=false,options={}}={}) {
  const links=[],messages=[[],[]],deliveries=[[],[]],packets=[],states=[[],[]];
  const closePackets=new Map();
  let collisions=0,epoch=null,blocked=false;
  const controllers=[0,1].map(side=>new ChatTransfer({timing:timings,...options,
    onChange:state=>states[side].push(state),onMessage:message=>messages[side].push(message),onDelivery:record=>deliveries[side].push(record),
    transportFactory:callbacks=>{
      const link={callbacks,playing:false,running:false,
        async start(){this.running=true;},
        async send(packet){
          if(!this.running)throw new DOMException('Stopped','AbortError');
          this.playing=true;
          if(links[1-side]?.playing)collisions++;
          const sequence=packet.length>=15?counter(packet):0;
          let kind=packet[2]===1?'offer':packet[2]===2?'answer':'control';
          if(kind==='control'){
            epoch??=bytesKey(packet.subarray(3,11));
            if(sequence<0x80000000)kind='data';
            else if(packet.length===51&&bytesKey(packet.subarray(3,11))!==epoch)kind=side===0?'poll':'response';
          }
          const close=closePackets.get(bytesKey(packet));
          const record={side,kind,close,packet:packet.slice(),sequence,ordinal:packets.filter(item=>item.side===side&&item.kind===kind).length+1,
            closeOrdinal:packets.filter(item=>item.side===side&&item.close===close).length+1};packets.push(record);
          await wait(2);
          if(!this.running)throw new DOMException('Stopped','AbortError');
          const peer=links[1-side];
          if(!blocked&&!drop(record)&&peer?.running&&!peer.playing){
            const deliver=()=>{if(peer.running)peer.callbacks.onPackets(duplicate?[packet.slice(),packet.slice()]:[packet.slice()]);};
            if(delay)setTimeout(deliver,delay);else queueMicrotask(deliver);
          }
          this.playing=false;
        },stop(){this.running=false;this.playing=false;}};
      links[side]=link;return link;
    },
  }));
  for(const controller of controllers) {
    const create=controller._createSession.bind(controller);
    controller._createSession=profile=>{
      const session=create(profile),turn=session.turn.bind(session);
      session.turn=async options=>{const packet=await turn(options);closePackets.set(bytesKey(packet),options.close||'open');return packet;};
      return session;
    };
  }
  return {a:controllers[0],b:controllers[1],controllers,links,messages,deliveries,packets,states,
    get collisions(){return collisions;},set blocked(value){blocked=value;},
    close(){controllers.forEach(peer=>peer.stop());}};
}
async function pausePolling(p) {
  // The receiver updates its turn before returning the reply. Pause only once
  // that reply reaches the initiator and its next poll has been scheduled.
  await until(()=>p.a._nextPollTimer!==undefined && !p.b._sendingTurn);
  p.a._clearTimer(p.a._nextPollTimer);
  p.a._nextPollTimer=undefined;
}
async function start(p,a={},b={}) {
  await p.b.start({text:'',...b});await p.a.start({text:'First chat message',...a});
  await until(()=>p.deliveries[0].length===1||p.controllers.some(peer=>peer.state.phase==='error'));
  assert.equal(p.a.state.connected,true,p.a.state.status);assert.equal(p.b.state.connected,true,p.b.state.status);
}
async function sessionPair(profile='p256',purpose='chat') {
  const a=new AudioSession({cryptoProfile:profile,purpose}),b=new AudioSession({cryptoProfile:profile,purpose});
  const offer=await a.offer(),answer=await b.receive(offer);await a.receive(answer.outbound);
  const readyA=await a.confirm(),readyB=await b.confirm();await a.receive(readyB);await b.receive(readyA);
  return {a,b,offer};
}

test('chat wire uses separate cryptographic purpose and rejects ordinary sessions',async()=>{
  for(const profile of ['p256','x25519']) {
    const p=await sessionPair(profile);assert.equal(p.offer[1],profile==='p256'?6:7);
    const legacy=p.offer.slice();legacy[1]-=2;
    const fresh=new AudioSession({cryptoProfile:profile,purpose:'chat'});
    await assert.rejects(fresh.receive(legacy),/Unsupported/);assert.equal(fresh.info.state,'idle','Old v4/v5 chat cannot start the close-capable protocol');fresh.reset();
    const ordinary=new AudioSession({cryptoProfile:profile});await assert.rejects(ordinary.receive(p.offer),/Unsupported/);
    await assert.rejects(p.a.receive(await ordinary.offer()),/Unsupported/);
    await assert.rejects(ordinary.turn({number:1}),/chat session/);
    const message=await p.a.send('message','chat only');
    const result=await p.b.receive(message);assert.equal(result.text,'chat only');assert.equal(result.outbound,undefined);
    const poll=await p.a.turn({number:1,pending:true});assert.equal(poll.length,51);
    assert.equal((await p.b.receive(poll)).type,'chat-turn');
    const response=await p.b.turn({reply:true,number:1});
    assert.deepEqual((await p.a.receive(response)).acknowledged,[1]);assert.equal(p.a.info.pendingCount,0);
    assert.equal((await p.a.receive(response)).duplicate,true);
    p.a.reset();p.b.reset();ordinary.reset();
  }
});

test('chat turns validate role, grammar, receipts and sequence-space isolation transactionally',async()=>{
  const {a,b}=await sessionPair();
  const original=await a.turn({number:1});
  assert.equal((await b.receive(original)).number,1);
  const invalid=new Uint8Array(19);invalid[0]=2;invalid[1]=1;new DataView(invalid.buffer).setUint32(2,2,false);
  const wrongRole=await a._serial(()=>a._seal(a._current,7,invalid));
  await assert.rejects(b.receive(wrongRole),/role/);
  invalid[1]=0;invalid[0]=1;
  await assert.rejects(b.receive(await a._serial(()=>a._seal(a._current,7,invalid))),/Invalid chat turn/);
  invalid[0]=2;new DataView(invalid.buffer).setUint32(7,1,false);invalid[11]=1;
  await assert.rejects(b.receive(await a._serial(()=>a._seal(a._current,7,invalid))),/unsent/);
  for(const number of [0,-1,0x80000000,1.1])await assert.rejects(a.turn({number}),/Invalid/);
  await assert.rejects(a.turn({number:2,pending:1}),/Invalid/);
  await b.receive(await a.turn({number:2}));
  a.reset();b.reset();
});

test('chat rejects invisible password data and standalone ACKs; rekey retires turn replay cache',async()=>{
  const {a,b}=await sessionPair();
  await assert.rejects(a.send('password','Not a transcript item'),/Message/);
  const password=await a._serial(()=>a._seal(a._current,2,new TextEncoder().encode('hidden')));
  await assert.rejects(b.receive(password),/Unsupported record/);
  assert.equal(b._current.rxHigh,0,'Rejected password cannot appear in a chat receipt bitmap');
  const message=await a.send('message','Pending until a real turn');
  await b.receive(message);
  const ordinaryAck=await b._serial(()=>b._receipt(b._current,2));
  await assert.rejects(a.receive(ordinaryAck),/Unsupported record/);assert.equal(a.info.pendingCount,1);
  const oldPoll=await a.turn({number:1,pending:true});await b.receive(oldPoll);
  await a.receive(await b.turn({number:1,reply:true}));assert.equal(a.info.pendingCount,0);
  const answer=await b.receive(await a.rekey()),commit=await a.receive(answer.outbound),final=await b.receive(commit.outbound);await a.receive(final.outbound);
  await assert.rejects(b.receive(oldPoll),/another session/);
  assert.equal((await b.receive(await a.turn({number:1}))).number,1);
  a.reset();b.reset();
});

test('chat pairs/rekeys once, then both peers send exact Unicode in the same session',async()=>{
  for(const cryptoProfile of ['p256','x25519']){
    const p=pair();
    try{
      await start(p,{cryptoProfile},{cryptoProfile});
      const fingerprint=p.a.state.fingerprint;
      const later=await Promise.all([p.a.enqueue('A second é 🗝️'),p.b.enqueue('B reply <b>literal</b>')]);
      assert.deepEqual(later,[{counter:2},{counter:1}]);
      await until(()=>p.deliveries[0].length===2&&p.deliveries[1].length===1);
      assert.deepEqual(p.messages[1].map(x=>x.text),['First chat message','A second é 🗝️']);
      assert.deepEqual(p.messages[0].map(x=>x.text),['B reply <b>literal</b>']);
      assert.equal(p.a.state.fingerprint,fingerprint);assert.equal(p.b.state.fingerprint,fingerprint);
      assert.equal(new Set(p.packets.filter(x=>x.kind==='offer').map(x=>bytesKey(x.packet))).size,1);
      assert.equal(p.a.state.active,true);assert.equal(p.b.state.active,true);assert.equal(p.collisions,0);
      assert.equal(p.a.state.chatStats.delivered,2);assert.equal(p.b.state.chatStats.delivered,1);
    }finally{p.close();}
  }
});

test('both humans must verify before chat data or turn grants start',async()=>{
  const p=pair();
  try{
    await p.b.start({verifyPeer:true});await p.a.start({text:'Verified conversation',verifyPeer:true});
    await until(()=>p.a.state.phase==='verify'&&p.b.state.phase==='verify');
    await p.a.confirm();await wait(30);assert.equal(p.messages.flat().length,0);assert.equal(p.a.state.canSend,false);
    await p.b.confirm();await until(()=>p.deliveries[0].length===1);
    assert.equal(p.a.state.peerVerified,true);assert.equal(p.b.state.peerVerified,true);
    assert.equal(p.messages[1][0].text,'Verified conversation');
  }finally{p.close();}
});

test('lost data, poll, response and receiver data repair exactly without duplicate display',async()=>{
  for(const [side,kind] of [[0,'data'],[0,'poll'],[1,'response'],[1,'data']]){
    const p=pair({duplicate:true,drop:r=>r.side===side&&r.kind===kind&&r.ordinal===1});
    try{
      await start(p);await p.b.enqueue('Receiver can send after a lost frame');
      await until(()=>p.deliveries[1].length===1);
      assert.equal(p.messages[1].length,1);assert.equal(p.messages[0].length,1);
      const records=p.packets.filter(r=>r.side===side&&r.kind===kind);
      assert.ok(records.length>=2);
      if(kind!=='data'||side===1)assert.equal(bytesKey(records[0].packet),bytesKey(records[1].packet),'lost turn/data retained exactly');
      assert.equal(p.collisions,0);
    }finally{p.close();}
  }
});

test('eight-message backpressure keeps admitted bytes and restores room after receipts',async()=>{
  const p=pair();
  try{
    await start(p);p.blocked=true;
    const admitted=await Promise.all(Array.from({length:8},(_,i)=>p.b.enqueue(`Queued ${i}`)));
    assert.equal(new Set(admitted.map(x=>x.counter)).size,8);
    assert.equal(p.b.state.pendingCount,8);assert.equal(p.b.state.canSend,false);
    await assert.rejects(p.b.enqueue('Keep this draft'),/Eight/);
    assert.equal(p.b._session.pending().length,8);
    p.blocked=false;
    await until(()=>p.deliveries[1].length===8);
    assert.deepEqual(p.messages[0].map(x=>x.text),Array.from({length:8},(_,i)=>`Queued ${i}`));
    assert.equal(p.b.state.canSend,true);assert.equal(p.b.state.pendingCount,0);
  }finally{p.close();}
});

test('idle polling backs off and newly queued data resumes without fresh keys',async()=>{
  const p=pair({options:{timing:{...timings,idlePollMs:35,maxIdlePollMs:120}}});
  try{
    await start(p);await wait(250);assert.ok(p.a._idleRounds>=2);
    const mark=p.packets.length;const identity=p.a.state.fingerprint;
    await p.a.enqueue('Wake up');await until(()=>p.deliveries[0].length===2);
    assert.equal(p.messages[1].at(-1).text,'Wake up');assert.equal(p.a.state.fingerprint,identity);
    assert.equal(p.packets.slice(mark).some(r=>r.kind==='offer'||r.kind==='answer'),false);
  }finally{p.close();}
});

test('replayed old turns and arbitrary input cannot grant a new response or restart a session',async()=>{
  const p=pair();
  try{
    await start(p);const old=p.packets.find(r=>r.kind==='poll').packet.slice();
    await until(()=>p.b.state.turn>=3);
    // Freeze only the initiator clock so there is no unrelated valid poll.
    await pausePolling(p);
    const replies=p.packets.filter(r=>r.side===1).length;
    await p.b.receive([old,Uint8Array.of(0xa7,6,3,1)]);await wait(15);
    assert.equal(p.packets.filter(r=>r.side===1).length,replies);
    assert.equal(p.b.state.connected,true);assert.equal(p.messages[1].length,1);
  }finally{p.close();}
});

test('old handshake replays and unsolicited rekey cannot transmit outside a chat turn',async()=>{
  const p=pair();
  try{
    await start(p);
    await pausePolling(p);
    const handshake=p.packets.filter(record=>record.kind!=='data'&&record.kind!=='poll'&&record.kind!=='response');
    const before=p.packets.length;
    for(const record of handshake)await p.controllers[1-record.side].receive([record.packet]);
    const request=await p.b._session._serial(()=>p.b._session._seal(p.b._session._current,5));
    await p.a.receive([request]);
    await assert.rejects(p.b._session.rekey(),/new chat connection/);
    await wait(15);assert.equal(p.packets.length,before,'No handshake response may interrupt granted chat turns');
    assert.equal(p.a.state.connected,true);assert.equal(p.b.state.connected,true);
    assert.equal(p.messages[1].length,1);
  }finally{p.close();}
});

test('competing initial senders stop with a clear role conflict',async()=>{
  const p=pair({options:{timing:{...timings,maxRunMs:700}}});
  try{
    await Promise.all([p.a.start({text:'A first'}),p.b.start({text:'B first'})]);
    await until(()=>p.controllers.some(peer=>!peer.state.active));
    assert.equal(p.deliveries.flat().length,0);
    assert.ok(p.states.flat().some(state=>/Both devices are sending/.test(state.status)));
  }finally{p.close();}
});

test('one-way silence and total lifetime stop capture without declaring queued data delivered',async()=>{
  const p=pair({options:{timing:{...timings,maxAttempts:2,turnTimeoutMs:45,maxRunMs:700}}});
  try{
    await start(p);p.blocked=true;await p.a.enqueue('Will remain unconfirmed');
    await until(()=>!p.a.state.active);
    assert.equal(p.a.state.phase,'error');assert.equal(p.deliveries[0].length,1);assert.equal(p.links[0].running,false);
    await until(()=>!p.b.state.active);assert.equal(p.links[1].running,false);
  }finally{p.close();}
});

test('Stop invalidates queued crypto, erases pending data, and cannot emit later callbacks',async()=>{
  const p=pair();
  try{
    await start(p);const pending=p.b.enqueue('Stop before admitting this');p.b.stop();
    await assert.rejects(pending,/reset|stopped/i);
    assert.equal(p.b.state.connected,false);assert.equal(p.b.state.canSend,false);
    assert.equal(p.b._session.info.state,'idle');assert.equal(p.b._session.pending().length,0);
    const total=p.deliveries.flat().length;await wait(40);assert.equal(p.deliveries.flat().length,total);
    assert.equal(p.links[1].running,false);
  }finally{p.close();}
});

test('chat refuses invalid content and options before enqueue/audio',async()=>{
  assert.throws(()=>new ChatTransfer({timing:{maxRunMs:600001}}),/ten minutes/);
  const p=pair();
  try{
    await assert.rejects(p.a.start({mode:'password',text:'secret'}),/Message/);assert.equal(p.links.length,0);
    await start(p);
    for(const text of ['', 'x'.repeat(97), '\ud800', null])await assert.rejects(p.a.enqueue(text),/message|valid text/i);
    assert.equal(p.a.state.pendingCount,0);
  }finally{p.close();}
});

test('either side and simultaneous close drain and finish with authenticated outcomes',async()=>{
  for(const cryptoProfile of ['p256','x25519'])for(const requester of ['a','b','both']){
    const p=pair();
    try{
      await start(p,{cryptoProfile},{cryptoProfile});
      if(requester==='both'){p.a.close();p.b.close();}else p[requester].close();
      assert.equal(p[requester==='b'?'b':'a'].state.canSend,false);
      await until(()=>p.controllers.every(peer=>!peer.state.active));
      for(const peer of p.controllers){assert.equal(peer.state.phase,'closed');assert.equal(peer.state.close.outcome,'confirmed');assert.equal(peer.state.pendingCount,0);assert.equal(peer.state.closing,false);assert.equal(peer._session.info.state,'idle');}
      assert.equal(p.a.state.close.peerAckSeen,true);assert.equal(p.b.state.close.finalSeen,true);
      assert.equal(p.a.state.close.initiator,requester==='b'?'peer':'local');
      assert.equal(p.b.state.close.initiator,requester==='a'?'peer':'local');
      assert.equal(p.links.every(link=>!link.running),true);assert.equal(p.collisions,0);
      assert.ok(p.packets.filter(row=>['drain','commit','ack','final'].includes(row.close)).every(row=>row.packet.length===51));
      assert.equal(p.packets.filter(row=>row.close==='final').length,1);
    }finally{p.close();}
  }
});

test('close freezes new admission but finishes all sixteen reserved messages in both directions',async()=>{
  const p=pair();
  try{
    await start(p);
    const jobs=[];
    for(let i=0;i<8;i++){jobs.push(p.a.enqueue(`A queued ${i} é`));jobs.push(p.b.enqueue(`B queued ${i} 🔐`));}
    p.b.close();
    await assert.rejects(p.b.enqueue('Too late'),/closing/);
    assert.equal((await Promise.all(jobs)).length,16,'Reserved crypto operations are honored');
    await until(()=>p.controllers.every(peer=>!peer.state.active));
    assert.equal(p.deliveries[0].length,9);assert.equal(p.deliveries[1].length,8);
    assert.deepEqual(p.messages[0].map(item=>item.text),Array.from({length:8},(_,i)=>`B queued ${i} 🔐`));
    assert.deepEqual(p.messages[1].slice(1).map(item=>item.text),Array.from({length:8},(_,i)=>`A queued ${i} é`));
    assert.equal(p.controllers.every(peer=>peer.state.close.outcome==='confirmed'&&peer.state.close.pendingAtEnd===0),true);
    assert.equal(p.collisions,0);
  }finally{p.close();}
});

test('lost drain, commit, acknowledgement and final records produce exact bounded recovery',async()=>{
  for(const [side,close] of [[0,'drain'],[1,'drain'],[0,'commit'],[1,'ack'],[0,'final']]){
    const p=pair({drop:row=>row.side===side&&row.close===close&&row.closeOrdinal===1});
    try{
      await start(p);p.a.close();await until(()=>p.controllers.every(peer=>!peer.state.active));
      assert.equal(p.a.state.close.outcome,'confirmed');
      assert.equal(p.b.state.close.outcome,close==='final'?'unconfirmed':'confirmed');
      assert.equal(p.a.state.close.peerAckSeen,true);assert.equal(p.b.state.close.finalSeen,close!=='final');
      const flights=p.packets.filter(row=>row.side===side&&row.close===close);
      if(close!=='final'){assert.ok(flights.length>=2);assert.equal(bytesKey(flights[0].packet),bytesKey(flights[1].packet),'Retransmission preserves ciphertext/nonce/receipt snapshot');}
      else assert.equal(flights.length,1,'Final is sent once; missing final is reported honestly by responder');
      assert.equal(p.messages[1].length,1);assert.equal(p.deliveries[0].length,1);assert.equal(p.collisions,0);
    }finally{p.close();}
  }
});

test('all close acknowledgements lost cause unconfirmed closure on both sides with bounded attempts',async()=>{
  const p=pair({drop:row=>row.close==='ack'});
  try{
    await start(p);p.a.close();await until(()=>p.controllers.every(peer=>!peer.state.active));
    for(const peer of p.controllers){assert.equal(peer.state.close.outcome,'unconfirmed');assert.equal(peer.state.close.pendingAtEnd,0);}
    assert.equal(p.a.state.close.peerAckSeen,false);assert.equal(p.b.state.close.finalSeen,false);
    assert.equal(p.packets.filter(row=>row.close==='commit').length,3);assert.equal(p.packets.some(row=>row.close==='final'),false);
    assert.equal(p.collisions,0);
  }finally{p.close();}
});

test('close outage never promotes pending data or claims the unreachable peer closed',async()=>{
  const p=pair();
  try{
    await start(p);p.blocked=true;await p.a.enqueue('Unknown delivery');p.a.close();
    const first=p.a.state.close.remainingMs;await wait(15);p.a.close();assert.ok(p.a.state.close.remainingMs<first,'Repeated close does not extend deadline');
    await until(()=>!p.a.state.active);
    assert.equal(p.a.state.close.outcome,'unconfirmed');assert.equal(p.a.state.close.pendingAtEnd,1);
    assert.equal(p.a.state.close.peerAckSeen,false);assert.equal(p.deliveries[0].length,1);
    assert.equal(p.b.state.active,true);assert.equal(p.b.state.close.initiator,null,'Peer never heard the close request');
    assert.equal(p.links[0].running,false);
  }finally{p.close();}
});

test('force stop interrupts closing immediately and pre-pair close cannot claim notification',async()=>{
  const p=pair();
  try{
    await p.a.start({text:'Not paired'});p.a.close();
    assert.equal(p.a.state.active,false);assert.equal(p.a.state.phase,'stopped');assert.equal(p.a.state.close.outcome,'aborted');assert.equal(p.a.state.close.peerAckSeen,false);
    await start(p);p.blocked=true;await p.a.enqueue('Force stopped');p.a.close();p.a.stop();
    assert.equal(p.a.state.active,false);assert.equal(p.a.state.close.outcome,'aborted');assert.equal(p.a.state.close.pendingAtEnd,1);
    const count=p.packets.length;await wait(40);assert.equal(p.packets.length,count);
    assert.equal(p.a._session.pending().length,0);assert.equal(p.links[0].running,false);
  }finally{p.close();}
});

test('invalid close flags cannot prune receipts and the close fence rejects late data transactionally',async()=>{
  const {a,b}=await sessionPair();
  try{
    const pending=await b.send('message','Unacknowledged');await a.receive(pending);
    const invalid=new Uint8Array(19);invalid[0]=2;new DataView(invalid.buffer).setUint32(2,1,false);invalid.set(a._receiptBody(a._current,0),7);
    for(const flags of [5,6,7,9,10,255]){
      invalid[6]=flags;const before=b._current.rxControlHigh;
      await assert.rejects(b.receive(await a._serial(()=>a._seal(a._current,7,invalid))),/Invalid chat turn/);
      assert.equal(b.info.pendingCount,1);assert.equal(b._current.rxControlHigh,before);
    }
    for(const options of [{number:1,close:'unknown'},{number:1,close:'commit',pending:true},{number:1,close:'ack'},{number:1,reply:true,close:'final'}])await assert.rejects(a.turn(options),/Invalid/);
    await b.receive(await a.turn({number:1,close:'drain'}));assert.equal(b.info.pendingCount,0);
    b.lockChatData();const previous=b._current.rxHigh;
    const late=await a.send('message','Late after close fence');
    await assert.rejects(b.receive(late),/no longer accepted/);assert.equal(b._current.rxHigh,previous);
    await assert.rejects(b.send('message','Locked sending'),/close was committed/);
  }finally{a.reset();b.reset();}
});

test('authenticated out-of-order commit cannot close an open chat and old epochs remain isolated',async()=>{
  const p=pair();
  try{
    await start(p);await pausePolling(p);
    const before=p.packets.length;
    const unexpected=await p.a._session.turn({number:p.b.state.turn+1,close:'commit'});
    await p.b.receive([unexpected]);await wait(15);
    assert.equal(p.b.state.closing,false);assert.equal(p.b.state.connected,true);assert.equal(p.packets.length,before);
    assert.ok(p.b.state.chatStats.rejectedFrames>0);
    const altered=unexpected.slice();altered[altered.length-1]^=1;await p.b.receive([altered]);assert.equal(p.b.state.closing,false);
    const other=await sessionPair();await p.b.receive([await other.a.turn({number:1,close:'drain'})]);other.a.reset();other.b.reset();
    assert.equal(p.b.state.closing,false);
  }finally{p.close();}
});
