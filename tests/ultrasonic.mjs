// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test} from 'node:test';
import {getAudioProfile} from '../web/audio-profiles.mjs';
import {payloadTimeline,glyphFrequencies} from '../web/communication-codec.mjs';
import {UltrasonicInput} from '../web/ultrasonic-input.mjs';
import {ultrasonicTables} from '../web/ultrasonic-tables.mjs';

test('experimental carrier and duration are explicit; existing profiles retain their timing',()=>{
  const profile=getAudioProfile('ultrasonic');
  assert.equal(profile.minHz,18400);assert.equal(profile.maxHz,19975);
  assert.equal(profile.playbackRate,1);assert.equal(profile.decodeRate,.5);assert.equal(profile.timingScale,2);
  assert.equal(getAudioProfile('nearby').timingScale,1);assert.equal(getAudioProfile('telephone').playbackRate,.75);
  const tones=new Set();for(let value=0;value<256;value++)for(const tone of glyphFrequencies(value,'ultrasonic'))tones.add(tone);
  assert.equal(tones.size,64);assert.equal(Math.min(...tones),18400);assert.equal(Math.max(...tones),19975);
  const engine='a1 sine_bits=12 exp_bits=10 phase64=1 env64=1 fb_avg=1 tables=58021f1150d3c8d2';
  const packet=new Uint8Array(128),normal=payloadTimeline(packet,engine),ultra=payloadTimeline(packet,engine,'ultrasonic');
  assert.match(normal,/length_ns 4160000000\n/);assert.match(ultra,/length_ns 8320000000\n/);
  assert.equal(payloadTimeline(packet,engine,'telephone'),normal,'Telephone retains the original canonical PCM');
});

test('native and browser integer mixer/filter constants match',async()=>{
  const header=await fs.readFile(new URL('../native/ultrasonic_tables.h',import.meta.url),'utf8');
  for(const rate of [44100,48000])for(const kind of ['mix','filter']){
    const match=header.match(new RegExp(`ts_ultrasonic_${kind}_${rate}\\[\\d+\\] = \\{([\\s\\S]*?)\\};`));assert.ok(match);
    const values=match[1].trim().split(',').map(Number);assert.deepEqual(values,ultrasonicTables[rate][kind]);
    assert.ok(values.every(Number.isSafeInteger));
    if(kind==='filter'){
      assert.equal(values.length,97);assert.equal(values.reduce((a,b)=>a+b,0),1073741824);
      assert.deepEqual(values,values.slice().reverse());assert.ok(32768*values.reduce((a,b)=>a+Math.abs(b),0)<2**53);
    }
  }
});

for(const rate of [44100,48000])test(`ultrasonic front end ${rate} Hz: chunk independence, reset and rejection before decimation`,()=>{
  const input=Float32Array.from({length:Math.ceil(rate*.25)},(_,i)=>.2*Math.cos(2*Math.PI*18800*i/rate));
  const music=Float32Array.from(input,(value,i)=>value+.6*Math.cos(2*Math.PI*7000*i/rate));
  const apply=(source,chunks)=>{
    const frontend=new UltrasonicInput(rate),out=new Float32Array(source.length);
    for(let i=0,n=0;i<source.length;n++){const end=Math.min(source.length,i+chunks[n%chunks.length]);out.set(frontend.push(source.slice(i,end)),i);i=end;}
    return {out,frontend};
  };
  const one=apply(input,[8192]),irregular=apply(input,[1,17,2048,4096,13]);assert.deepEqual(irregular.out,one.out);
  irregular.frontend.reset();assert.deepEqual(irregular.frontend.push(input.slice(0,2048)),new UltrasonicInput(rate).push(input.slice(0,2048)));
  const noisy=apply(music,[2048]).out;let energy=0,difference=0,count=0;
  for(let i=200;i<input.length;i++){energy+=one.out[i]**2;difference+=(noisy[i]-one.out[i])**2;count++;}
  assert.ok(Math.sqrt(energy/count)>.06&&Math.sqrt(energy/count)<.08,'wanted carrier recovers its expected baseband energy');
  assert.ok(Math.sqrt(difference/count)<.001,'strong 7 kHz music must be rejected before it can alias into modem bins');
  assert.throws(()=>one.frontend.push(Float32Array.of(NaN)),/Non-finite/);
  assert.throws(()=>one.frontend.push(new Float32Array(8193)),/chunk/);
  assert.throws(()=>new UltrasonicInput(16000),/44.1 or 48/);
});
