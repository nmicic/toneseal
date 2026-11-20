// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// A virtual wall clock drives real controller/session validation. Audio I/O is
// substituted; local sends, noise and replays must not become peer liveness.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AutoTransfer, DEFAULT_PEER_IDLE_TIMEOUT_MS} from '../web/auto-transfer.mjs';
import {ChatTransfer} from '../web/chat-transfer.mjs';
import {AudioSession} from '../web/session.mjs';
import {encodeClearData, clearControl} from '../web/clear-session.mjs';
import {installProtocolClock} from './protocol-clock.mjs';

const clocks = new WeakMap();
function clock(t) { clocks.set(t,installProtocolClock(t)); }
async function advance(t,milliseconds) {
  const drain=clocks.get(t);
  await drain();
  t.mock.timers.tick(milliseconds);
  // Run zero-delay turnarounds at this clock position.
  for (let i=0;i<6;i++) {await drain();t.mock.timers.tick(0);}
}
async function settle(t, promise) {
  let done=false,value,error;
  promise.then(result=>{done=true;value=result;},failure=>{done=true;error=failure;});
  for(let i=0;i<200&&!done;i++)await advance(t,0);
  if(error)throw error;
  assert.equal(done,true,'Operation settles without advancing the response deadline');
  return value;
}
function controller(t, options={}) {
  let link;
  const events=[],sent=[],messages=[];
  const transfer=new AutoTransfer({now:()=>Date.now(),
    timing:{retryMs:50,retryJitterMs:0,turnaroundMs:0,initialDelayMs:0,maxAttempts:10000,...options.timing},
    onChange:state=>events.push(state),onMessage:message=>messages.push(message),
    transportFactory:callbacks=>(link={running:false,callbacks,
      async start(){this.running=true;},
      async send(packet){sent.push(packet.slice());},
      stop(){this.running=false;},
    }),
  });
  t.after(()=>transfer.stop());
  return {transfer,events,sent,messages,get link(){return link;}};
}

test('peer timeout defaults to one minute, validates before capture, and remains wall-clock on Telephone',async t=>{
  clock(t);const p=controller(t);
  for(const value of [0,999,3600001,NaN,Infinity,'60000',60000.5]) {
    await assert.rejects(p.transfer.start({idleTimeoutMs:value}),/timeout/);
    assert.equal(p.link,undefined,'Invalid choice cannot open audio');
  }
  await p.transfer.start({profile:'telephone'});
  assert.equal(p.transfer.state.peerIdle.timeoutMs,DEFAULT_PEER_IDLE_TIMEOUT_MS);
  assert.equal(p.transfer.state.peerIdle.remainingMs,60000);
  assert.equal(p.transfer.state.peerIdle.lastPeerAgeMs,null);
  await advance(t,59999);assert.equal(p.transfer.state.active,true);
  await advance(t,1);assert.equal(p.transfer.state.active,false);assert.equal(p.link.running,false);
  assert.match(p.transfer.state.status,/No new peer response for 60 seconds/);
  assert.equal(p.transfer.state.peerIdle.remainingMs,null);assert.equal(p.transfer._timers.size,0);
});

test('local retries, own echoes, noise and foreign packets never renew peer timeout',async t=>{
  clock(t);const p=controller(t);
  await p.transfer.start({mode:'clear',text:'Dummy timeout message',idleTimeoutMs:1000});
  const foreignReceipt=clearControl(await encodeClearData('Another sender'),'ack');
  await advance(t,0);
  for(let i=0;i<9;i++) {
    await advance(t,100);
    p.link.callbacks.onMetrics({inputPeak:1,crcRejected:50,rxFrames:50});
    await settle(t,p.transfer.receive([new Uint8Array([1,2,3]),p.sent[0],foreignReceipt]));
  }
  assert.ok(p.sent.length>2,'Real controller retries occurred');
  assert.equal(p.transfer.state.peerIdle.lastPeerAgeMs,null);
  await advance(t,99);assert.equal(p.transfer.state.active,true);
  await advance(t,1);assert.equal(p.transfer.state.phase,'error');assert.equal(p.link.running,false);
});

