// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {AudioSession, isProtocolPacket, MAX_TEXT_BYTES} from './session.mjs';
import {MAX_CLEAR_TEXT_BYTES, isClearPacket, encodeClearData, decodeClearPacket, clearControl, sameClearTransfer} from './clear-session.mjs';
import {AutoAudioLink} from './auto-audio-link.mjs';
import {getAudioProfile} from './audio-profiles.mjs';
import {getCryptoProfile, checkCryptoProfile} from './crypto-profiles.mjs';
import {DEFAULT_PEER_IDLE_TIMEOUT_MS, MAX_PEER_IDLE_TIMEOUT_MS, transferLifetimeMs} from './transfer-limits.mjs';
export {DEFAULT_PEER_IDLE_TIMEOUT_MS} from './transfer-limits.mjs';

const DEFAULT_TIMING = Object.freeze({retryMs:8000, retryJitterMs:1000,
  turnaroundMs:500, initialDelayMs:250, maxRunMs:180000, lingerMs:60000,
  maxAttempts:8});
const key = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const abort = () => new DOMException('Transfer stopped.', 'AbortError');
const monotonic = () => globalThis.performance?.now() ?? Date.now();

/** One message per explicit Start. Only the sender retries proactively, so the
 * receiver's responses get an uninterrupted turn. All trust decisions remain
 * outside audio transport: Simple encrypts without human peer verification;
 * Verify requires confirm() on each device before its initial READY is sent. */
export class AutoTransfer {
  constructor({transportFactory, onChange = () => {}, onMessage = () => {}, timing = {}, random = Math.random, cryptoCheck = checkCryptoProfile, now = monotonic} = {}) {
    this._factory = transportFactory || (callbacks => new AutoAudioLink(callbacks));
    this._onChange = onChange; this._onMessage = onMessage;
    this._baseTiming = Object.freeze({...DEFAULT_TIMING, ...timing});
    this._timing = {...this._baseTiming}; this._random = random;
    this._cryptoCheck = cryptoCheck; this._cryptoProfile = 'p256'; this._cryptoReady = false;
    this._session = new AudioSession(); this._generation = 0;
    this._active = false; this._transport = null; this._timers = new Set();
    this._inbound = Promise.resolve(); this._transmit = Promise.resolve();
    this._state = {phase:'idle', role:null, status:'Write a message on one device, leave the other empty, then press Start on both.', attempt:0};
    this._fingerprint = ''; this._humanConfirmed = false;
    this._localConfirmed = false; this._peerConfirmed = false; this._verifyPeer = false;
    this._now = now; this._idleTimeoutMs = DEFAULT_PEER_IDLE_TIMEOUT_MS;
    this._peerIdleTimer = undefined; this._peerIdleDeadline = null; this._lastPeerAt = null;
  }

  get state() {
    return {...this._state, active:this._active, lifetimeMs:this._timing.maxRunMs, fingerprint:this._fingerprint,
      localConfirmed:this._localConfirmed, peerConfirmed:this._peerConfirmed,
      peerVerified:this._humanConfirmed,
      peerIdle:{timeoutMs:this._idleTimeoutMs,
        remainingMs:this._active && this._peerIdleDeadline !== null ? Math.max(0,Math.round(this._peerIdleDeadline-this._now())) : null,
        lastPeerAgeMs:this._lastPeerAt === null ? null : Math.max(0,Math.round(this._now()-this._lastPeerAt))},
      verification:this._verifyPeer ? this._humanConfirmed ? 'verified' : 'required' : 'automatic'};
  }
  get info() { return this.state; }
  readAudioVisuals() {
    try { return this._transport?.readAudioVisuals?.() || null; } catch { return null; }
  }

