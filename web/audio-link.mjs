// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {payloadTimeline} from './communication-codec.mjs';
import {selectEngine} from './policy.mjs';
import {MAX_PLAYBACK_GAIN,ScreenAwake} from './audio-environment.mjs';

const cancelled = () => new DOMException('Audio operation cancelled.', 'AbortError');
function audioSessionType(type) {
  try { if (globalThis.navigator?.audioSession) navigator.audioSession.type = type; } catch {}
}

// This layer transports bytes only. Authentication belongs to the session layer.
export class AudioLink {
  constructor({onStatus = () => {}, onPackets = () => {}, onError = () => {}} = {}) {
    this.onStatus = onStatus; this.onPackets = onPackets; this.onError = onError;
    this.generation = 0; this.prepared = null; this.busy = false;
    this.context = null; this.source = null; this.stream = null; this.captureNode = null;
    this.abort = null; this.stopWorker = null; this.stopPlayback = null; this.capture = null; this.timer = null;
    this.volume = MAX_PLAYBACK_GAIN; this.screenAwake = new ScreenAwake();
  }
  get recording() { return !!this.stream; }
  get playing() { return !!this.source; }
  check(token) { if (token !== this.generation) throw cancelled(); }
  haltMedia() {
    this.screenAwake.stop();
    clearTimeout(this.timer); this.timer = null;
    try { this.source?.stop(); } catch {}
    this.source = null;
    this.captureNode?.disconnect(); this.captureNode = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.context?.close().catch(() => {}); this.context = null;
    audioSessionType('auto');
  }
  cancel() {
    this.generation++;
    this.abort?.abort(); this.abort = null;
    this.stopWorker?.(); this.stopWorker = null;
    this.stopPlayback?.(); this.stopPlayback = null;
    this.haltMedia();
    this.capture?.reject(cancelled()); this.capture = null;
    this.busy = false;
  }
  clear() { this.cancel(); this.prepared = null; }
  job(filename, data, transfer = []) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL(filename, import.meta.url), {type:'module'});
      let done = false;
      const finish = (error, value) => {
        if (done) return; done = true;
        clearTimeout(timer); worker.terminate();
        if (this.stopWorker === stop) this.stopWorker = null;
        error ? reject(error) : resolve(value);
      };
      const stop = () => finish(cancelled());
      const timer = setTimeout(() => finish(Error('Audio processing exceeded 60 seconds.')), 60000);
      this.stopWorker = stop;
      worker.onerror = event => finish(Error(event.message || 'Audio worker failed.'));
      worker.onmessage = event => finish(null, event.data);
      worker.postMessage(data, transfer);
    });
  }
  async prepare(packet) {
    if (!(packet instanceof Uint8Array) || !packet.length || packet.length > 128)
      throw Error('Audio packets must contain 1–128 bytes.');
    // Snapshot the caller's packet before any asynchronous work.
    packet = packet.slice();
    this.clear(); const token = this.generation; this.busy = true;
    this.abort = new AbortController(); this.onStatus('Preparing audio…');
    try {
      const response = await fetch(new URL('./engines.json', import.meta.url), {signal:this.abort.signal});
      if (!response.ok) throw Error('Synth registry is unavailable.');
      const engine = selectEngine(await response.json()); this.check(token);
      const recordText = payloadTimeline(packet, engine.identity);
      let result = await this.job('./worker.mjs', {recordText, engine, mode:'verify'}); this.check(token);
      if (result.verdict !== 'valid' || !result.canonical?.length)
        throw Error(result.stderr || 'Synth refused this packet.');
      result = await this.job('./worker.mjs', {recordText:new TextDecoder().decode(result.canonical), engine, mode:'verify'});
      this.check(token);
      if (!result.verified || result.channels !== 1 || result.sampleRate !== 48000 ||
          result.play?.clipped !== '0' || !result.pcm?.length || result.pcm.length > 48000 * 4.2)
        throw Error('Synth packet verification did not complete.');
      // Do not retain the reversible TL representation or a copy of the packet.
      this.prepared = {pcm:result.pcm, seconds:result.pcm.length / 48000, bytes:packet.length};
      this.busy = false; this.abort = null;
      this.onStatus(`Ready to play (${this.prepared.seconds.toFixed(2)} seconds).`);
      return {seconds:this.prepared.seconds, bytes:this.prepared.bytes};
    } catch (error) { if (token === this.generation) this.cancel(); throw error; }
  }
  async play() {
    if (!this.prepared) throw Error('Prepare a packet before playback.');
    this.cancel(); const token = this.generation;
    try {
      audioSessionType('playback');
      void this.screenAwake.start();
      const context = new AudioContext({sampleRate:48000}); this.context = context;
      await context.resume(); this.check(token);
      const pcm = this.prepared.pcm, buffer = context.createBuffer(1, pcm.length, 48000);
      buffer.getChannelData(0).set(Float32Array.from(pcm, value => value / 32768));
      const source = context.createBufferSource(), gain = context.createGain();
      gain.gain.value = MAX_PLAYBACK_GAIN;
      source.buffer = buffer; source.connect(gain).connect(context.destination); this.source = source;
      await new Promise((resolve,reject) => {
        this.stopPlayback = () => reject(cancelled());
        source.onended = () => {
          if (token !== this.generation) return;
          this.stopPlayback = null;
          this.source = null; context.close().catch(() => {}); this.context = null;
          audioSessionType('auto');
          this.screenAwake.stop();
          this.onStatus('Playback finished.'); resolve();
        };
        source.start(); this.onStatus('Playing audio packet…');
      });
    } catch (error) { if (token === this.generation) this.cancel(); throw error; }
  }
  async listen() {
    this.cancel(); const token = this.generation; this.busy = true;
    this.onStatus('Requesting microphone…');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('Microphone capture requires HTTPS or localhost.');
      // A retained playback override can end capture tracks in Audio Session
      // implementations (notably Safari). Pairing alternates send and receive.
      audioSessionType('play-and-record');
      const context = new AudioContext({sampleRate:48000}); this.context = context;
      const resumed = context.resume(); resumed.catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1, echoCancellation:false,
        noiseSuppression:false, autoGainControl:false}, video:false});
      if (token !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw cancelled(); }
      this.stream = stream;
      void this.screenAwake.start();
      const captureDeadline = Date.now() + 20000;
      // Bound media ownership even when audio setup stalls after permission.
      this.timer = setTimeout(() => {
        if (token !== this.generation) return;
        this.cancel(); this.onStatus('Microphone setup timed out. Please try again.');
      }, 20000);
      await resumed; this.check(token);
      if (![44100,48000].includes(context.sampleRate)) throw Error('Use an input device at 44.1 or 48 kHz.');
      await context.audioWorklet.addModule(new URL('./communication-capture.mjs', import.meta.url)); this.check(token);
      const capture = {parts:[], frames:0, rate:context.sampleRate, token, ending:false};
      capture.promise = new Promise((resolve,reject) => { capture.resolve = resolve; capture.reject = reject; });
      capture.promise.catch(() => {}); this.capture = capture;
      const node = new AudioWorkletNode(context, 'bounded-communication-capture', {processorOptions:{maximum:context.sampleRate*20}});
      this.captureNode = node;
      node.port.onmessage = ({data}) => {
        if (token !== this.generation || this.capture !== capture || capture.ending) return;
        if (data.samples) {
          capture.frames += data.samples.length;
          if (capture.frames > capture.rate * 20) { this.cancel(); this.onError(Error('Capture exceeded its limit.')); return; }
          capture.parts.push(data.samples);
        }
        if (data.done) this.decodeCapture(capture);
      };
      context.createMediaStreamSource(stream).connect(node).connect(context.destination);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.decodeCapture(capture), Math.max(0,captureDeadline-Date.now()));
      this.busy = false; this.onStatus('Listening locally. Play on the other device, then stop and decode.');
    } catch (error) { if (token === this.generation) this.cancel(); throw error; }
  }
  async finish() {
    const capture = this.capture;
    if (!capture) throw Error('Start listening first.');
    if (!capture.ending) {
      this.captureNode?.port.postMessage({finish:true});
      // A suspended AudioWorklet may not deliver its final partial chunk.
      clearTimeout(this.timer); this.timer = setTimeout(() => this.decodeCapture(capture), 250);
    }
    return capture.promise;
  }
  async decodeCapture(capture) {
    if (capture.token !== this.generation || this.capture !== capture || capture.ending) return;
    capture.ending = true; this.haltMedia(); this.busy = true;
    this.onStatus('Decoding captured audio…');
    try {
      if (!capture.frames) throw Error('No audio was captured. Please try again.');
      const samples = new Float32Array(capture.frames); let offset = 0;
      for (const part of capture.parts) { samples.set(part,offset); offset += part.length; }
      capture.parts = [];
      const result = await this.job('./packet-worker.mjs', {samples, rate:capture.rate}, [samples.buffer]);
      this.check(capture.token);
      if (!result.ok) throw Error(result.error);
      this.capture = null; this.busy = false;
      this.onStatus(result.packets.length ? `Recovered ${result.packets.length} audio packet(s).` : 'No packet recovered. Try closer devices and a quieter room.');
      await this.onPackets(result.packets);
      capture.resolve(result.packets);
    } catch (error) {
      capture.reject(error);
      if (capture.token === this.generation) {
        this.capture = null; this.busy = false;
        this.onStatus(error.message); this.onError(error);
      }
    }
  }
}
