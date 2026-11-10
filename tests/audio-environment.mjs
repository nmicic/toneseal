// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ScreenAwake,MAX_PLAYBACK_GAIN,devicePlaybackHint} from '../web/audio-environment.mjs';
function sentinel(){return {released:false,releases:0,onrelease:null,async release(){this.releases++;this.released=true;this.onrelease?.();}};}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
test('full app gain and iOS capture-volume guidance are explicit',()=>{
  assert.equal(MAX_PLAYBACK_GAIN,1);
  assert.match(devicePlaybackHint({userAgent:'iPhone'}),/after starting audio/);
  assert.match(devicePlaybackHint({platform:'MacIntel',maxTouchPoints:5}),/after starting audio/);
  assert.doesNotMatch(devicePlaybackHint({userAgent:'Android'}),/iPhone/);
});
test('screen wake lock is acquired only on start and released exactly once',async()=>{
  const lock=sentinel(),states=[],requests=[];
  const awake=new ScreenAwake({navigator:{wakeLock:{request:async type=>{requests.push(type);return lock;}}},onChange:state=>states.push(state)});
  assert.deepEqual(requests,[]);await awake.start();assert.deepEqual(requests,['screen']);assert.equal(awake.state,'held');
  awake.stop();awake.stop();assert.equal(lock.releases,1);assert.equal(awake.state,'idle');assert.deepEqual(states,['pending','held','idle']);
});
test('unsupported, hidden and denied screen locks are observable nonfatal states',async()=>{
  const unsupported=new ScreenAwake({navigator:{}});await unsupported.start();assert.equal(unsupported.state,'unsupported');
  const hidden=new ScreenAwake({navigator:{wakeLock:{request:()=>assert.fail('Hidden pages must not request a lock')}},document:{hidden:true}});
  await hidden.start();assert.equal(hidden.state,'released');
  const denied=new ScreenAwake({navigator:{wakeLock:{request:async()=>{throw Error('Power saver');}}}});
  await denied.start();assert.equal(denied.state,'denied');denied.stop();assert.equal(denied.state,'idle');
});
test('a grant after Stop is released instead of keeping an abandoned page awake',async()=>{
  const pending=deferred(),lock=sentinel(),awake=new ScreenAwake({navigator:{wakeLock:{request:()=>pending.promise}}});
  const start=awake.start();awake.stop();pending.resolve(lock);await start;assert.equal(lock.releases,1);assert.equal(awake.state,'idle');
});
test('an old grant cannot replace the next run’s active lock',async()=>{
  const first=deferred(),old=sentinel(),current=sentinel();let requests=0;
  const awake=new ScreenAwake({navigator:{wakeLock:{request:()=>++requests===1?first.promise:Promise.resolve(current)}}});
  const abandoned=awake.start();awake.stop();await awake.start();first.resolve(old);await abandoned;
  assert.equal(old.releases,1);assert.equal(current.releases,0);assert.equal(awake.lock,current);awake.stop();assert.equal(current.releases,1);
});
test('hiding before a delayed grant releases it and reports the result',async()=>{
  const pending=deferred(),lock=sentinel(),document={hidden:false};
  const awake=new ScreenAwake({navigator:{wakeLock:{request:()=>pending.promise}},document});
  const start=awake.start();document.hidden=true;pending.resolve(lock);await start;
  assert.equal(lock.releases,1);assert.equal(awake.state,'released');awake.stop();
});
test('an OS release is reported without a permission retry loop',async()=>{
  const lock=sentinel();let requests=0;
  const awake=new ScreenAwake({navigator:{wakeLock:{request:async()=>{requests++;return lock;}}}});
  await awake.start();await lock.release();assert.equal(awake.state,'released');assert.equal(awake.lock,null);assert.equal(requests,1);
  awake.stop();assert.equal(lock.releases,1);
});
test('a release exception cannot prevent media cleanup',async()=>{
  const awake=new ScreenAwake({navigator:{wakeLock:{request:async()=>({released:false,release(){throw Error('Device gone');}})}}});
  await awake.start();assert.doesNotThrow(()=>awake.stop());assert.equal(awake.state,'idle');
});
