// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Display taps must not alter modem routing, retain stopped PCM or fail a run.
import assert from 'node:assert/strict';
import test from 'node:test';
import {AutoAudioLink} from '../web/auto-audio-link.mjs';
import {AutoTransfer} from '../web/auto-transfer.mjs';

class Node {
  constructor(name){this.name=name;this.connections=new Set();}
  connect(node){this.connections.add(node);return node;}
  disconnect(node){if(node)this.connections.delete(node);else this.connections.clear();}
}

function fakeAudio({analysers=true,throwAt=null}={}){
  const saved=new Map(['navigator','AudioContext','AudioWorkletNode','Worker'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const instances=[],tracks=[];
  class Context {
    constructor(){this.state='suspended';this.sampleRate=48000;this.currentTime=0;this.destination=new Node('speaker');this.nodes=[];this.audioWorklet={addModule:async()=>{}};instances.push(this);}
    resume(){this.state='running';return Promise.resolve();}
    close(){this.state='closed';return Promise.resolve();}
    createMediaStreamSource(){return this.microphone=new Node('microphone');}
    createAnalyser(){
      if(throwAt===this.nodes.length)throw Error('Optional analyser failed');
      const node=new Node('analyser');node.value=this.nodes.length?.5:.125;
      node.getFloatTimeDomainData=buffer=>buffer.fill(node.value);this.nodes.push(node);return node;
    }
    createBuffer(_channels,length){const samples=new Float32Array(length);return {getChannelData:()=>samples};}
    createBufferSource(){const node=new Node('playback');node.playbackRate={value:1};node.start=()=>{node.started=true;};node.stop=()=>{node.stopped=true;};return this.playback=node;}
    createGain(){const node=new Node('gain');node.gain={value:1};return this.gain=node;}
  }
  if(!analysers)Context.prototype.createAnalyser=undefined;
  class Capture extends Node {
    constructor(context){super('capture');context.capture=this;this.port={postMessage(){}};}
  }
  class Worker {
    postMessage(data){if(data.type==='init')queueMicrotask(()=>this.onmessage?.({data:{type:'ready'}}));}
    terminate(){}
  }
  const navigator={mediaDevices:{getUserMedia:async()=>{
    const track={readyState:'live',stop(){this.readyState='ended';}};tracks.push(track);return {getTracks:()=>[track]};
  }}};
  for(const [name,value] of Object.entries({navigator,AudioContext:Context,AudioWorkletNode:Capture,Worker}))Object.defineProperty(globalThis,name,{configurable:true,value});
  return {instances,tracks,restore(){for(const [name,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}};
}

test('live taps keep direct routes, reuse bounded buffers and erase stopped samples',async()=>{
  const fake=fakeAudio(),link=new AutoAudioLink();
  try{
    assert.equal(link.readAudioVisuals(),null);
    await link.start();const context=fake.instances[0];
    assert.equal(fake.instances.length,1);assert.equal(fake.tracks.length,1);
    assert.deepEqual([...context.microphone.connections],[context.capture,context.nodes[0]]);
    assert.deepEqual([...context.capture.connections],[context.destination]);
    assert.ok(context.nodes.every(node=>node.fftSize===2048&&node.connections.size===0));
    const first=link.readAudioVisuals();assert.equal(first.input.length,2048);assert.equal(first.output.length,2048);
    assert.equal(first.input[0],.125);assert.equal(first.output[0],0);assert.equal(first.playing,false);
    assert.equal(link.readAudioVisuals().input,first.input);assert.equal(link.readAudioVisuals().output,first.output);
    assert.equal(JSON.stringify(link.metrics).includes('inputNode'),false);
    link.prepare=async()=>new Int16Array(960).fill(1234);
    let releaseGuard;link.wait=()=>new Promise(resolve=>{releaseGuard=resolve;});
    const sending=link.send(new Uint8Array([1]));await Promise.resolve();
    assert.equal(context.playback.started,true);assert.equal(context.gain.gain.value,1);
    assert.deepEqual([...context.playback.connections],[context.gain]);
    assert.deepEqual([...context.gain.connections],[context.destination,context.nodes[1]]);
    const playing=link.readAudioVisuals();assert.equal(playing.playing,true);assert.equal(playing.output[0],.5);assert.equal(playing.input[0],.125);
    context.playback.onended();await Promise.resolve();
    assert.equal(link.playing,true,'decoder still observes its echo guard');
    assert.equal(link.readAudioVisuals().playing,false,'display follows actual playback');
    assert.equal(playing.output.every(value=>value===0),true);
    assert.deepEqual([...context.gain.connections],[context.destination]);
    releaseGuard();await sending;
    link.stop();assert.equal(link.readAudioVisuals(),null);
    assert.equal(first.input.every(value=>value===0),true);assert.equal(first.output.every(value=>value===0),true);
    assert.deepEqual([...context.microphone.connections],[context.capture],'only the optional branch is disconnected');
    assert.equal(link._visuals,null);assert.equal(fake.tracks[0].readyState,'ended');
  }finally{link.stop();fake.restore();}
});

test('unsupported or failed display analysis does not stop capture',async()=>{
  for(const options of [{analysers:false},{throwAt:0},{throwAt:1}]){
    const fake=fakeAudio(options),link=new AutoAudioLink();
    try{await link.start();assert.equal(link.running,true);assert.equal(link.readAudioVisuals(),null);assert.equal(fake.tracks[0].readyState,'live');}
    finally{link.stop();fake.restore();}
  }
  const fake=fakeAudio(),link=new AutoAudioLink();
  try{
    await link.start();const frame=link.readAudioVisuals();
    fake.instances[0].nodes[0].getFloatTimeDomainData=()=>{throw Error('Read failure');};
    assert.equal(link.readAudioVisuals(),null);assert.equal(link.running,true);
    assert.equal(frame.input.every(value=>value===0),true);
    assert.deepEqual([...fake.instances[0].microphone.connections],[fake.instances[0].capture]);
  }finally{link.stop();fake.restore();}
});

test('non-finite samples and suspended audio are never displayed',async()=>{
  const fake=fakeAudio(),link=new AutoAudioLink({profile:'telephone'});
  try{
    await link.start();const context=fake.instances[0],frame=link.readAudioVisuals();
    assert.equal(frame.profile,'telephone');assert.equal(frame.sampleRate,48000);
    context.state='suspended';assert.equal(link.readAudioVisuals(),null);assert.equal(frame.input[0],0);
    context.state='running';context.nodes[0].value=NaN;
    assert.equal(link.readAudioVisuals(),null);assert.equal(link.running,true);assert.equal(frame.input[0],0);
  }finally{link.stop();fake.restore();}
});

test('controller forwarding is optional and never exposes samples in state',()=>{
  const controller=new AutoTransfer(),frame={active:true,input:new Float32Array([.5])};
  assert.equal(controller.readAudioVisuals(),null);
  controller._transport={readAudioVisuals:()=>frame};assert.equal(controller.readAudioVisuals(),frame);
  assert.equal(Object.values(controller.state).includes(frame),false);
  controller._transport={readAudioVisuals(){throw Error('Optional display failed');}};assert.equal(controller.readAudioVisuals(),null);
  controller._transport={};assert.equal(controller.readAudioVisuals(),null);
});
