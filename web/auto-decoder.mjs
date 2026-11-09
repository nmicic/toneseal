// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {getAudioProfile} from './audio-profiles.mjs';
import {UltrasonicInput} from './ultrasonic-input.mjs';
// Two bounded, staggered native receivers preserve packets across resets.
const RATE = 48000, EPOCH = RATE * 12, STAGGER = EPOCH / 2;
const same = (a,b) => a.length === b.length && a.every((value,i) => value === b[i]);
const candidateCounters = Object.freeze({crcRejectedCandidates:'acoustic_crc_failures',
  invalidHeaderCandidates:'acoustic_invalid_headers',invalidPayloadCandidates:'acoustic_invalid_payloads'});

export class StreamingDecoder {
  static async create(module, rate, profile = 'nearby') {
    if (![44100,48000].includes(rate)) throw Error('Use a 44.1 or 48 kHz audio input.');
    const selected=getAudioProfile(profile);
    const decoders = await Promise.all([WebAssembly.instantiate(module,{}), WebAssembly.instantiate(module,{})]);
    return new StreamingDecoder(decoders.map(instance => instance.exports),rate,selected.id);
  }
  constructor(apis,rate,profile = 'nearby') {
    this.rate=rate;this.profile=getAudioProfile(profile);
    this.step=rate/(RATE*this.profile.decodeRate);
    this.frontend=this.profile.id==='ultrasonic'?new UltrasonicInput(rate):null;
    this.states=apis.map(api=>{
      if(api.memory.buffer.byteLength>262144)throw Error('Decoder memory exceeds its limit.');
      return {api,input:new Int16Array(api.memory.buffer,api.acoustic_input(),4096),start:0,fed:0,reported:0,deadline:0,counters:{}};
    });
    // Candidate failures are diagnostic attempts, not a physical packet-loss
    // count: multiple offsets and both staggered receivers can inspect a signal.
    this.metrics={crcRejectedCandidates:0,invalidHeaderCandidates:0,invalidPayloadCandidates:0,correctedNibbles:0};
    this.reset();
  }
  resetState(state,start) {
    state.api.acoustic_reset();state.start=start;state.fed=0;state.reported=0;state.counters={};
  }
  reset() {
    this.frontend?.reset();
    this.position=0;this.inputCount=0;this.previous=0;this.outputCount=0;this.recent=[];
    this.resetState(this.states[0],0);this.resetState(this.states[1],STAGGER);
    this.states[0].deadline=EPOCH;this.states[1].deadline=STAGGER+EPOCH;
  }
  convert(samples) {
    if(!(samples instanceof Float32Array)||!samples.length||samples.length>8192)throw Error('Invalid streaming audio chunk.');
    for(const sample of samples)if(!Number.isFinite(sample))throw Error('Non-finite input sample.');
    if(this.frontend)samples=this.frontend.push(samples);
    if(this.step===1){
      this.inputCount+=samples.length;
      return Int16Array.from(samples,value=>Math.max(-32768,Math.min(32767,Math.round(value*32768))));
    }
    // Restore canonical 48 kHz time before feeding either native receiver.
    // Epochs, onsets, and dedup remain canonical samples at every playback rate;
    // the bounded native windows consequently cover more real time when slow.
    // Retain one input sample so interpolation stays continuous at chunk edges.
    const base=this.inputCount,end=base+samples.length,values=[];
    const at=index=>index<base?this.previous:samples[index-base];
    while(this.position+1<end){
      const index=Math.floor(this.position),mix=this.position-index;
      const value=at(index)*(1-mix)+at(index+1)*mix;
      values.push(Math.max(-32768,Math.min(32767,Math.round(value*32768))));
      this.position+=this.step;
    }
    this.previous=samples.at(-1);this.inputCount=end;
    return Int16Array.from(values);
  }
  push(samples) {
    const pcm=this.convert(samples),begin=this.outputCount,end=begin+pcm.length,found=[];
    for(const state of this.states){
      let cursor=Math.max(begin,state.start);
      while(cursor<end){
        // The fixed adapter stores eight results. Reset at a completed packet
        // boundary before that fills; the other receiver still covers the edge.
        if(cursor>=state.deadline){this.resetState(state,cursor);state.deadline+=EPOCH;}
        // Preserve the absolute stagger even when an early result-capacity
        // reset occurs on both receivers at the same acoustic packet boundary.
        else if(state.reported>=7)this.resetState(state,cursor);
        const count=Math.min(4096,end-cursor,state.deadline-cursor);
        state.input.set(pcm.subarray(cursor-begin,cursor-begin+count));
        const status=state.api.acoustic_feed(count);
        for(const [name,method] of Object.entries(candidateCounters)){
          const total=state.api[method]();
          this.metrics[name]+=total-(state.counters[name]||0);state.counters[name]=total;
        }
        if(status||state.api.acoustic_numeric_errors())throw Error('Streaming receiver refused its input.');
        state.fed+=count;cursor+=count;
        const total=state.api.acoustic_count();
        for(let i=state.reported;i<total;i++){
          const bytes=new Uint8Array(state.api.memory.buffer,state.api.acoustic_payload(i),state.api.acoustic_length(i)).slice();
          const onset=state.start+state.api.acoustic_onset(i);
          if(!this.recent.some(item=>Math.abs(item.onset-onset)<=4800&&same(item.bytes,bytes))){
            // Worker delivery transfers the returned payload buffer. Retain an
            // independent copy so cross-receiver dedup survives that transfer.
            this.recent.push({bytes:bytes.slice(),onset});found.push({bytes,onset});
            this.metrics.correctedNibbles+=state.api.acoustic_corrected(i);
            if(this.recent.length>32)this.recent.shift();
          }
        }
        state.reported=total;
      }
    }
    this.outputCount=end;
    found.sort((a,b)=>a.onset-b.onset);
    return found.map(item=>item.bytes);
  }
}