test('new valid clear data renews deadline once, duplicates do not, and received content stays received',async t=>{
  clock(t);const p=controller(t);
  await p.transfer.start({mode:'clear',idleTimeoutMs:1000});
  await advance(t,900);
  const packet=await encodeClearData('Byte-exact retained result');
  await settle(t,p.transfer.receive([packet]));
  assert.deepEqual(p.messages,[{type:'clear',text:'Byte-exact retained result'}]);
  assert.equal(p.transfer.state.peerIdle.lastPeerAgeMs,0);
  await advance(t,900);assert.equal(p.transfer.state.active,true,'Earlier deadline was cancelled');
  await settle(t,p.transfer.receive([packet,await encodeClearData('A different transfer')]));
  assert.equal(p.transfer.state.peerIdle.lastPeerAgeMs,900);
  await advance(t,100);assert.equal(p.transfer.state.active,false);
  assert.equal(p.transfer.state.phase,'received');assert.equal(p.messages.length,1);
  assert.equal(p.link.running,false);
});

test('fingerprint confirmation remains bounded and replayed offers cannot hold the microphone open',async t=>{
  clock(t);const p=controller(t),peer=new AudioSession();
  t.after(()=>peer.reset());
  await p.transfer.start({verifyPeer:true,idleTimeoutMs:1000});
  await advance(t,800);
  const offer=await peer.offer();
  await settle(t,p.transfer.receive([offer]));
  assert.equal(p.transfer.state.phase,'verify');
  await advance(t,800);
  await settle(t,p.transfer.receive([offer]));
  assert.equal(p.transfer.state.peerIdle.lastPeerAgeMs,800);
  await advance(t,200);
  assert.equal(p.transfer.state.active,false);assert.equal(p.messages.length,0);
  assert.match(p.transfer.state.status,/No new peer response/);
});

test('Stop cancels the old deadline and a new run receives its complete response window',async t=>{
  clock(t);const p=controller(t);
  await p.transfer.start({idleTimeoutMs:1000});
  await advance(t,600);p.transfer.stop();
  assert.equal(p.transfer._timers.size,0);assert.equal(p.link.running,false);
  await p.transfer.start({idleTimeoutMs:1000});
  await advance(t,400);assert.equal(p.transfer.state.active,true);
  await advance(t,599);assert.equal(p.transfer.state.active,true);
  await advance(t,1);assert.equal(p.transfer.state.active,false);
});

async function chatPair(t) {
  clock(t);
  const links=[],deliveries=[[],[]],records=[];
  const channel={blocked:false,dropData:false};
  const peers=[0,1].map(side=>new ChatTransfer({now:()=>Date.now(),
    timing:{retryMs:100,retryJitterMs:0,turnaroundMs:5,initialDelayMs:2,maxAttempts:100,
      turnTimeoutMs:200,idlePollMs:30,maxIdlePollMs:60,maxRunMs:20000},
    onDelivery:delivery=>deliveries[side].push(delivery),
    transportFactory:callbacks=>(links[side]={running:false,callbacks,
      async start(){this.running=true;},stop(){this.running=false;},
      async send(packet){
        records.push({side,packet:packet.slice()});
        const peer=links[1-side];
        const data=packet[2]===3 && new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false)<0x80000000;
        if(!channel.blocked && !(channel.dropData && data) && peer?.running)queueMicrotask(()=>peer.callbacks.onPackets([packet.slice()]));
      },
    }),
  }));
  t.after(()=>peers.forEach(peer=>peer.stop()));
  await peers[1].start({idleTimeoutMs:1000});
  await peers[0].start({text:'A confirmed chat message',idleTimeoutMs:1000});
  for(let i=0;i<50&&!deliveries[0].length;i++)await advance(t,20);
  assert.equal(deliveries[0].length,1);
  assert.ok(peers.every(peer=>peer.state.connected));
  return {peers,links,deliveries,records,channel};
}

