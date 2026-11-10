// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Persistent, bounded half-duplex encrypted chat. No transcript is retained here.
import {AutoTransfer} from './auto-transfer.mjs';
import {AudioSession,MAX_TEXT_BYTES} from './session.mjs';
import {getAudioProfile} from './audio-profiles.mjs';

const MAX_PENDING = 8, MAX_RUN_MS = 600000;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8',{fatal:true});
const fingerprint = packet => Array.from(packet,value=>value.toString(16).padStart(2,'0')).join('');
const monotonic = () => globalThis.performance?.now() ?? Date.now();
function validText(text) {
  if (typeof text !== 'string' || !text.length) throw Error('Enter a nonempty message.');
  const bytes = encoder.encode(text);
  if (bytes.length > MAX_TEXT_BYTES || decoder.decode(bytes) !== text) throw Error(`Use valid text with at most ${MAX_TEXT_BYTES} UTF-8 bytes.`);
}

/** The original sender owns the poll clock for the complete session. Each turn
 * carries at most one retained DATA frame followed by one authenticated control
 * frame. The responder never transmits without a current poll. Poll retries
 * repeat the exact turn; duplicate responses cannot advance the initiator twice.
 * Audio uses frame-relative guards, not synchronized wall clocks. */
export class ChatTransfer extends AutoTransfer {
  constructor(options = {}) {
    const timing = {maxRunMs:MAX_RUN_MS,turnTimeoutMs:18000,idlePollMs:1000,maxIdlePollMs:5000,closeTimeoutMs:180000,closeMaxAttempts:3,...options.timing};
    if (!Number.isInteger(timing.maxRunMs) || timing.maxRunMs < 1 || timing.maxRunMs > MAX_RUN_MS) throw Error('Chat lifetime must be positive and at most ten minutes.');
    for (const name of ['turnTimeoutMs','idlePollMs','maxIdlePollMs']) if (!Number.isFinite(timing[name]) || timing[name] < 0 || (name === 'turnTimeoutMs' && timing[name] === 0)) throw Error('Invalid chat timing.');
    timing.closeLingerMs ??= 2*timing.turnTimeoutMs+10000;
    for (const name of ['closeTimeoutMs','closeLingerMs','closeMaxAttempts']) if (!Number.isSafeInteger(timing[name]) || timing[name] < 1) throw Error('Invalid chat close timing.');
    super({...options,timing});
    this._onDelivery = options.onDelivery || (()=>{});
    this._clearChat();
  }
  _createSession(cryptoProfile) { return new AudioSession({cryptoProfile,purpose:'chat'}); }
  _transportOptions() { return {maxRunMs:this._timing.maxRunMs}; }
  _clearChat() {
    this._chatConnected = false; this._turn = 0; this._lastPeerTurn = 0;
    this._poll = null; this._response = null; this._idleRounds = 0;
    this._nextPollTimer = undefined; this._turnTimer = undefined;
    this._sendingTurn = false; this._enqueuePending = 0;
    this._messageIdleTimer = undefined; this._messageIdleDeadline = null;
    this._lastMessageAt = null; this._peerPending = false;
    this._admitted = new Map(); this._sentData = new Set();
    this._chatStats = {turns:0,retries:0,duplicates:0,rejectedFrames:0,delivered:0,received:0,lastDeliveryMs:null};
    this._close = {initiator:null,reason:null,localRequested:false,peerClosing:false,stage:'none',outcome:null,peerAckSeen:false,finalSeen:false,pendingAtEnd:0};
    this._closeDeadline = null; this._closeTimer = undefined; this._lingerTimer = undefined;
  }
  _cleanup() {
    const stats = this._chatStats, close = this._close;
    super._cleanup(); this._clearChat();
    if (stats) this._chatStats = stats;
    if (close?.outcome) this._close = close;
  }
  _resetRun() { super._resetRun(); this._clearChat(); }
  get state() {
    const base = super.state, pendingCount = this._session?.info.pendingCount || 0;
    return {...base,connected:Boolean(this._active && this._chatConnected),closing:Boolean(this._active && this._close.stage !== 'none'),
      close:{...this._close,remainingMs:this._close.outcome?0:this._closeDeadline===null?null:Math.max(0,Math.round(this._closeDeadline-monotonic()))},
      canSend:Boolean(this._active && this._chatConnected && this._close.stage === 'none' && pendingCount + (this._enqueuePending || 0) < MAX_PENDING),
      pendingCount,maxPending:MAX_PENDING,turn:this._turn || this._lastPeerTurn || 0,
      messageIdle:{timeoutMs:this._idleTimeoutMs,
        remainingMs:this._active && this._messageIdleDeadline !== null ? Math.max(0,Math.round(this._messageIdleDeadline-this._now())) : null,
        lastMessageAgeMs:this._lastMessageAt === null ? null : Math.max(0,Math.round(this._now()-this._lastMessageAt)),
        waitingForReceipts:Boolean(this._active && this._chatConnected && !this._closing() && (this._pending() || this._peerPending))},
      chatStats:{...this._chatStats}};
  }
  async start(options = {}) {
    if (options.mode && options.mode !== 'message') throw Error('Chat supports the Message channel only.');
    if (!this._active) this._runStartedAt = monotonic();
    // Super invokes transport.start synchronously in the original Start gesture.
    return super.start({...options,mode:'message',volume:1});
  }
  _pending() { return (this._session?.info.pendingCount || 0) + (this._enqueuePending || 0); }
  _closing() { return this._close.stage !== 'none' && !this._close.outcome; }
  _syncMessageIdle(activity = false) {
    if (activity) this._lastMessageAt = this._now();
    // Control-only keepalives prove peer liveness, not conversation activity.
    // Pause the conversation clock until both admitted queues have drained.
    if (!this._active || !this._chatConnected || this._closing() || this._pending() || this._peerPending) {
      this._clearTimer(this._messageIdleTimer); this._messageIdleTimer = undefined;
      this._messageIdleDeadline = null; return;
    }
    if (!activity && this._messageIdleDeadline !== null) return;
    this._clearTimer(this._messageIdleTimer);
    this._messageIdleDeadline = this._now()+this._idleTimeoutMs;
    const generation = this._generation;
    const handle = this._timer(()=>{
      if (!this._active || generation !== this._generation || this._messageIdleTimer !== handle) return;
      this._messageIdleTimer = undefined;
      if (this._pending() || this._peerPending) { this._syncMessageIdle(); return; }
      this._close.reason = 'message-idle'; this.close();
    },this._idleTimeoutMs);
    this._messageIdleTimer = handle;
  }
  _emitClosing() {
    const descriptions = {
      draining:'Ending chat. Finishing admitted messages and waiting for their delivery receipts…',
      committing:'Ending chat. Both message queues drained; waiting for the peer to acknowledge closing…',
      acknowledging:'Peer committed to ending chat. Sending the close acknowledgement…',
      'waiting-final':'Close acknowledgement sent. Listening briefly for the final confirmation or a retry…',
      finalizing:'Peer acknowledged closing. Sending the final confirmation…',
    };
    const prefix = this._close.reason === 'message-idle' ? `No message activity for ${this._idleTimeoutMs/1000} seconds. ` : '';
    this._emit('closing',prefix+(descriptions[this._close.stage] || 'Ending chat…'));
  }
  _beginClose(local) {
    if (local) this._close.localRequested = true;
    if (this._close.stage !== 'none') return;
    this._close.initiator = local ? 'local' : 'peer'; this._close.stage = 'draining';
    this._syncMessageIdle();
    const scale = getAudioProfile(this._state.profile).timingScale;
    this._closeDeadline = Math.min(this._runStartedAt+this._timing.maxRunMs,monotonic()+this._timing.closeTimeoutMs*scale);
    const generation = this._generation;
    this._closeTimer = this._timer(()=>{
      if (this._active && generation === this._generation) this._finishClose('unconfirmed','Chat stopped after the closing deadline. Peer closure was not confirmed; messages without delivery receipts remain unconfirmed.');
    },Math.max(0,this._closeDeadline-monotonic()));
  }
  close() {
    if (!this._active) return this.state;
    // Before a secure chat exists there is no authenticated peer to notify.
    if (!this._chatConnected) { this.stop(); return this.state; }
    this._beginClose(true); this._emitClosing();
    if (this._state.role === 'sender' && this._nextPollTimer !== undefined) {
      this._clearTimer(this._nextPollTimer); this._nextPollTimer = undefined;
      this._schedulePoll(this._generation,0);
    }
    return this.state;
  }
  stop() {
    if (this._active) this._close = {...this._close,initiator:this._close.initiator || 'local',stage:'closed',outcome:'aborted',pendingAtEnd:this._pending()};
    super.stop();
  }
  _finishClose(outcome,status) {
    if (!this._active) return;
    this._close = {...this._close,stage:'closed',outcome,pendingAtEnd:this._pending()};
    const prefix = this._close.reason === 'message-idle' ? `Idle timeout: ${this._idleTimeoutMs/1000} seconds without message activity. ` : '';
    this._finish('closed',prefix+status+' Microphone, playback, and session keys were released.');
  }
  _fail(error,generation=this._generation) {
    if (this._active && generation === this._generation && this._closing()) this._close = {...this._close,stage:'closed',outcome:'unconfirmed',pendingAtEnd:this._pending()};
    super._fail(error,generation);
  }
  _peerTimedOut(generation) {
    this._fail(Error(`No new peer response for ${this._idleTimeoutMs/1000} seconds. Chat stopped and audio was released. Messages without delivery receipts remain unconfirmed. Press Start on both devices to reconnect.`),generation);
  }
  _rejectTurn() { this._chatStats.rejectedFrames++; this._emit(); }
  _connected() {
    const first = !this._chatConnected;
    if (first) this._session.lockChatEpoch();
    this._chatConnected = true;
    this._syncMessageIdle(first);
    if (this._closing()) { this._emitClosing(); return; }
    this._emit('chat',this._session.info.pendingCount ? 'Chat connected. Waiting for delivery receipts; both devices can queue messages.' : 'Chat connected. Write on either device; the audio link takes turns automatically.');
  }
  async enqueue(text) {
    validText(text);
    if (!this._active || !this._chatConnected) throw Error('Wait until chat is connected before sending another message.');
    if (this._closing()) throw Error('Chat is closing. No new messages can be queued.');
    if (this._session.info.pendingCount + this._enqueuePending >= MAX_PENDING) throw Error('Eight messages await receipts. Keep your draft until the queue has room.');
    const generation = this._generation;
    this._enqueuePending++; this._syncMessageIdle(true); this._emit();
    try {
      const packet = await this._session.send('message',text); this._check(generation);
      const counter = new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false);
      this._admitted.set(counter,monotonic());
      this._state = {...this._state,lastQueuedCounter:counter};
      // A new sender message can shorten an idle wait, but never interrupts an
      // already granted responder turn. Responder drafts wait for the next poll.
      if (this._state.role === 'sender' && this._nextPollTimer !== undefined) {
        this._clearTimer(this._nextPollTimer); this._nextPollTimer = undefined;
        this._schedulePoll(generation,0);
      }
      return {counter};
    } finally {
      if (generation === this._generation) { this._enqueuePending--; this._syncMessageIdle(); this._emit(); }
    }
  }
  async _sendMessage(generation) {
    if (this._chatConnected) return;
    const packet = await this._session.send('message',this._text); this._check(generation);
    this._text = '';
    const counter = new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(11,false);
    this._admitted.set(counter,monotonic()); this._state = {...this._state,lastQueuedCounter:counter};
    this._connected();
    this._schedulePoll(generation,0);
  }
  async _receive(packet,generation) {
    try { return await super._receive(packet,generation); }
    catch (error) {
      if (error?.name !== 'AbortError' && this._active && generation === this._generation) { this._chatStats.rejectedFrames++; this._emit(); }
      throw error;
    }
  }
  async _handlePayload(result,generation) {
    if (!this._rekeyComplete || result.type !== 'message') return;
    this._received = true; this._chatStats.received++;
    this._onMessage({type:'message',text:result.text,counter:result.counter});
    // Receipt is embedded in the next turn. Never answer DATA independently:
    // the peer may still be sending its turn-control frame.
    this._connected();
    this._syncMessageIdle(true);
  }
  async _handleDuplicateReceipt() { this._chatStats.duplicates++; this._emit(); }
  async _handleAck() { /* Chat v6/v7 receipts travel in authenticated turns. */ }
  _deliver(acknowledged) {
    let delivered = false;
    for (const counter of acknowledged) {
      if (!this._admitted.has(counter)) continue;
      const durationMs = Math.max(0,Math.round(monotonic()-this._admitted.get(counter)));
      this._admitted.delete(counter); this._chatStats.delivered++;
      delivered = true;
      this._chatStats.lastDeliveryMs = durationMs;
      this._onDelivery({counter,durationMs});
    }
    if (delivered) this._syncMessageIdle(true);
  }
  _schedulePoll(generation,delay) {
    if (this._nextPollTimer !== undefined || !this._active) return;
    this._nextPollTimer = this._timer(()=>{
      this._nextPollTimer = undefined;
      this._newPoll(generation).catch(error=>this._fail(error,generation));
    },delay);
  }
  async _newPoll(generation) {
    this._check(generation);
    if (this._poll || this._sendingTurn) return;
    if (this._turn >= 0x7fffffff) throw Error('Chat turn limit reached. Start a fresh connection.');
    this._turn++;
    const close = this._close.stage === 'committing' ? 'commit' : this._closing() ? 'drain' : 'open';
    if (close === 'commit') this._session.lockChatData();
    const data = close === 'commit' ? null : this._session.pending()[0]?.packet || null;
    const control = await this._session.turn({number:this._turn,pending:this._pending()>0,close});
    this._check(generation);
    const poll = {number:this._turn,data,control,close,attempts:0}; this._poll = poll;
    await this._sendPoll(poll,generation);
  }
  async _sendData(packet,generation) {
    const id = fingerprint(packet);
    if (this._sentData.has(id)) this._chatStats.retries++;
    this._sentData.add(id);
    // The set is observational only. Reliability state remains the eight-packet
    // AudioSession outbox, and cleanup destroys both at the end of the run.
    if (this._sentData.size > 64) this._sentData.delete(this._sentData.values().next().value);
    await this._queueSend(packet,generation);
  }
  async _sendPoll(poll,generation) {
    this._check(generation);
    if (this._poll !== poll || this._sendingTurn) return;
    if (poll.attempts >= (poll.close === 'commit' ? this._timing.closeMaxAttempts : this._timing.maxAttempts)) {
      if (this._closing()) { this._finishClose('unconfirmed','Chat stopped because the peer did not acknowledge closing. Messages without delivery receipts remain unconfirmed.'); return; }
      throw Error('Chat peer stopped responding. Pending messages were not confirmed. Start both devices again.');
    }
    if (poll.attempts++) this._chatStats.retries++;
    this._sendingTurn = true;
    try {
      if (poll.data) await this._sendData(poll.data,generation);
      this._check(generation);
      if (this._poll !== poll) return;
      await this._queueSend(poll.control,generation,poll.data ? 0 : this._timing.turnaroundMs);
      this._check(generation);
    } finally { if (generation === this._generation) this._sendingTurn = false; }
    if (this._poll !== poll) return;
    if (this._closing()) this._emitClosing(); else this._emit('chat','Listening for the other device’s chat turn…');
    const timeout = this._timing.turnTimeoutMs * getAudioProfile(this._state.profile).timingScale;
    this._turnTimer = this._timer(()=>{
      this._turnTimer = undefined;
      this._sendPoll(poll,generation).catch(error=>this._fail(error,generation));
    },timeout);
  }
  async _handleChatTurn(result,generation) {
    if (!this._rekeyComplete) return;
    if (this._state.role === 'sender') {
      const poll = this._poll;
      if (!result.reply || !poll || result.number !== poll.number) { this._chatStats.duplicates++; this._emit(); return; }
      if ((poll.close === 'commit') !== (result.close === 'ack')) { this._rejectTurn(); return; }
      if (!result.duplicate) this._peerProgress(generation);
      this._peerPending = result.pending;
      this._clearTimer(this._turnTimer); this._turnTimer = undefined;
      this._poll = null;
      this._deliver(result.acknowledged); this._chatStats.turns++;
      if (result.close === 'ack') {
        this._close.peerClosing = true; this._close.peerAckSeen = true; this._close.stage = 'finalizing';
        this._emitClosing();
        await this._sendFinal(poll.number,generation);
        return;
      }
      if (result.close === 'drain') { this._beginClose(false); this._close.peerClosing = true; }
      if (this._closing() && this._close.peerClosing && result.close === 'drain' && !result.pending && !this._pending()) this._close.stage = 'committing';
      this._connected();
      const busy = this._closing() || result.pending || this._pending() > 0;
      this._idleRounds = busy ? 0 : Math.min(4,this._idleRounds+1);
      const delay = busy ? this._timing.turnaroundMs : Math.min(this._timing.maxIdlePollMs,this._timing.idlePollMs * 2 ** Math.max(0,this._idleRounds-1));
      // Do not schedule a second A turn until the preceding playback call has
      // completed its echo guard, even in a synchronous synthetic transport.
      this._transmit.then(()=>{if(this._active&&generation===this._generation)this._schedulePoll(generation,delay);});
      return;
    }
    if (result.reply || result.number < this._lastPeerTurn || result.number > this._lastPeerTurn+1) { this._chatStats.duplicates++; this._emit(); return; }
    if (result.close === 'final') {
      if (result.number !== this._lastPeerTurn+1 || this._response?.close !== 'ack' || !['acknowledging','waiting-final'].includes(this._close.stage) || this._pending()) { this._rejectTurn(); return; }
      this._lastPeerTurn = result.number; this._chatStats.turns++; this._close.finalSeen = true;
      this._finishClose('confirmed','Chat ended. The peer’s authenticated final confirmation was received.');
      return;
    }
    if (['acknowledging','waiting-final'].includes(this._close.stage) && (result.number !== this._lastPeerTurn || result.close !== 'commit')) { this._rejectTurn(); return; }
    if (result.close === 'commit' && (this._close.stage === 'none' || this._pending() || (result.number > this._lastPeerTurn && this._response?.close !== 'drain'))) { this._rejectTurn(); return; }
    this._deliver(result.acknowledged);
    if (result.number === this._lastPeerTurn) {
      this._chatStats.duplicates++;
      if (!this._response || this._response.number !== result.number || this._sendingTurn) { this._emit(); return; }
      await this._sendResponse(this._response,generation);
      return;
    }
    if (this._sendingTurn) return;
    if (!result.duplicate) this._peerProgress(generation);
    this._peerPending = result.pending;
    this._lastPeerTurn = result.number; this._chatStats.turns++;
    if (result.close === 'drain') { this._beginClose(false); this._close.peerClosing = true; }
    if (result.close === 'commit') {
      this._session.lockChatData(); this._close.peerClosing = true; this._close.stage = 'acknowledging';
    }
    this._connected();
    const close = result.close === 'commit' ? 'ack' : this._closing() ? 'drain' : 'open';
    const data = close === 'ack' ? null : this._session.pending()[0]?.packet || null;
    const control = await this._session.turn({reply:true,number:result.number,pending:this._pending()>0,close});
    this._check(generation);
    this._response = {number:result.number,data,control,close,attempts:0};
    await this._sendResponse(this._response,generation);
  }
  async _sendFinal(number,generation) {
    if (number >= 0x7fffffff) { this._finishClose('unconfirmed','Close was acknowledged but no final turn number remained.'); return; }
    this._turn = number+1;
    const control = await this._session.turn({number:this._turn,close:'final'});
    this._check(generation);
    await this._queueSend(control,generation);
    this._check(generation);
    this._finishClose('confirmed','Chat ended. The peer acknowledged closing and the final confirmation was sent.');
  }
  _startCloseLinger(generation) {
    if (this._lingerTimer !== undefined) return;
    const milliseconds = this._timing.closeLingerMs * getAudioProfile(this._state.profile).timingScale;
    this._closeDeadline = Math.min(this._closeDeadline,monotonic()+milliseconds);
    this._lingerTimer = this._timer(()=>{
      if (this._active && generation === this._generation) this._finishClose('unconfirmed','Chat ended after sending the close acknowledgement. The peer’s final confirmation was not heard.');
    },Math.max(0,this._closeDeadline-monotonic()));
  }
  async _sendResponse(response,generation) {
    if (response.attempts++) this._chatStats.retries++;
    this._sendingTurn = true;
    try {
      if (response.data) await this._sendData(response.data,generation);
      this._check(generation);
      await this._queueSend(response.control,generation,response.data ? 0 : this._timing.turnaroundMs);
      this._check(generation);
      if (response.close === 'ack') { this._close.stage = 'waiting-final'; this._startCloseLinger(generation); }
      if (this._closing()) this._emitClosing(); else this._emit('chat','Chat connected. Listening for the next turn…');
    } finally { if (generation === this._generation) this._sendingTurn = false; }
  }
}
