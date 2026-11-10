// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {payloadTimeline} from './communication-codec.mjs';
import {getAudioProfile} from './audio-profiles.mjs';
import {MAX_PLAYBACK_GAIN,ScreenAwake} from './audio-environment.mjs';
import {MAX_AUDIO_RUN_MS} from './transfer-limits.mjs';

export const DEFAULT_PLAYBACK_VOLUME = MAX_PLAYBACK_GAIN;
const freshMetrics=()=>({txFrames:0,txBytes:0,rxFrames:0,rxBytes:0,
  crcRejectedCandidates:0,invalidHeaderCandidates:0,invalidPayloadCandidates:0,
  correctedNibbles:0,decoderErrors:0,inputRms:0,inputPeak:0,inputClippedSamples:0,playbackLevel:MAX_PLAYBACK_GAIN,screenWakeLock:'idle'});
const decoderMetricNames=['crcRejectedCandidates','invalidHeaderCandidates','invalidPayloadCandidates','correctedNibbles'];
const cancelled=()=>new DOMException('Automatic audio stopped.','AbortError');
const packetKey=packet=>Array.from(packet,value=>value.toString(16).padStart(2,'0')).join('');
function audioSession(type){try{if(globalThis.navigator?.audioSession)navigator.audioSession.type=type;}catch{}}