test('fresh authenticated empty turns prove liveness, but silence or replay still expires the peer clock',async t=>{
  const {peers,links,deliveries,records,channel}=await chatPair(t);
  for(let i=0;i<20;i++)await advance(t,20);
  assert.ok(peers.every(peer=>peer.state.active),'Empty authenticated turns renew the deadline');
  assert.ok(peers.every(peer=>peer.state.chatStats.turns>2));
  channel.blocked=true;
  const captured=records.filter(record=>record.packet.length===51).slice(-4);
  for(let i=0;i<60;i++) {
    for(const {side,packet} of captured)peers[1-side].receive([packet]);
    await advance(t,20);
  }
  assert.ok(peers.every(peer=>!peer.state.active));
  assert.ok(links.every(link=>!link.running));
  assert.equal(deliveries[0].length,1,'Previously confirmed delivery remains confirmed');
  for(const peer of peers)assert.match(peer.state.status,/No new peer response.*without delivery receipts remain unconfirmed/);
});

test('quiet chat closes both peers despite keepalives and releases every resource',async t=>{
  const {peers,links,deliveries}=await chatPair(t);
  for(let i=0;i<80 && peers.some(peer=>peer.state.active);i++)await advance(t,20);
  assert.ok(peers.every(peer=>!peer.state.active));
  assert.ok(peers.some(peer=>peer.state.close.reason==='message-idle'));
  for(const peer of peers) {
    assert.equal(peer.state.phase,'closed');assert.equal(peer.state.close.outcome,'confirmed');
    assert.ok(peer.state.chatStats.turns>5,'Keepalives continued until the message deadline');
    assert.equal(peer.state.messageIdle.remainingMs,null);assert.equal(peer._timers.size,0);
    assert.equal(peer._session.info.state,'idle');
  }
  assert.ok(links.every(link=>!link.running));assert.equal(deliveries[0].length,1);
});

test('a new message and its receipt renew the chat inactivity window in either direction',async t=>{
  const {peers,deliveries}=await chatPair(t);
  for(const side of [1,0]) {
    for(let i=0;i<30;i++)await advance(t,20);
    const before=deliveries[side].length;
    await settle(t,peers[side].enqueue(`New message from ${side}`));
    for(let i=0;i<30 && deliveries[side].length===before;i++)await advance(t,20);
    assert.equal(deliveries[side].length,before+1);
    assert.ok(peers.every(peer=>peer.state.messageIdle.remainingMs>800 || peer.state.messageIdle.waitingForReceipts));
    assert.ok(peers.every(peer=>peer.state.active && !peer.state.closing));
  }
  for(let i=0;i<80 && peers.some(peer=>peer.state.active);i++)await advance(t,20);
  assert.ok(peers.every(peer=>peer.state.close.outcome==='confirmed'));
});

test('message idle countdown pauses for lost DATA and restarts after byte-exact delivery',async t=>{
  const {peers,deliveries,channel}=await chatPair(t);
  channel.dropData=true;
  await settle(t,peers[0].enqueue('Delivery must finish before idle closing.'));
  for(let i=0;i<80;i++)await advance(t,20);
  assert.ok(peers.every(peer=>peer.state.active && !peer.state.closing));
  assert.equal(peers[0].state.messageIdle.waitingForReceipts,true);
  assert.equal(peers[0].state.messageIdle.remainingMs,null);
  channel.dropData=false;
  for(let i=0;i<40 && deliveries[0].length<2;i++)await advance(t,20);
  assert.equal(deliveries[0].length,2);
  for(let i=0;i<80 && peers.some(peer=>peer.state.active);i++)await advance(t,20);
  assert.ok(peers.every(peer=>peer.state.close.outcome==='confirmed'));
});

test('one-hour timeout reaches the audio transport and survives the normal session ceiling',async t=>{
  clock(t);const p=controller(t);
  await p.transfer.start({idleTimeoutMs:3600000});
  assert.equal(p.transfer.state.lifetimeMs,7200000);
  assert.equal(p.link.callbacks.maxRunMs,7200000);
  await advance(t,180001);assert.equal(p.transfer.state.active,true);
  await advance(t,3419998);assert.equal(p.transfer.state.active,true);
  await advance(t,1);assert.equal(p.transfer.state.active,false);
  assert.match(p.transfer.state.status,/No new peer response for 3600 seconds/);
  assert.equal(p.transfer._timers.size,0);assert.equal(p.link.running,false);
});
