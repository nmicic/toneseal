// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// UI-only browser regression for the published read-only agent contract.
// Cryptography/controllers are real; transport is synthetic encrypted frames.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const child=spawn(process.execPath,['tests/browser-room.mjs','--channel','frames','--timing','fast','--view','web','--report','out/automation-browser.json',...process.argv.slice(2)],{cwd:root,stdio:['ignore','pipe','pipe']});
let output='',stderr='',endpoints,exited=false;
child.on('exit',()=>{exited=true;});child.stdout.on('data',chunk=>{output+=chunk;try{endpoints=JSON.parse(output);}catch{}});child.stderr.on('data',chunk=>{stderr+=chunk;});
const until=async(check,label,timeout=45000)=>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const result=await check();if(result)return result;if(exited)throw Error('Harness exited: '+stderr);await delay(100);}
  throw Error('Timed out: '+label+'\n'+stderr);
};
async function request(endpoint,body){
  const response=await fetch(endpoint,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const value=await response.json();if(!response.ok)throw Error(value.error);return value;
}
const get=side=>request(endpoints[side]);
const post=(side,body)=>request(endpoints[side],body);
const state=async side=>(await get(side)).publicAgentState;
async function action(side,id,value){
  const current=await state(side),item=current.actions.find(item=>item.id===id);
  assert.ok(item,'Action is documented in public state: '+id);assert.ok(item.available,'Action is available: '+id+' / '+item.unavailableReason);
  return post(side,{action:item.operation,selector:item.selector,...(value===undefined?{}:{value})});
}
async function send(side,message){await action(side,'draft',message);await action(side,'start');}
async function freshChat(text='New close test '+randomBytes(4).toString('hex')){
  await post('admin',{action:'reset'});
  await action('bob','start');await send('alice',text);
  await until(async()=>{const peers=await Promise.all(['alice','bob'].map(state));return peers.every(peer=>peer.session.connected)&&peers[0].queue.pending===0;},'fresh connected chat');
}
async function ended(){
  await until(async()=>{const peers=await Promise.all(['alice','bob'].map(state));return peers.every(peer=>!peer.session.active);},'automatic bilateral close',15000);
  return Promise.all(['alice','bob'].map(state));
}
const secret='Test password '+randomBytes(8).toString('hex');
const first='Message '+randomBytes(8).toString('hex')+' é 🔐';
const noContent=observed=>{for(const value of [secret,first])assert.equal(JSON.stringify(observed).includes(value),false,'Public metadata omits content');};
try{
  await until(()=>endpoints,'harness ready',20000);
  for(const side of ['alice','bob']){
    const view=await get(side);assert.equal(view.publicAgentState.schemaVersion,1);
    assert.ok(view.controls.every(control=>typeof control.selector==='string'&&control.selector.length),'Every visible control is actionable');
    assert.ok(view.helpLinks.some(link=>link.type==='application/json'&&link.url.endsWith('/automation-guide.json')));
    const guide=await post(side,{action:'read-help'});assert.ok(guide.guide&&typeof guide.guide==='object');
    await assert.rejects(post(side,{action:'read-help',url:'https://example.com/automation-guide.json'}),/page-linked/);
    await post(side,{action:'click',role:'button',name:'Link diagnostics'});
    assert.match((await get(side)).text,/CRC/);
    await post(side,{action:'click',role:'button',name:'How the automatic transfer works'});
    assert.match((await get(side)).text,/Start receiving/);
    const initial=await state(side);assert.equal(initial.trust.confirmedLocally,false);assert.equal(initial.session.active,false);
    assert.equal(initial.trust.encryptedModeSelected,true);assert.equal(initial.trust.encrypted,undefined);
    assert.equal(initial.actions.find(item=>item.id==='chatEnabled').checked,true);
    assert.equal(initial.actions.find(item=>item.id==='audioProfile').value,'nearby');
  }
  await action('alice','password');await action('alice','passwordDraft',secret);
  const password=await get('alice');noContent(password.publicAgentState);
  assert.ok(!password.text.includes('Write or send an example only on the other device.'));
  assert.equal(password.controls.find(control=>control.selector==='#auto-password').value,'[redacted]');
  await action('alice','receiveInstead');await action('alice','message');
  for(const side of ['alice','bob'])await action(side,'verifyPeer',true);
  await action('alice','draft',first);await action('alice','start');
  const staged=await state('alice');assert.equal(staged.queue.pending,1,'First queued message is visible before pairing');
  assert.equal(staged.queue.encryptedPending,0);assert.equal(staged.actions.find(item=>item.id==='clearConversation').available,false);
  await action('bob','start');
  await until(async()=>{const states=await Promise.all(['alice','bob'].map(state));return states.every(item=>item.trust.fingerprint&&item.actions.find(action=>action.id==='confirm').available);},'verification pause');
  const before=await Promise.all(['alice','bob'].map(state));
  assert.equal(before[0].trust.fingerprint,before[1].trust.fingerprint,'Trusted test runner can compare both independent browser views');
  assert.equal(before[1].messages.length,0,'Verification pause releases no message');
  for(const current of before){assert.equal(current.trust.confirmedLocally,false);assert.equal(current.trust.comparisonRequired,true);noContent(current);}
  for(const side of ['alice','bob'])await action(side,'confirm');
  await until(async()=>{const states=await Promise.all(['alice','bob'].map(state));return states.every(item=>item.session.connected)&&states[0].messages.some(message=>message.direction==='outgoing'&&message.delivery==='delivered');},'verified connected chat');
  const initial=await state('alice'),initialId=initial.messages[0].id;
  assert.equal(initial.trust.confirmedLocally,true);assert.equal(initial.queue.pending,0);assert.ok(initial.metrics.rxFrames>0);noContent(initial);
  assert.ok((await get('bob')).text.includes(first),'Message stays available in the conversation DOM');
  console.log('PASS agent discovery, usable disclosures, same-origin guide, password/content redaction, and verified pairing.');

  for(const side of ['alice','bob']){
    await action(side,'advanced');
    const closed=await get(side);assert.equal(closed.publicAgentState.session.connected,true);
    assert.equal(closed.publicAgentState.actions.find(item=>item.id==='endChat').available,true,'Graceful close is available from Advanced');
    assert.equal(closed.publicAgentState.actions.find(item=>item.id==='endChat').selector,'#header-stop');
    assert.equal(closed.publicAgentState.actions.find(item=>item.id==='stop').available,true,'Immediate stop is available from Advanced');
    assert.equal(closed.publicAgentState.actions.find(item=>item.id==='stop').selector,'#header-abort');
    assert.equal(closed.controls.some(control=>control.selector==='#agent-guide-json'),false,'Closed guide descendants are absent from visible controls');
    assert.equal(closed.publicAgentState.actions.find(item=>item.id==='guideJson').visible,false);
    await action(side,'agentGuide');
    const guide=await get(side),link=guide.controls.find(control=>control.selector==='#agent-guide-json');
    assert.equal(link.disabled,true,'ARIA-disabled navigation is represented as disabled');
    const guideAction=guide.publicAgentState.actions.find(item=>item.id==='guideJson');assert.equal(guideAction.available,false);assert.match(guideAction.unavailableReason,/navigation is disabled/i);
    await assert.rejects(post(side,{action:'click',selector:link.selector}),/disabled/);
    for(const id of ['manual','legacy','showcase'])assert.equal(guide.publicAgentState.actions.find(item=>item.id===id).available,false,'Active session blocks leaving for '+id);
    await post(side,{action:'read-help'});
    await action(side,'agentGuide');await action(side,'inspectState');
    const view=await get(side),rendered=JSON.parse(view.visibleStateJson),button=view.controls.find(control=>control.selector==='#agent-inspect');
    assert.equal(rendered.schemaVersion,1);assert.equal(typeof rendered.revision,'number');
    assert.equal(rendered.actions.find(item=>item.id==='inspectState').label,button.name,'Expanded JSON uses the current visible inspector button label');
    assert.equal(button.name,'Hide local state JSON');noContent(rendered);
    if(side==='bob')for(const width of [320,390]){
      const shot=await post('admin',{action:'capture',side,width,height:844});
      assert.ok(shot.layout.scrollWidth<=shot.layout.width,'No page overflow at '+width);assert.equal(shot.layout.headerTop,0);
      assert.equal(shot.layout.inspectorOverflow,false,'JSON wraps inside the panel at '+width);
      assert.equal(shot.layout.headerActions.length,2,'Both closing choices remain in the header');
      for(const control of shot.layout.headerActions){assert.ok(control.width>=44&&control.height>=44,'Header action has a touch target: '+control.id);assert.ok(control.x>=0&&control.right<=width,'Header action fits viewport: '+control.id);}
      console.log('Screenshot '+shot.file);
    }
    await action(side,'inspectState');await action(side,'message');
  }
  console.log('PASS active Advanced access, disabled navigation, closed disclosures, accurate state inspector labels and narrow mobile layout.');

  await post('admin',{action:'block',value:true});
  for(let index=0;index<8;index++)await send('alice','Queue item '+index+' '+randomBytes(3).toString('hex'));
  await action('alice','draft','Retain ninth draft');
  const full=await state('alice');assert.equal(full.queue.pending,8);assert.equal(full.queue.canEnqueue,false);
  const start=full.actions.find(item=>item.id==='start');assert.equal(start.available,false);assert.match(start.unavailableReason,/queue full/i);
  await assert.rejects(post('alice',{action:'click',selector:start.selector}),/disabled/);
  const age=full.activity.lastDecodedFrameAgeMs;await delay(1150);
  const stale=await state('alice');assert.ok(stale.activity.lastDecodedFrameAgeMs>=age+1000,'Read-only freshness ages advance without received frames');
  assert.equal(stale.session.connected,true,'Local connected state alone is not a liveness guarantee');
  await post('admin',{action:'block',value:false});
  await until(async()=>{const current=await state('alice');return current.queue.pending===0&&current.messages.filter(message=>message.direction==='outgoing').every(message=>message.delivery==='delivered');},'queue recovery',60000);
  const recovered=await get('alice');assert.equal(recovered.controls.find(control=>control.selector==='#auto-text').value,'Retain ninth draft');
  assert.equal(recovered.publicAgentState.messages[0].id,initialId,'Receipt IDs survive pending/delivered updates');
  assert.equal(new Set(recovered.publicAgentState.messages.map(message=>message.id)).size,recovered.publicAgentState.messages.length);
  const incoming=(await state('bob')).messages.filter(message=>message.direction==='incoming');assert.equal(incoming.length,9,'Queue recovery delivers each admitted message once');
  console.log('PASS eight-message backpressure, unavailable action reasons, retained draft, freshness ages and stable receipt IDs.');

  await post('admin',{action:'drop-next-data'});await send('bob','Lost DATA should recover '+randomBytes(5).toString('hex'));
  await until(async()=>{const current=await state('bob');return current.messages.some(message=>message.direction==='outgoing')&&current.queue.pending===0;},'dropped DATA recovery',60000);
  const report=await get('admin');assert.equal(report.plaintextLeaks,0);assert.ok(report.droppedFrames>0);assert.deepEqual(report.errors,[]);
  assert.equal((await state('alice')).messages.filter(message=>message.direction==='incoming').length,1);
  await post('admin',{action:'block',value:true});await send('alice','Unconfirmed '+randomBytes(5).toString('hex'));await action('alice','stop');
  const stopped=await state('alice');assert.equal(stopped.session.active,false);assert.equal(stopped.queue.canEnqueue,false);
  assert.equal(stopped.messages.at(-1).delivery,'unconfirmed');assert.equal(stopped.messages[0].id,initialId);
  assert.equal(stopped.trust.fingerprint,null);assert.equal(stopped.trust.confirmedLocally,false);
  assert.equal(stopped.metrics.inputRms,0);assert.equal(stopped.metrics.inputPeak,0);assert.equal(stopped.session.audioStatus,null);
  await action('bob','stop');
  const retained=stopped.messages;
  for(const mode of ['password','clear','advanced','message']) {
    await action('alice',mode);
    assert.deepEqual((await state('alice')).messages,retained,'Mode changes preserve ended conversation and delivery metadata');
    assert.deepEqual((await state('alice')).metrics,stopped.metrics,'Mode changes preserve final transport diagnostics');
    assert.deepEqual((await state('alice')).chatMetrics,stopped.chatMetrics,'Mode changes preserve final chat diagnostics');
  }
  const returned=await get('alice');
  assert.ok(returned.text.includes(first),'Returning to Message restores the retained conversation');
  assert.equal(returned.publicAgentState.actions.find(item=>item.id==='conversation').available,true);
  assert.equal(returned.controls.some(control=>control.selector==='#auto-copy'),false,'Retained chat hides the unused single-item receiver');
  await action('alice','clearConversation');
  assert.equal((await state('alice')).messages.length,0,'Explicit Clear removes retained conversation');
  assert.equal((await state('alice')).actions.find(item=>item.id==='clearConversation').unavailableReason,'No conversation to clear.');
  console.log('PASS dropped DATA repair without duplicate delivery, encrypted transport evidence, and truthful Stop/unconfirmed state.');

  for(const [requester,drop] of [['alice','commit'],['bob','ack']]){
    await freshChat();await post('admin',{action:'block',value:true});
    await send('alice','Drain queued A '+randomBytes(4).toString('hex'));
    await send('bob','Drain queued B '+randomBytes(4).toString('hex'));
    await action(requester,'draft','Do not send this draft');
    await post('admin',{action:'drop-next-close',stage:drop});
    await action(requester,'endChat');
    const closing=await state(requester);
    assert.equal(closing.session.closing,true);assert.equal(closing.queue.canEnqueue,false);
    assert.equal(closing.actions.find(item=>item.id==='start').available,false);
    assert.equal(closing.actions.find(item=>item.id==='endChat').available,false);
    assert.equal(closing.actions.find(item=>item.id==='stop').available,true);
    assert.match(closing.actions.find(item=>item.id==='start').unavailableReason,/Closing/);
    assert.doesNotMatch(closing.actions.find(item=>item.id==='start').unavailableReason,/Queue full/);
    assert.equal(closing.nextAction,'wait_for_close_or_stop_now');
    await assert.rejects(action(requester,'start'),/available/);
    await post('admin',{action:'block',value:false});
    const peers=await ended();
    for(const peer of peers){
      assert.equal(peer.session.phase,'closed');assert.equal(peer.session.close.outcome,'confirmed');
      assert.equal(peer.queue.pending,0);assert.equal(peer.messages.filter(message=>message.direction==='outgoing').every(message=>message.delivery==='delivered'),true);
      assert.equal(peer.session.audioStatus,null);assert.equal(peer.trust.fingerprint,null);
    }
    const observer=requester==='alice'?1:0;assert.equal(peers[observer].session.close.localRequested,false,'Remote close needs no local click');
    assert.equal((await get(requester)).controls.find(control=>control.selector==='#auto-text').value,'Do not send this draft');
    const record=await get('admin'),dropped=record.closeFrames.filter(frame=>frame.dropReason==='injected close '+drop+' loss');
    assert.equal(dropped.length,1);
    assert.ok(record.closeFrames.some(frame=>frame.sha256===dropped[0].sha256&&frame.delivered),'Lost close control is repaired using identical ciphertext');
    assert.equal(record.endpoints.reduce((sum,endpoint)=>sum+endpoint.messages.length,0),6,'Three total app messages appear exactly once at both ends');
    console.log(`PASS ${requester} End chat: both admitted queues drain, unsent draft retained, lost ${drop} repairs exactly, peer closes automatically.`);
  }
  await freshChat();await post('admin',{action:'drop-next-close',stage:'final',count:8});
  await action('alice','endChat');
  const finalLoss=await ended();
  assert.equal(finalLoss[0].session.close.peerAckSeen,true);assert.equal(finalLoss[0].session.close.outcome,'confirmed');
  assert.equal(finalLoss[1].session.close.finalSeen,false);assert.equal(finalLoss[1].session.close.outcome,'unconfirmed');
  assert.equal(finalLoss[1].session.active,false);assert.equal(finalLoss[1].queue.pending,0);
  assert.match(finalLoss[1].session.status,/final|confirm/i);
  console.log('PASS lost FINAL has bounded receive-only linger and truthful asymmetric confirmation; app delivery remains confirmed.');

  await freshChat();await post('admin',{action:'block',value:true});
  await send('alice','Stop during close '+randomBytes(4).toString('hex'));await action('alice','endChat');
  assert.equal((await state('alice')).session.closing,true);await action('alice','stop');
  const aborted=await state('alice');assert.equal(aborted.session.active,false);assert.equal(aborted.session.close.outcome,'aborted');
  assert.equal(aborted.messages.at(-1).delivery,'unconfirmed');assert.equal(aborted.trust.fingerprint,null);
  await action('bob','stop');
  console.log('PASS public Stop now immediately interrupts graceful closing and retains truthful Unconfirmed receipts.');
}finally{
  if(endpoints&&!exited){try{await post('admin',{action:'stop'});}catch{}}
  const deadline=Date.now()+10000;while(!exited&&Date.now()<deadline)await delay(100);
  if(!exited)child.kill('SIGTERM');
}