  _emit(phase = this._state.phase, status = this._state.status) {
    const info = this._session.info;
    if (info.fingerprint) this._fingerprint = info.fingerprint;
    this._localConfirmed = info.localConfirmed || this._localConfirmed;
    this._peerConfirmed = info.peerConfirmed || this._peerConfirmed;
    this._state = {...this._state, phase, status};
    this._onChange(this.state);
  }
  _check(generation) { if (!this._active || generation !== this._generation) throw abort(); }
  _timer(callback, milliseconds) {
    const handle = setTimeout(() => { this._timers.delete(handle); callback(); }, Math.max(0,milliseconds));
    this._timers.add(handle); return handle;
  }
  _clearTimer(handle) { if (handle !== undefined) { clearTimeout(handle); this._timers.delete(handle); } }
  _armPeerIdle(generation) {
    if (!this._active || generation !== this._generation) return;
    this._clearTimer(this._peerIdleTimer);
    this._peerIdleDeadline = this._now()+this._idleTimeoutMs;
    const handle = this._timer(() => {
      if (!this._active || generation !== this._generation || this._peerIdleTimer !== handle) return;
      this._peerIdleTimer = undefined;
      this._peerTimedOut(generation);
    },this._idleTimeoutMs);
    this._peerIdleTimer = handle;
  }
  _peerProgress(generation) {
    if (!this._active || generation !== this._generation) return;
    this._lastPeerAt = this._now();
    this._armPeerIdle(generation);
  }
  _peerTimedOut(generation) {
    if (this._received) {
      this._finish('received',this._mode === 'clear'
        ? 'Cleartext received. Final confirmation was not heard; microphone and playback stopped automatically. The sender is not authenticated.'
        : 'Message received. No further peer response arrived; microphone and playback stopped automatically.');
      return;
    }
    this._fail(Error(`No new peer response for ${this._idleTimeoutMs/1000} seconds. Microphone and playback stopped. Keep both pages visible and press Start on both devices to try again.`),generation);
  }
  _wait(milliseconds, generation) {
    return new Promise(resolve => {
      const handle = this._timer(() => { this._waiters.delete(resolve); resolve(); }, milliseconds);
      this._waiters.set(resolve, handle);
    }).then(() => this._check(generation));
  }
  _resetRun() {
    this._cryptoReady = false;
    this._session.reset(); this._text = ''; this._flight = null; this._retryTimer = undefined;
    this._answer = null; this._acceptedAnswer = null; this._localReady = null; this._peerReady = null;
    this._confirmPromise = null;
    this._rekeyStarted = false; this._rekeyComplete = false; this._dataPacket = null;
    this._received = false; this._ownPackets = new Set(); this._responseKeys = new Set();
    this._clearData = null; this._clearAcknowledged = false;
    this._waiters = new Map(); this._inbound = Promise.resolve(); this._transmit = Promise.resolve();
    this._fingerprint = ''; this._humanConfirmed = false; this._localConfirmed = false; this._peerConfirmed = false;
    this._peerIdleTimer = undefined; this._peerIdleDeadline = null; this._lastPeerAt = null;
  }
  _cleanup() {
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    this._peerIdleTimer = undefined; this._peerIdleDeadline = null;
    for (const resolve of this._waiters?.keys() || []) resolve();
    this._waiters?.clear();
    this._transport?.stop();
    if (this._transport?.metrics) this._state = {...this._state,metrics:{...this._transport.metrics}};
    this._transport = null;
    this._text = ''; this._flight = null; this._dataPacket = null;
    this._clearData = null; this._clearAcknowledged = false;
    this._answer = null; this._acceptedAnswer = null; this._localReady = null; this._peerReady = null;
    this._ownPackets?.clear(); this._responseKeys?.clear();
    this._session.reset();
  }
  stop() {
    this._generation++; this._active = false; this._cleanup();
    this._emit('stopped', 'Stopped. Microphone, playback, pending message, and session keys were released.');
  }
  _finish(phase, status) {
    if (!this._active) return;
    this._emit(phase, status);
    this._active = false; this._generation++; this._cleanup();
    this._emit(phase, status);
  }
  _fail(error, generation = this._generation) {
    if (!this._active || generation !== this._generation) return;
    if (this._mode === 'clear' && this._clearAcknowledged) {
      this._finish('delivered','Delivery confirmed by a matching cleartext checksum receipt. Final confirmation could not be sent. The receipt is not authenticated.');
      return;
    }
    this._finish('error', error?.message || 'The transfer did not complete. Press Start on both devices to try again.');
  }