// One user activation opens one context and microphone for the whole bounded
// run. Playback never changes away from a capture-compatible Audio Session.
export class AutoAudioLink {
  constructor({onPackets=()=>{},onStatus=()=>{},onError=()=>{},onMetrics=()=>{},profile='nearby',maxRunMs=180000}={}){
    if(!Number.isInteger(maxRunMs)||maxRunMs<1||maxRunMs>MAX_AUDIO_RUN_MS)throw Error('Automatic audio must have a positive lifetime of at most two hours.');
    this.maxRunMs=maxRunMs;
    this.profile=getAudioProfile(profile);
    this.onPackets=onPackets;this.onStatus=onStatus;this.onError=onError;this.onMetrics=onMetrics;
    this.generation=0;this.running=false;this.busy=false;this.playing=false;
    this.context=null;this.stream=null;this.captureNode=null;this.decoder=null;this.source=null;
    this.renderWorker=null;this.abort=null;this.cache=new Map();this.volume=DEFAULT_PLAYBACK_VOLUME;
    this.epoch=0;this.nextChunk=0;this.queued=new Map();this.queuedFrames=0;
    this.allowedAfter=0;this.timers=new Set();this.cancelWaiters=new Set();
    this._metrics=freshMetrics();this._metricsTimer=null;
    this.screenAwake=new ScreenAwake({onChange:state=>{this._metrics.screenWakeLock=state;this._reportMetrics();}});
    this._visuals=null;this._visualPlayback=false;
  }
  get metrics(){return {...this._metrics};}
  // Display-only side taps. These bounded buffers are consumed synchronously by
  // the local view; they never enter decoder traffic, metrics or agent state.
  _startVisuals(inputSource){
    if(typeof this.context?.createAnalyser!=='function')return;
    try{
      const view={inputSource,inputNode:null,outputNode:null,outputGain:null,
        input:new Float32Array(2048),output:new Float32Array(2048)};
      this._visuals=view;
      for(const name of ['inputNode','outputNode']){
        const node=this.context.createAnalyser();view[name]=node;node.fftSize=2048;
        if(typeof node.getFloatTimeDomainData!=='function')throw Error('Audio visualization is unavailable.');
      }
      // AnalyserNode needs no output connection. The original capture and
      // playback paths remain direct; microphone sound is never monitored.
      inputSource.connect(view.inputNode);
    }catch{this._clearVisuals();}
  }
  _connectVisualOutput(gain){
    const view=this._visuals;if(!view)return;
    try{
      if(view.outputGain)view.outputGain.disconnect(view.outputNode);
      gain.connect(view.outputNode);view.outputGain=gain;view.output.fill(0);
    }catch{this._clearVisuals();}
  }
  _endVisualOutput(){
    this._visualPlayback=false;
    const view=this._visuals;if(!view)return;
    try{view.outputGain?.disconnect(view.outputNode);}catch{}
    view.outputGain=null;view.output.fill(0);
  }
  _clearVisuals(){
    this._visualPlayback=false;
    const view=this._visuals;this._visuals=null;if(!view)return;
    view.input.fill(0);view.output.fill(0);
    // Disconnect only the optional branches, never an original audio route.
    try{if(view.inputNode)view.inputSource?.disconnect(view.inputNode);}catch{}
    try{if(view.outputNode)view.outputGain?.disconnect(view.outputNode);}catch{}
    for(const node of [view.inputNode,view.outputNode])try{node?.disconnect();}catch{}
    view.inputSource=null;view.outputGain=null;view.inputNode=null;view.outputNode=null;
  }
  readAudioVisuals(){
    const view=this._visuals;
    if(!this.running||this.context?.state!=='running'||!view){
      view?.input.fill(0);view?.output.fill(0);return null;
    }
    try{
      const playing=Boolean(this._visualPlayback&&this.source);
      view.inputNode.getFloatTimeDomainData(view.input);
      if(playing)view.outputNode.getFloatTimeDomainData(view.output);else view.output.fill(0);
      if(!view.input.every(Number.isFinite)||!view.output.every(Number.isFinite))throw Error('Invalid display samples.');
      return {active:true,playing,sampleRate:this.context.sampleRate,profile:this.profile.id,
        input:view.input,output:view.output};
    }catch{this._clearVisuals();return null;}
  }
  _flushMetrics(){
    if(this._metricsTimer!==null)this.clearTimer(this._metricsTimer);
    this._metricsTimer=null;
    // Diagnostics must never change transfer success or retain content.
    try{this.onMetrics(this.metrics);}catch{}
  }
  _reportMetrics(){
    if(this._metricsTimer!==null)return;
    this._metricsTimer=this.timer(()=>this._flushMetrics(),250);
  }
  _inputLevel(samples){
    let squared=0,peak=0,clipped=0;
    for(const value of samples){
      if(!Number.isFinite(value))throw Error('Capture produced a non-finite sample.');
      squared+=value*value;peak=Math.max(peak,Math.abs(value));
      if(value>=32767/32768||value<=-1)clipped++;
    }
    this._metrics.inputRms=Math.sqrt(squared/samples.length);
    this._metrics.inputPeak=peak;this._metrics.inputClippedSamples+=clipped;
    this._reportMetrics();
  }
  check(token){if(token!==this.generation)throw cancelled();}
  timer(callback,ms){const id=setTimeout(()=>{this.timers.delete(id);callback();},ms);this.timers.add(id);return id;}
  clearTimer(id){clearTimeout(id);this.timers.delete(id);}
  wait(ms){return new Promise((resolve,reject)=>{
    const stop=()=>{this.clearTimer(id);this.cancelWaiters.delete(stop);reject(cancelled());};
    const id=this.timer(()=>{this.cancelWaiters.delete(stop);resolve();},ms);
    this.cancelWaiters.add(stop);
  });}
  stop(){
    this.generation++;this.running=false;this.busy=false;this.playing=false;
    this.screenAwake.stop();
    this._clearVisuals();
    this.abort?.abort();this.abort=null;
    for(const stop of [...this.cancelWaiters])stop();this.cancelWaiters.clear();
    for(const id of this.timers)clearTimeout(id);this.timers.clear();
    try{this.source?.stop();}catch{}this.source=null;
    try{this.captureNode?.port.postMessage({stop:true});this.captureNode?.disconnect();}catch{}this.captureNode=null;
    this.stream?.getTracks().forEach(track=>{track.onended=null;track.stop();});this.stream=null;
    this.decoder?.terminate();this.decoder=null;this.renderWorker?.terminate();this.renderWorker=null;
    if(this.context){this.context.onstatechange=null;this.context.close().catch(()=>{});this.context=null;}
    this.queued.clear();this.queuedFrames=0;this.cache.clear();this.engine=null;this.allowedAfter=0;
    this._metrics.inputRms=0;this._metrics.inputPeak=0;this._flushMetrics();
    audioSession('auto');
  }
  fail(error){
    if(!this.running&&!this.busy)return;
    this.stop();this.onError(error instanceof Error?error:Error(String(error)));
  }
  async start(){
    this.stop();this._metrics=freshMetrics();this._flushMetrics();const token=this.generation;this.busy=true;
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw Error('Automatic audio requires HTTPS or localhost and microphone access.');
      audioSession('play-and-record');
      const context=new AudioContext({sampleRate:48000});this.context=context;
      // Both calls occur synchronously in the Start click, before any await.
      const resumed=context.resume();resumed.catch(()=>{});
      const permission=navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false}).catch(error=>{
        const message={
          NotAllowedError:'Microphone access is blocked. Allow it in your browser or device settings, then press Start again.',
          NotFoundError:'No microphone was found. Connect or enable a microphone, then press Start again.',
          NotReadableError:'The microphone could not be opened. Check its settings and whether another app is using it, then try again.',
        }[error?.name];
        throw message?new DOMException(message,error.name):error;
      });
      permission.then(stream=>{
        if(token!==this.generation){stream.getTracks().forEach(track=>track.stop());return;}
        this.stream=stream;
      },()=>{});
      this.onStatus('Starting microphone and audio…');
      const setup=new Promise((_,reject)=>{
        const cancel=()=>reject(cancelled());this.cancelWaiters.add(cancel);
        this.setupCancel=cancel;
        this.setupTimer=this.timer(()=>reject(Error('Audio setup timed out. Tap Start to try again.')),20000);
      });
      await Promise.race([Promise.all([resumed,permission]),setup]);this.check(token);
      if(context.state!=='running')throw Error('Audio could not start. Keep this page visible and tap Start again.');
      if(![44100,48000].includes(context.sampleRate))throw Error('Use an input at 44.1 or 48 kHz.');
      void this.screenAwake.start();
      const initialized=new Promise((resolve,reject)=>{
        const worker=new Worker(new URL('./auto-decoder-worker.mjs',import.meta.url),{type:'module'});this.decoder=worker;
        worker.onerror=event=>{if(token!==this.generation)return;this._metrics.decoderErrors++;this._reportMetrics();const error=Error(event.message||'Streaming decoder failed.');reject(error);if(this.running)this.fail(error);};
        worker.onmessage=({data})=>{
          if(token!==this.generation)return;
          if(data.type==='ready'){resolve();return;}
          if(data.type==='error'){this._metrics.decoderErrors++;this._reportMetrics();const error=Error(data.error);reject(error);if(this.running)this.fail(error);return;}
          if(data.type!=='decoded')return;
          const frames=this.queued.get(data.id);if(frames!==undefined){this.queuedFrames-=frames;this.queued.delete(data.id);}
          if(this.running&&data.epoch===this.epoch){
            for(const name of decoderMetricNames){
              const value=data.metrics?.[name];
              if(Number.isSafeInteger(value)&&value>=this._metrics[name])this._metrics[name]=value;
            }
            if(data.packets?.length){
              this._metrics.rxFrames+=data.packets.length;
              this._metrics.rxBytes+=data.packets.reduce((sum,packet)=>sum+packet.length,0);
              try{Promise.resolve(this.onPackets(data.packets)).catch(error=>this.fail(error));}catch(error){this.fail(error);}
            }
            if(this.running)this._reportMetrics();
          }
        };
        worker.postMessage({type:'init',rate:context.sampleRate,profile:this.profile.id});
      });
      await Promise.race([Promise.all([initialized,context.audioWorklet.addModule(new URL('./auto-capture.mjs',import.meta.url))]),setup]);this.check(token);
      if(context.state!=='running')throw Error('Audio was interrupted during setup. Keep this page visible and tap Start again.');
      if(!this.stream.getTracks().length||this.stream.getTracks().some(track=>track.readyState!=='live'))throw Error('Microphone access ended during setup. Tap Start to try again.');
      this.cancelWaiters.delete(this.setupCancel);this.setupCancel=null;this.clearTimer(this.setupTimer);
      const node=new AudioWorkletNode(context,'automatic-audio-capture');this.captureNode=node;
      node.port.onmessage=({data})=>{
        if(token!==this.generation||!this.running||!(data.samples instanceof Float32Array))return;
        if(this.playing||data.startFrame<this.allowedAfter*context.sampleRate)return;
        if(data.samples.length!==2048||!Number.isFinite(data.startFrame)){this.fail(Error('Capture produced an invalid chunk.'));return;}
        try{this._inputLevel(data.samples);}catch(error){this.fail(error);return;}
        if(this.queuedFrames+data.samples.length>context.sampleRate*1.5){this.fail(Error('This device cannot decode audio fast enough. Stop and try again.'));return;}
        const id=++this.nextChunk;this.queued.set(id,data.samples.length);this.queuedFrames+=data.samples.length;
        this.decoder.postMessage({type:'samples',epoch:this.epoch,id,samples:data.samples},[data.samples.buffer]);
      };
      const microphone=context.createMediaStreamSource(this.stream);
      microphone.connect(node).connect(context.destination);this._startVisuals(microphone);
      this.running=true;this.busy=false;this.resetReceiver();
      this.stream.getTracks().forEach(track=>{track.onended=()=>{if(token===this.generation)this.fail(Error('Microphone access ended. Tap Start to try again.'));};});
      context.onstatechange=()=>{if(token===this.generation&&this.running&&context.state!=='running')this.fail(Error('Audio was interrupted. Keep both pages visible and tap Start again.'));};
      this.timer(()=>this.fail(Error(this.maxRunMs===180000?'Automatic audio stopped after three minutes. Tap Start to try again.':'Automatic audio reached its time limit. Tap Start to try again.')),this.maxRunMs);
      this.onStatus('Listening automatically. Keep this page visible.');
    }catch(error){if(token===this.generation)this.stop();throw error;}
  }
  resetReceiver(){
    this.epoch++;this.queued.clear();this.queuedFrames=0;
    this._metrics.inputRms=0;this._metrics.inputPeak=0;if(this.running)this._reportMetrics();
    this.decoder?.postMessage({type:'reset',epoch:this.epoch});
  }
  renderJob(data,token){return new Promise((resolve,reject)=>{
    // Keep the renderer and its immutable engine cache for this bounded run.
    const worker=this.renderWorker || new Worker(new URL('./auto-render-worker.mjs',import.meta.url),{type:'module'});this.renderWorker=worker;
    let done=false;
    const finish=(error,value)=>{
      if(done)return;done=true;this.clearTimer(timeout);this.cancelWaiters.delete(cancel);
      worker.onmessage=null;worker.onerror=null;
      if(error){worker.terminate();if(this.renderWorker===worker)this.renderWorker=null;}
      error?reject(error):resolve(value);
    };
    const cancel=()=>finish(cancelled());this.cancelWaiters.add(cancel);
    const timeout=this.timer(()=>finish(Error('Audio preparation timed out.')),60000);
    worker.onerror=event=>finish(Error(event.message||'Synth worker failed.'));
    worker.onmessage=({data:result})=>{if(token!==this.generation)finish(cancelled());else finish(null,result);};
    worker.postMessage(data);
  });}
  async prepare(packet,token){
    const key=packetKey(packet),cached=this.cache.get(key);if(cached)return cached;
    if(!this.engine){
      // Renderer policy is supplied by the prepared synth bundle at build time.
      // Load it only for real rendering so controller tests can inject a link.
      const {selectEngine}=await import('./policy.mjs');this.check(token);
      this.abort=new AbortController();
      const response=await fetch(new URL('./engines.json',import.meta.url),{signal:this.abort.signal});
      if(!response.ok)throw Error('Synth registry is unavailable.');
      const engine=selectEngine(await response.json());this.check(token);this.engine=engine;
    }
    const engine=this.engine;
    let result=await this.renderJob({recordText:payloadTimeline(packet,engine.identity,this.profile.id),engine,mode:'verify'},token);this.check(token);
    if(result.verdict!=='valid'||!result.canonical?.length)throw Error(result.stderr||'Synth refused this packet.');
    result=await this.renderJob({recordText:new TextDecoder().decode(result.canonical),engine,mode:'verify'},token);this.check(token);
    if(!result.verified||result.channels!==1||result.sampleRate!==48000||result.play?.clipped!=='0'||!result.pcm?.length||result.pcm.length>48000*this.profile.maxRenderSeconds)throw Error('Synth packet verification did not complete.');
    this.cache.set(key,result.pcm);
    while(this.cache.size>4)this.cache.delete(this.cache.keys().next().value);
    return result.pcm;
  }
  async send(input){
    if(!this.running)throw Error('Tap Start before sending audio.');
    if(this.busy||this.playing)throw Error('An audio transmission is already in progress.');
    if(!(input instanceof Uint8Array)||!input.length||input.length>128)throw Error('Audio packets must contain 1–128 bytes.');
    const packet=new Uint8Array(input),token=this.generation;this.busy=true;
    try{
      this.onStatus('Preparing automatic reply…');
      const pcm=await this.prepare(packet,token);this.check(token);
      const context=this.context;if(context.state!=='running')throw Error('Audio was interrupted. Tap Start to resume.');
      this.playing=true;this.resetReceiver();
      const buffer=context.createBuffer(1,pcm.length,48000);buffer.getChannelData(0).set(Float32Array.from(pcm,value=>value/32768));
      const source=context.createBufferSource(),gain=context.createGain();source.buffer=buffer;
      // Telephone scales Nearby PCM. Near-ultrasonic already carries its
      // frequency map and 40 ms symbols in the verified timeline.
      source.playbackRate.value=this.profile.playbackRate;
      // Full verified amplitude. The device's own output volume remains under
      // user control; no app setting can attenuate or amplify this signal.
      gain.gain.value=MAX_PLAYBACK_GAIN;source.connect(gain).connect(context.destination);this.source=source;
      this._connectVisualOutput(gain);
      await new Promise((resolve,reject)=>{
        const cancel=()=>{this.cancelWaiters.delete(cancel);reject(cancelled());};this.cancelWaiters.add(cancel);
        source.onended=()=>{
          this.cancelWaiters.delete(cancel);
          if(token!==this.generation){reject(cancelled());return;}
          this.source=null;this._endVisualOutput();resolve();
        };
        this._visualPlayback=true;source.start();this.onStatus('Sending automatically…');
      });this.check(token);
      this._metrics.txFrames++;this._metrics.txBytes+=packet.length;this._reportMetrics();
      this.allowedAfter=context.currentTime+0.35;
      await this.wait(350);this.check(token);
      this.resetReceiver();this.playing=false;this.busy=false;
      this.onStatus('Listening automatically…');
    }catch(error){if(token===this.generation)this.fail(error);throw error;}
  }
}
