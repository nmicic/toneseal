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

const flush = () => new Promise(resolve => setImmediate(resolve));
async function advance(t, milliseconds) {
  t.mock.timers.tick(milliseconds);
  // Let WebCrypto and chained protocol work finish without consuming virtual
  // time; zero-delay turnarounds can then run at the same clock position.
  for (let i=0;i<6;i++) {await flush();t.mock.timers.tick(0);}
}
async function settle(t, promise) {
  let done=false,value,error;
  promise.then(result=>{done=true;value=result;},failure=>{done=true;error=failure;});
  for(let i=0;i<200&&!done;i++)await advance(t,0);
  if(error)throw error;
  assert.equal(done,true,'Operation settles without advancing the response deadline');
  return value;
}
function clock(t) {t.mock.timers.enable({apis:['setTimeout','Date'],now:0});}
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
  for(const value of [0,999,120001,NaN,Infinity,'60000',60000.5]) {
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

test('fresh authenticated empty chat turns keep a healthy peer alive; silence or replay then stops both sides',async t=>{
  clock(t);
  const links=[],deliveries=[[],[]],records=[];
  let blocked=false;
  const peers=[0,1].map(side=>new ChatTransfer({now:()=>Date.now(),
    timing:{retryMs:100,retryJitterMs:0,turnaroundMs:5,initialDelayMs:2,maxAttempts:100,
      turnTimeoutMs:200,idlePollMs:30,maxIdlePollMs:60,maxRunMs:20000},
    onDelivery:delivery=>deliveries[side].push(delivery),
    transportFactory:callbacks=>(links[side]={running:false,callbacks,
      async start(){this.running=true;},stop(){this.running=false;},
      async send(packet){
        records.push({side,packet:packet.slice()});
        const peer=links[1-side];
        if(!blocked&&peer?.running)queueMicrotask(()=>peer.callbacks.onPackets([packet.slice()]));
      },
    }),
  }));
  t.after(()=>peers.forEach(peer=>peer.stop()));
  await peers[1].start({idleTimeoutMs:1000});
  await peers[0].start({text:'A confirmed chat message',idleTimeoutMs:1000});
  for(let i=0;i<50&&!deliveries[0].length;i++)await advance(t,20);
  assert.equal(deliveries[0].length,1);
  assert.ok(peers.every(peer=>peer.state.connected));
  for(let i=0;i<100;i++)await advance(t,20);
  assert.ok(peers.every(peer=>peer.state.active),'Empty authenticated turns renew the deadline');
  assert.ok(peers.every(peer=>peer.state.chatStats.turns>5));
  blocked=true;
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