  // Call directly from the Start click: transport.start() opens/resumes audio
  // synchronously before the first await, preserving the browser user gesture.
  async start({mode = 'message', text = '', verifyPeer = false, volume, profile = 'nearby', cryptoProfile = 'p256', idleTimeoutMs = DEFAULT_PEER_IDLE_TIMEOUT_MS} = {}) {
    if (this._active) throw Error('Stop the current transfer before starting another.');
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > MAX_PEER_IDLE_TIMEOUT_MS) throw Error('Idle timeout must be between 1 and 3600 seconds.');
    const audioProfile = getAudioProfile(profile);
    const selectedCrypto = getCryptoProfile(cryptoProfile);
    if (!['message','password','clear'].includes(mode) || typeof text !== 'string') throw Error('Choose a supported mode and text.');
    const encoded = new TextEncoder().encode(text), limit = mode === 'clear' ? MAX_CLEAR_TEXT_BYTES : MAX_TEXT_BYTES;
    if (encoded.length > limit || new TextDecoder('utf-8',{fatal:true}).decode(encoded) !== text) throw Error(`Use valid text with at most ${limit} UTF-8 bytes.`);
    this._cleanup();
    this._cryptoProfile = selectedCrypto.id;
    this._session = this._createSession(selectedCrypto.id);
    this._resetRun();
    this._idleTimeoutMs = idleTimeoutMs;
    this._cryptoReady = mode === 'clear' || selectedCrypto.id === 'p256';
    // A slower response needs a longer retry budget. Echo guards, turnaround,
    // human confirmation, and the absolute run limit remain wall-clock times.
    this._timing = {...this._baseTiming,
      maxRunMs:transferLifetimeMs(this._baseTiming.maxRunMs,idleTimeoutMs),
      retryMs:this._baseTiming.retryMs * audioProfile.timingScale,
      retryJitterMs:this._baseTiming.retryJitterMs * audioProfile.timingScale};
    const generation = ++this._generation;
    this._mode = mode; this._text = text; this._verifyPeer = mode !== 'clear' && Boolean(verifyPeer);
    this._state = {phase:'starting', role:text.length ? 'sender' : 'receiver', profile:audioProfile.id, cryptoProfile:mode === 'clear' ? null : selectedCrypto.id, status:'Opening microphone and audio…', attempt:0};
    this._active = true;
    this._transport = this._factory({
      ...this._transportOptions(), volume, profile:audioProfile.id,
      onPackets: packets => this.receive(packets),
      onStatus: audioStatus => {
        if (!this._active || generation !== this._generation) return;
        this._state = {...this._state, audioStatus};
        this._onChange(this.state);
      },
      onError: error => this._fail(error,generation),
      onMetrics: metrics => {
        if (!this._active || generation !== this._generation) return;
        this._state = {...this._state,metrics:{...metrics}};
        this._onChange(this.state);
      },
    });
    this._emit();
    this._timer(() => {
      if (this._mode === 'clear' && this._received) this._finish('received','Cleartext received. Final confirmation was not heard; audio stopped automatically.');
      else this._fail(Error('Transfer timed out. Keep both pages visible and press Start on both devices to try again.'),generation);
    }, this._timing.maxRunMs);
    try {
      const opening = this._transport.start();
      // Keep audio activation in the original Start gesture. A receiver also
      // checks native compact-crypto support before accepting any packets.
      await Promise.all([opening, this._cryptoReady ? undefined : this._cryptoCheck(selectedCrypto.id)]);
      this._check(generation); this._cryptoReady = true;
      // Permission prompts do not consume the response window. Once capture
      // is open, only accepted peer progress renews this wall-clock deadline.
      this._armPeerIdle(generation);
      if (mode === 'clear') {
        if (this._state.role === 'receiver') this._emit('receiving','Listening for a cleartext message. The sender can press Start before or after you.');
        else {
          const packet = await encodeClearData(this._text); this._check(generation); this._text = '';
          this._clearData = await decodeClearPacket(packet); this._check(generation);
          this._emit('sending','Sending cleartext and waiting for its checksum receipt. Receipts are not authenticated.');
          this._setFlight(packet,'clear-data',generation,this._timing.initialDelayMs);
        }
        return this.state;
      }
      if (this._state.role === 'sender') {
        const offer = await this._session.offer(); this._check(generation);
        this._emit('discovering','Finding the receiver. Press Start on the other device with its message field empty.');
        this._setFlight(offer,'offer',generation,this._timing.initialDelayMs);
      } else if (!this._session.info.fingerprint) this._emit('discovering','Listening for the sender. It can press Start before or after you.');
      return this.state;
    } catch (error) { this._fail(error,generation); return this.state; }
  }

  // Extension point for bounded application transfers; ordinary runs retain
  // the transport's three-minute default.
  _transportOptions() { return this._timing.maxRunMs > DEFAULT_TIMING.maxRunMs ? {maxRunMs:this._timing.maxRunMs} : {}; }
  _createSession(cryptoProfile) { return new AudioSession({cryptoProfile}); }

  _jitter() { return this._timing.retryJitterMs * this._random(); }
  _dropFlight() { this._clearTimer(this._retryTimer); this._retryTimer = undefined; this._flight = null; }
  _setFlight(packet, kind, generation, delay = this._timing.turnaroundMs) {
    this._dropFlight();
    const flight = {packet:packet.slice(),kind,attempts:0}; this._flight = flight;
    this._sendFlight(flight,generation,delay);
  }
  async _sendFlight(flight,generation,delay) {
    if (!this._active || generation !== this._generation || this._flight !== flight) return;
    if (flight.attempts >= this._timing.maxAttempts) { this._fail(Error('No response after several attempts. Move the devices closer, keep both pages visible, then press Start on both again.'),generation); return; }
    flight.attempts++; this._state.attempt = flight.attempts; this._emit();
    try {
      await this._queueSend(flight.packet,generation,delay,() => this._flight === flight);
      this._check(generation);
      if (this._flight !== flight) return;
      this._retryTimer = this._timer(() => this._sendFlight(flight,generation,0),this._timing.retryMs + this._jitter());
    } catch (error) { this._fail(error,generation); }
  }
  _queueSend(packet,generation,delay = this._timing.turnaroundMs,guard = () => true) {
    const snapshot = packet.slice();
    const job = this._transmit.then(async () => {
      this._check(generation); if (!guard()) return;
      await this._wait(delay,generation); if (!guard()) return;
      const id = key(snapshot); this._ownPackets.add(id);
      while (this._ownPackets.size > 20) this._ownPackets.delete(this._ownPackets.values().next().value);
      await this._transport.send(snapshot); this._check(generation);
    });
    const checked = job.catch(error => { if (error?.name !== 'AbortError') this._fail(error,generation); throw error; });
    this._transmit = checked.catch(() => {});
    return checked;
  }
  _respond(packet,generation) {
    // Coalesce overlapping window decodes; a later acoustic retry still gets a
    // response after this queued transmission completes.
    const id = key(packet);
    if (this._responseKeys.has(id)) return Promise.resolve();
    this._responseKeys.add(id);
    return this._queueSend(packet,generation).finally(() => this._responseKeys.delete(id));
  }

  confirm() {
    if (this._confirmPromise) return this._confirmPromise;
    const generation = this._generation;
    if (!this._active || this._mode === 'clear' || !this._session.info.fingerprint || this._session.info.localConfirmed) return Promise.reject(Error('Wait until the matching fingerprints appear on both devices.'));
    this._humanConfirmed = true;
    const promise = this._confirmLocal(generation).catch(error => this._fail(error,generation)).finally(() => {
      if (this._confirmPromise === promise) this._confirmPromise = null;
    });
    this._confirmPromise = promise;
    return promise;
  }
  async _confirmLocal(generation) {
    if (!this._session.info.localConfirmed) this._localReady = await this._session.confirm();
    this._check(generation);
    this._emit('confirming',this._state.role === 'sender' ? 'Confirming session keys with the receiver…' : 'Waiting for the sender’s session confirmation…');
    if (this._state.role === 'sender') this._setFlight(this._localReady,'ready',generation);
    else if (this._session.info.peerConfirmed) await this._respond(this._localReady,generation);
  }
  async _verification(generation) {
    this._check(generation);
    if (this._verifyPeer && !this._humanConfirmed) this._emit('verify','Compare every fingerprint group on both screens, then confirm on this device. No message has been sent.');
    else await this._confirmLocal(generation);
  }

  receive(packets) {
    if (!Array.isArray(packets) || !this._active || !this._cryptoReady) return Promise.resolve();
    const generation = this._generation;
    // Keep the callback bounded even if a faulty transport supplies a flood.
    // Overlapping decoder windows can report the same physical packet in one
    // batch. Coalesce that batch before awaiting replies; a later callback is
    // still a new acoustic retry and must receive another ACK when appropriate.
    const seen = new Set();
    const snapshots = packets.slice(0,8).filter(packet => packet instanceof Uint8Array && packet.length <= 128).map(packet => packet.slice()).filter(packet => {
      const id = key(packet); if (seen.has(id)) return false; seen.add(id); return true;
    });
    const job = this._inbound.then(async () => {
      for (const packet of snapshots) {
        this._check(generation);
        try { await this._receive(packet,generation); }
        catch (error) { if (error?.name === 'AbortError') throw error; /* Untrusted input cannot terminate an established transfer. */ }
      }
    });
    this._inbound = job.catch(error => { if (error?.name !== 'AbortError') this._fail(error,generation); });
    return this._inbound;
  }
  async _receive(packet,generation) {
    const id = key(packet);
    if (this._ownPackets.has(id)) return;
    if (this._mode === 'clear') {
      await this._receiveClear(packet,generation); return;
    }
    if (!isProtocolPacket(packet)) return;
    if (this._state.role === 'sender' && packet[2] === 1) {
      if (this._state.phase === 'discovering') {
        // Validate the foreign offer without replacing this run's own session.
        const probe = this._createSession(this._cryptoProfile);
        try {
          const offered = await probe.receive(packet); this._check(generation);
          if (offered.type === 'offer') this._fail(Error('Both devices are sending. Leave the receiving device’s message field empty, then press Start on both again.'),generation);
        } finally { probe.reset(); }
      }
      return;
    }
    if (this._state.role === 'receiver' && !this._session.info.fingerprint && packet[2] !== 1) return;
    if (!this._rekeyStarted && this._peerReady && id === key(this._peerReady)) {
      if (this._state.role === 'receiver' && this._localReady) await this._respond(this._localReady,generation);
      return;
    }
    if (this._acceptedAnswer && id === key(this._acceptedAnswer)) {
      if (!this._rekeyStarted && this._localReady && this._state.role === 'sender') await this._respond(this._localReady,generation);
      return;
    }
    if (this._received && packet[2] !== 3) return;
    const before = this._session.info.state;
    const result = await this._session.receive(packet); this._check(generation);
    if (result.type === 'offer') {
      this._peerProgress(generation);
      this._answer = result.outbound.slice();
      await this._respond(result.outbound,generation);
      await this._verification(generation); return;
    }
    if (result.type === 'answer') {
      this._peerProgress(generation);
      this._acceptedAnswer = packet.slice(); this._dropFlight();
      await this._verification(generation); return;
    }
    if (result.type === 'ready' && !this._rekeyStarted) {
      this._peerProgress(generation);
      this._peerReady = packet.slice();
      if (this._state.role === 'receiver') {
        if (this._localReady) await this._respond(this._localReady,generation);
        else this._emit('verify','The sender has confirmed. Compare the fingerprints and confirm here to continue.');
      } else {
        this._dropFlight();
        if (this._session.info.state !== 'ready') return;
        this._rekeyStarted = true;
        const outbound = await this._session.rekey(); this._check(generation);
        this._emit('rekeying','Refreshing session keys inside the encrypted connection…');
        this._setFlight(outbound,'rekey',generation);
      }
      return;
    }
    if (result.type === 'rekey' || (result.type === 'ready' && this._rekeyStarted)) {
      this._peerProgress(generation);
      this._rekeyStarted = true;
      if (this._state.role === 'sender') this._dropFlight();
      this._emit('rekeying','Refreshing session keys inside the encrypted connection…');
      if (this._session.info.state === 'ready') {
        this._rekeyComplete = true;
        if (result.outbound) await this._respond(result.outbound,generation);
        if (this._state.role === 'sender') await this._sendMessage(generation);
        else this._emit('receiving','Encrypted key refresh complete. Listening for the message…');
      } else if (result.outbound) {
        if (this._state.role === 'sender') this._setFlight(result.outbound,'rekey',generation);
        else await this._respond(result.outbound,generation);
      }
      return;
    }
    if (result.type === 'message' || result.type === 'password') {
      if (this._rekeyComplete) this._peerProgress(generation);
      await this._handlePayload(result,generation); return;
    }
    if (result.type === 'ack') {
      if (result.acknowledged.length) this._peerProgress(generation);
      await this._handleAck(result,generation); return;
    }
    if (result.type === 'chat-turn') { await this._handleChatTurn(result,generation); return; }
    if (result.type === 'duplicate' && (result.outbound || result.receipt)) {
      if (result.receipt) {
        await this._handleDuplicateReceipt(result,generation);
      } else if (packet[2] === 1) {
        if (!this._rekeyStarted && this._state.role === 'receiver') await this._respond(result.outbound,generation);
      } else if (this._rekeyStarted && (before === 'rekeying' || this._rekeyComplete)) await this._respond(result.outbound,generation);
    }
  }
  async _handleDuplicateReceipt(result,generation) {
    if (this._received && this._rekeyComplete && this._state.role === 'receiver') await this._respond(result.outbound,generation);
  }
  async _handleChatTurn() {}
  async _handlePayload(result,generation) {
    if (this._state.role !== 'receiver' || !this._rekeyComplete) return;
    if (!this._received) {
      this._received = true;
      this._onMessage({type:result.type,text:result.text});
      this._emit('received','Message received. Returning its receipt and listening briefly for retries…');
      this._timer(() => this._finish('received','Message received. Audio stopped automatically.'),this._timing.lingerMs);
    }
    if (result.outbound) await this._respond(result.outbound,generation);
  }
  async _handleAck(result,generation) {
    if (this._state.role !== 'sender' || !this._dataPacket || this._session.info.pendingCount !== 0) return;
    this._dropFlight();
    this._finish('delivered','Delivery confirmed by an encrypted receipt from the connected peer.');
  }
  async _receiveClear(packet,generation) {
    if (!isClearPacket(packet)) return;
    const record = await decodeClearPacket(packet); this._check(generation);
    if (this._state.role === 'sender') {
      if (record.kind === 'data' && this._flight?.kind === 'clear-data') {
        this._fail(Error('Both devices are sending. Leave the receiving device’s message field empty, then press Start on both again.'),generation);
        return;
      }
      if (record.kind !== 'ack' || !this._clearData || !sameClearTransfer(record,this._clearData) || this._flight?.kind !== 'clear-data') return;
      this._peerProgress(generation);
      this._clearAcknowledged = true;
      this._dropFlight();
      this._emit('sending','Checksum receipt received. Sending final confirmation…');
      await this._respond(clearControl(record.packet,'fin'),generation); this._check(generation);
      this._finish('delivered','Delivery confirmed by a matching cleartext checksum receipt. The receipt is not authenticated.');
      return;
    }
    if (record.kind === 'data') {
      if (this._clearData && (!sameClearTransfer(record,this._clearData) || key(packet) !== key(this._clearData.packet))) return;
      if (!this._received) {
        this._peerProgress(generation);
        this._clearData = record; this._received = true;
        this._onMessage({type:'clear',text:record.text});
        this._emit('received','Cleartext received and checksum checked. Returning its receipt; sender is not authenticated.');
        this._timer(() => this._finish('received','Cleartext received. Final confirmation was not heard; audio stopped automatically.'),this._timing.lingerMs);
      }
      await this._respond(clearControl(record.packet,'ack'),generation);
    } else if (record.kind === 'fin' && this._received && sameClearTransfer(record,this._clearData)) {
      this._finish('received','Cleartext received. Final confirmation received; audio stopped. The sender is not authenticated.');
    }
  }
  async _sendMessage(generation) {
    if (this._dataPacket) return;
    const packet = await this._session.send(this._mode,this._text); this._check(generation);
    this._text = ''; this._dataPacket = packet.slice();
    this._emit('sending','Sending the encrypted message and waiting for its receipt…');
    this._setFlight(packet,'message',generation);
  }
}
