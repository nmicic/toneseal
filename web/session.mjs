// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Experimental audio session protocol. See PROTOCOL.md; not externally audited.
import {getCryptoProfile, cryptoSupportError} from './crypto-profiles.mjs';

const MAGIC = 0xa7, OFFER = 1, ANSWER = 2, DATA = 3;
const READY = 0, MESSAGE = 1, PASSWORD = 2, REKEY_OFFER = 3, REKEY_ANSWER = 4, REKEY_REQUEST = 5, ACK = 6, CHAT_TURN = 7;
const HEADER = 15, MAX_BODY = 96, MAX_COUNTER = 0x7fffffff, CONTROL = 0x80000000;
const WINDOW = 64, MAX_PENDING = 8;
const CHAT_CLOSE = Object.freeze(['open','drain','commit','ack','final']);
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true});
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const reject = message => { throw new Error(message); };

export const MAX_TEXT_BYTES = MAX_BODY;
export function isProtocolPacket(bytes) { return bytes instanceof Uint8Array && bytes[0] === MAGIC; }

/**
 * Transport-independent, in-memory session. All outbound bytes must travel over
 * audio, never a server. receive() may return a response to transmit. The caller
 * selects the trust policy before confirm(): human comparison of the full
 * fingerprint authenticates the peer; automatic confirmation establishes key
 * possession only and must never be presented as peer verification.
 * Methods serialize cryptographic operations; reset() cancels in-flight work.
 */
export class AudioSession {
  constructor({cryptoProfile = 'p256', purpose = 'message'} = {}) {
    if (!['message','chat'].includes(purpose)) reject('Unsupported session purpose.');
    const profile = getCryptoProfile(cryptoProfile);
    // Chat is a separate wire protocol and key domain. Old one-shot peers
    // cannot acknowledge an initial message and silently appear chat-capable.
    Object.defineProperty(this,'_profile',{value:purpose === 'chat' ? Object.freeze({...profile,version:profile.version + 4}) : profile});
    Object.defineProperty(this,'_purpose',{value:purpose});
    this._prefix = encoder.encode(`audio-text-lab/session/v${this._profile.version}\0`);
    this._queue = Promise.resolve();
    this._generation = 0;
    this.reset();
  }

  reset() {
    this._generation++;
    this._role = null;
    this._pairing = null;
    this._current = null;
    this._pending = null;
    this._rekey = null;
    this._lastOutbound = null;
    this._responses = new Map();
    this._outbox = new Map();
    this._lastDelivery = null;
    this._chatTurns = new Map();
    this._chatEpochLocked = false;
    this._chatDataLocked = false;
  }

  get info() {
    const current = this._current;
    return {
      state: this._rekey ? 'rekeying' : current ? (current.localConfirmed && current.peerConfirmed ? 'ready' : 'verify') : this._pairing ? 'offering' : 'idle',
      role: this._role,
      cryptoProfile: this._profile.id,
      fingerprint: current?.fingerprint ?? '',
      localConfirmed: current?.localConfirmed ?? false,
      peerConfirmed: current?.peerConfirmed ?? false,
      pendingCount: this._outbox.size,
      lastDelivery: this._lastDelivery ? {...this._lastDelivery} : null,
    };
  }

  retry() {
    if (!this._lastOutbound) reject('There is no packet to repeat.');
    return this._lastOutbound.slice();
  }

  pending() { return Array.from(this._outbox, ([counter, packet]) => ({counter, packet: packet.slice()})); }

  retryPending() {
    const packet = this._outbox.values().next().value;
    if (!packet) reject('There are no unacknowledged messages.');
    this._lastOutbound = packet.slice();
    return packet.slice();
  }

  _serial(work) {
    const generation = this._generation;
    const job = this._queue.then(async () => {
      if (generation !== this._generation) reject('Session was reset.');
      this._operationGeneration = generation;
      const result = await work();
      this._live();
      return result;
    });
    this._queue = job.catch(() => {});
    return job;
  }

  _live() { if (this._operationGeneration !== this._generation) reject('Session was reset.'); }
  _remember(packet) { this._live(); this._lastOutbound = packet.slice(); return packet.slice(); }
  _cache(inbound, outbound) {
    this._responses.set(hex(inbound), outbound.slice());
    while (this._responses.size > 12) this._responses.delete(this._responses.keys().next().value);
  }

  async _share() {
    if (!globalThis.crypto?.subtle) reject('Web Crypto requires HTTPS or localhost.');
    let keys, publicKey;
    try {
      keys = await crypto.subtle.generateKey(this._profile.algorithm, false, ['deriveBits']);
      publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    } catch (error) {
      this._live();
      throw cryptoSupportError(this._profile);
    }
    this._live();
    this._validatePublic(publicKey);
    const share = concat(publicKey, crypto.getRandomValues(new Uint8Array(16)));
    return {privateKey: keys.privateKey, share};
  }

  _validatePublic(bytes) {
    if (bytes.length !== this._profile.publicKeyBytes) reject('Invalid public key length.');
    if (this._profile.id === 'p256') {
      if (bytes[0] !== 4) reject('Invalid public key encoding.');
      return;
    }
    // The v3 wire requires the canonical little-endian u-coordinate. RFC 7748
    // primitives also accept aliases, but those must not bypass our reflection
    // check or create alternate encodings of the same protocol key.
    for (let index = 31; index >= 0; index--) {
      const bound = index === 31 ? 0x7f : index === 0 ? 0xed : 0xff; // 2^255 - 19
      if (bytes[index] < bound) return;
      if (bytes[index] > bound) reject('Noncanonical X25519 public key.');
    }
    reject('Noncanonical X25519 public key.');
  }

  async _derive(local, peerShare, offer, answer, previousId = new Uint8Array()) {
    const profile = this._profile, publicBytes = peerShare.subarray(0,profile.publicKeyBytes);
    if (peerShare.length !== profile.shareBytes) reject('Invalid public share length.');
    this._validatePublic(publicBytes);
    if (equal(local.share.subarray(0,profile.publicKeyBytes),publicBytes)) reject('Invalid or reflected public key.');
    const publicKey = await crypto.subtle.importKey('raw', publicBytes, profile.algorithm, false, []);
    let secret, material;
    try {
      secret = new Uint8Array(await crypto.subtle.deriveBits({...profile.algorithm,public:publicKey}, local.privateKey, 256));
      // Web Crypto must reject low-order X25519 input producing all-zero output;
      // retain an explicit check so a nonconforming provider cannot proceed.
      let nonzero = 0;
      for (const byte of secret) nonzero |= byte;
      if (secret.length !== 32 || !nonzero) reject('Invalid key agreement result.');
      const transcript = concat(this._prefix, previousId, offer, answer);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', transcript));
      const input = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
      material = new Uint8Array(await crypto.subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt: digest, info: encoder.encode(`audio-text-lab/directional-traffic/v${profile.version}`)}, input, 640));
      const keyA = await crypto.subtle.importKey('raw', material.subarray(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
      const keyB = await crypto.subtle.importKey('raw', material.subarray(40, 72), 'AES-GCM', false, ['encrypt', 'decrypt']);
      const forward = this._role === 'initiator';
      const fingerprintBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(encoder.encode(`audio-text-lab/fingerprint/v${profile.version}\0`), transcript)));
      this._live();
      return {
        id: digest.slice(0, 8),
        fingerprint: hex(fingerprintBytes.subarray(0, 16)).toUpperCase().match(/.{4}/g).join(' '),
        txKey: forward ? keyA : keyB, rxKey: forward ? keyB : keyA,
        txPrefix: material.slice(forward ? 32 : 72, forward ? 40 : 80),
        rxPrefix: material.slice(forward ? 72 : 32, forward ? 80 : 40),
        txCounter: 0, txControlCounter: 0, rxHigh: 0, rxControlHigh: 0,
        received: new Set(), receivedControl: new Set(), localConfirmed: false, peerConfirmed: false,
      };
    } finally { secret?.fill(0); material?.fill(0); }
  }

  async _seal(epoch, kind, body = new Uint8Array()) {
    if (body.length > MAX_BODY) reject('Payload exceeds the 96-byte limit.');
    const application = kind === MESSAGE || kind === PASSWORD;
    const field = application ? 'txCounter' : 'txControlCounter';
    if (epoch[field] >= MAX_COUNTER) reject('Sequence exhausted; reset and pair again.');
    // Independent spaces prevent ACK chatter from expiring an undelivered data
    // packet. The high control bit participates in the nonce and is authenticated.
    const counter = ++epoch[field] + (application ? 0 : CONTROL);
    const header = concat(Uint8Array.of(MAGIC, this._profile.version, DATA), epoch.id, new Uint8Array(4));
    new DataView(header.buffer).setUint32(11, counter, false);
    const nonce = concat(epoch.txPrefix, header.subarray(11));
    const plaintext = concat(Uint8Array.of(kind), body);
    try {
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128}, epoch.txKey, plaintext));
      this._live();
      return concat(header, ciphertext);
    } finally { plaintext.fill(0); }
  }

  offer() { return this._serial(async () => {
    if (this.info.state !== 'idle') reject('Reset before starting another pairing.');
    const local = await this._share();
    const packet = concat(Uint8Array.of(MAGIC, this._profile.version, OFFER), local.share);
    this._role = 'initiator';
    this._pairing = {local, offer: packet};
    return this._remember(packet);
  }); }

  confirm() { return this._serial(async () => {
    const epoch = this._current;
    if (!epoch || this._rekey) reject('Complete the public key exchange first.');
    if (epoch.localConfirmed) reject('Already confirmed; repeat the last confirmation if needed.');
    const packet = await this._seal(epoch, READY);
    epoch.localConfirmed = true;
    return this._remember(packet);
  }); }

  send(kind, text) { return this._serial(async () => {
    if (this.info.state !== 'ready') reject('Both devices must confirm the fingerprint before sending.');
    if (kind !== 'message' && kind !== 'password') reject('Unsupported application channel.');
    if (this._purpose === 'chat' && kind !== 'message') reject('Chat supports the Message channel only.');
    if (this._chatDataLocked) reject('Chat close was committed; no further application data is allowed.');
    if (typeof text !== 'string' || text.length === 0) reject('Enter a nonempty message.');
    if (this._outbox.size >= MAX_PENDING) reject('Eight messages await receipts. Resend the oldest before sending more.');
    const oldest = this._outbox.keys().next().value;
    if (oldest !== undefined && this._current.txCounter + 1 - oldest >= WINDOW) reject('Delivery window is full. Resend the oldest unacknowledged message.');
    const body = encoder.encode(text);
    // Reject lone surrogates instead of silently replacing password characters.
    if (decoder.decode(body) !== text) reject('Text contains invalid Unicode.');
    try {
      const packet = await this._seal(this._current, kind === 'message' ? MESSAGE : PASSWORD, body);
      const counter = new DataView(packet.buffer).getUint32(11, false);
      this._outbox.set(counter, packet.slice());
      this._lastDelivery = {counter, status: 'pending', sessionId: hex(this._current.id)};
      return this._remember(packet);
    }
    finally { body.fill(0); }
  }); }

  // A turn carries a cumulative application receipt in its independent control
  // sequence space. Chat v6/v7 binds graceful close into the same 51-byte frame.
  turn({reply = false, number, pending = false, close = 'open'} = {}) { return this._serial(async () => {
    if (this._purpose !== 'chat' || this.info.state !== 'ready') reject('Establish a chat session before granting a turn.');
    const stage = CHAT_CLOSE.indexOf(close);
    if (!Number.isInteger(number) || number < 1 || number > MAX_COUNTER || typeof reply !== 'boolean' || typeof pending !== 'boolean' || stage < 0 || (stage >= 2 && pending) || (close === 'ack' && !reply) || (['commit','final'].includes(close) && reply)) reject('Invalid chat turn.');
    if (stage >= 2 && this._outbox.size) reject('Drain pending messages before committing chat close.');
    const body = new Uint8Array(19);
    body[0] = 2; body[1] = Number(reply); body[6] = Number(pending) | (stage << 1);
    new DataView(body.buffer).setUint32(2,number,false);
    body.set(this._receiptBody(this._current,0),7);
    return this._remember(await this._seal(this._current,CHAT_TURN,body));
  }); }

  // The initial chat scheduler does not grant turns for a second key exchange.
  // Lock only after bootstrap/rekey completes, so setup retries still recover.
  lockChatEpoch() {
    if (this._purpose !== 'chat' || this.info.state !== 'ready') reject('A ready chat session is required.');
    this._chatEpochLocked = true;
  }

  // The turn scheduler invokes this only after accepting a valid close fence.
  // Reject late DATA before display callbacks, receive windows, or receipt bits.
  lockChatData() {
    if (this._purpose !== 'chat' || this.info.state !== 'ready' || this._outbox.size) reject('Drain a ready chat session before locking application data.');
    this._chatDataLocked = true;
  }

  async _startRekey() {
    if (this._outbox.size) reject('Receive delivery receipts for all pending messages before rekeying.');
    const local = await this._share();
    const packet = await this._seal(this._current, REKEY_OFFER, local.share);
    this._rekey = {phase: 'offer', local, offer: local.share, packet: packet.slice()};
    return this._remember(packet);
  }

  rekey() { return this._serial(async () => {
    if (this._chatEpochLocked) reject('Start a new chat connection to refresh its keys.');
    if (this._rekey?.packet) return this._remember(this._rekey.packet);
    if (this.info.state !== 'ready') reject('Establish the session before rekeying.');
    if (this._outbox.size) reject('Receive delivery receipts for all pending messages before rekeying.');
    if (this._role === 'initiator') return this._startRekey();
    const packet = await this._seal(this._current, REKEY_REQUEST);
    this._rekey = {phase: 'request', packet: packet.slice()};
    return this._remember(packet);
  }); }

  receive(input) {
    // Copy before queueing so the transport cannot mutate data during crypto work.
    if (!(input instanceof Uint8Array)) return Promise.reject(new Error('Expected packet bytes.'));
    const packet = new Uint8Array(input);
    return this._serial(() => this._receive(packet));
  }

  async _receive(packet) {
    if (packet.length < 3 || packet.length > 128 || packet[0] !== MAGIC || packet[1] !== this._profile.version) reject('Unsupported session packet or cryptographic profile.');
    const cached = this._responses.get(hex(packet));
    if (cached) {
      if (this._chatEpochLocked) reject('Chat setup is complete; old handshake retries are ignored.');
      return {type: 'duplicate', outbound: this._remember(cached)};
    }
    const cachedTurn = this._chatTurns.get(hex(packet));
    if (cachedTurn) return {...cachedTurn, acknowledged:[], duplicate:true};
    const type = packet[2];
    if (type === OFFER || type === ANSWER) {
      if (packet.length !== 3 + this._profile.shareBytes) reject('Invalid public key record.');
      this._validatePublic(packet.subarray(3,3 + this._profile.publicKeyBytes));
      if (type === OFFER) {
        if (this.info.state !== 'idle') reject('Already pairing or paired; ignoring another offer.');
        const local = await this._share();
        const answer = concat(Uint8Array.of(MAGIC, this._profile.version, ANSWER), local.share);
        // Role is an input to derivation. Restore it if import/derivation fails.
        this._role = 'responder';
        let epoch;
        try { epoch = await this._derive(local, packet.subarray(3), packet, answer); }
        catch (error) { if (this._operationGeneration === this._generation) this._role = null; throw error; }
        this._current = epoch;
        this._cache(packet, answer);
        return {type: 'offer', outbound: this._remember(answer)};
      }
      if (this._role !== 'initiator' || !this._pairing || this._current) reject('Unexpected answer.');
      const epoch = await this._derive(this._pairing.local, packet.subarray(3), this._pairing.offer, packet);
      this._current = epoch;
      this._pairing = null;
      return {type: 'answer'};
    }
    if (type !== DATA || packet.length < HEADER + 17) reject('Invalid encrypted packet.');
    const id = packet.subarray(3, 11);
    const epoch = this._pending && equal(this._pending.id, id) ? this._pending : this._current && equal(this._current.id, id) ? this._current : null;
    if (!epoch) reject('Packet belongs to another session.');
    const wireCounter = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(11, false);
    const control = wireCounter >= CONTROL, counter = wireCounter % CONTROL;
    const seen = control ? epoch.receivedControl : epoch.received;
    const highField = control ? 'rxControlHigh' : 'rxHigh';
    const duplicate = seen.has(counter);
    if (!counter || counter + WINDOW <= epoch[highField] || (control && duplicate)) reject('Replay or stale packet rejected.');
    const header = packet.subarray(0, HEADER), nonce = concat(epoch.rxPrefix, header.subarray(11));
    let plaintext;
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128}, epoch.rxKey, packet.subarray(HEADER)));
    } catch { reject('Packet authentication failed.'); }
    this._live();
    try {
      const kind = plaintext[0], body = plaintext.subarray(1);
      if (body.length > MAX_BODY) reject('Payload exceeds the 96-byte limit.');
      if (control === (kind === MESSAGE || kind === PASSWORD)) reject('Record kind does not match its sequence space.');
      const result = await this._process(epoch, kind, body, packet, counter, duplicate);
      // Authenticate and validate the complete record before advancing replay state.
      epoch[highField] = Math.max(epoch[highField], counter);
      seen.add(counter);
      for (const value of seen) if (value + WINDOW <= epoch[highField]) seen.delete(value);
      if (result.type === 'chat-turn') {
        this._chatTurns.set(hex(packet),{...result,acknowledged:[]});
        while (this._chatTurns.size > 4) this._chatTurns.delete(this._chatTurns.keys().next().value);
      }
      return result;
    } finally { plaintext.fill(0); }
  }

  _receiptBody(epoch, currentCounter) {
    const highest = Math.max(epoch.rxHigh, currentCounter), body = new Uint8Array(12);
    new DataView(body.buffer).setUint32(0, highest, false);
    for (let bit = 0; bit < WINDOW; bit++) {
      const counter = highest - bit;
      if (counter > 0 && (counter === currentCounter || epoch.received.has(counter))) body[4 + (bit >> 3)] |= 1 << (bit & 7);
    }
    return body;
  }
  async _receipt(epoch, currentCounter) {
    return this._seal(epoch, ACK, this._receiptBody(epoch,currentCounter));
  }
  _acknowledge(epoch, body, allowEmpty = false) {
    if (body.length !== 12) reject('Invalid delivery receipt.');
    const highest = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, false);
    if (!highest && allowEmpty && body.every(value => value === 0)) return [];
    if (!highest || highest > epoch.txCounter || !(body[4] & 1)) reject('Receipt acknowledges an unsent packet.');
    const acknowledged = [];
    // Validate the entire bitmap before removing any retained ciphertext.
    for (let bit = 0; bit < WINDOW; bit++) {
      if (!(body[4 + (bit >> 3)] & (1 << (bit & 7)))) continue;
      const counter = highest - bit;
      if (counter <= 0) reject('Receipt bitmap contains an invalid counter.');
      if (this._outbox.has(counter)) acknowledged.push(counter);
    }
    acknowledged.sort((a,b) => a-b);
    for (const counter of acknowledged) this._outbox.delete(counter);
    if (this._lastDelivery && acknowledged.includes(this._lastDelivery.counter)) this._lastDelivery.status = 'delivered';
    return acknowledged;
  }

  async _process(epoch, kind, body, packet, counter, duplicate) {
    if (this._chatEpochLocked && [READY,REKEY_OFFER,REKEY_ANSWER,REKEY_REQUEST].includes(kind)) reject('Chat setup is complete; restart to refresh keys.');
    if (kind === READY) {
      if (body.length) reject('Invalid confirmation record.');
      if (epoch === this._pending) {
        if (this._rekey?.phase === 'answer') {
          const outbound = await this._seal(epoch, READY);
          epoch.localConfirmed = true;
          epoch.peerConfirmed = true;
          this._cache(packet, outbound);
          this._current = epoch;
          this._chatTurns.clear();
          this._pending = null;
          this._rekey = null;
          return {type: 'ready', outbound: this._remember(outbound)};
        }
        if (this._rekey?.phase !== 'commit' || !epoch.localConfirmed) reject('Unexpected rekey confirmation.');
        epoch.peerConfirmed = true;
        this._current = epoch;
        this._chatTurns.clear();
        this._pending = null;
        this._rekey = null;
        return {type: 'ready'};
      }
      if (this._rekey) reject('Unexpected old-session confirmation during rekey.');
      epoch.peerConfirmed = true;
      return {type: 'ready'};
    }
    if (epoch !== this._current || !epoch.localConfirmed || !epoch.peerConfirmed) reject('Unconfirmed session cannot carry application data.');
    if (this._purpose === 'chat' && (kind === PASSWORD || kind === ACK)) reject('Unsupported record in the chat protocol.');
    if (kind === MESSAGE || kind === PASSWORD) {
      if (this._chatDataLocked) reject('Chat close was committed; application data is no longer accepted.');
      // Before an answer arrives, the peer may need a missing old-epoch receipt
      // before it can accept our offer. Repair that delivery without dropping the
      // retained rekey flight. rekey() resumes it after the receipt is played.
      if (this._rekey && !['offer', 'request'].includes(this._rekey.phase)) reject('Application traffic is paused during rekey.');
      if (!body.length) reject('Empty application record.');
      const text = decoder.decode(body);
      // A duplicate gets a NEW encrypted receipt containing the CURRENT bitmap.
      // Reusing an old ACK could leave it outside the peer's control replay window.
      const outbound = this._purpose === 'chat' ? null : await this._receipt(epoch, counter);
      return {
        type: duplicate ? 'duplicate' : kind === MESSAGE ? 'message' : 'password',
        ...(duplicate ? {} : {text}), counter, ...(outbound ? {outbound:this._remember(outbound)} : {}), receipt: true,
      };
    }
    if (kind === ACK) {
      const acknowledged = this._acknowledge(epoch,body);
      return {type: 'ack', acknowledged, pendingCount: this._outbox.size};
    }
    if (kind === CHAT_TURN) {
      if (this._purpose !== 'chat' || this._rekey || body.length !== 19 || body[0] !== 2 || body[1] > 1 || body[6] > 8) reject('Invalid chat turn record.');
      const number = new DataView(body.buffer,body.byteOffset,body.byteLength).getUint32(2,false);
      const reply = Boolean(body[1]), pending = Boolean(body[6] & 1), close = CHAT_CLOSE[body[6] >> 1];
      if (!number || number > MAX_COUNTER || reply !== (this._role === 'initiator')) reject('Invalid chat turn role or number.');
      if (!close || ((body[6] >> 1) >= 2 && pending) || (close === 'ack' && !reply) || (['commit','final'].includes(close) && reply)) reject('Invalid chat turn close flags.');
      const acknowledged = this._acknowledge(epoch,body.subarray(7),true);
      return {type:'chat-turn',number,reply,pending,close,acknowledged,pendingCount:this._outbox.size,duplicate:false};
    }
    if (kind === REKEY_REQUEST) {
      if (body.length || this._role !== 'initiator' || this._rekey) reject('Unexpected rekey request.');
      const outbound = await this._startRekey();
      this._cache(packet, outbound);
      return {type: 'rekey', outbound};
    }
    if (kind === REKEY_OFFER) {
      if (body.length !== this._profile.shareBytes || this._role !== 'responder' || (this._rekey && this._rekey.phase !== 'request')) reject('Unexpected rekey offer.');
      if (this._outbox.size) reject('Receive delivery receipts for all pending messages before rekeying.');
      const local = await this._share();
      const next = await this._derive(local, body, body, local.share, epoch.id);
      const outbound = await this._seal(epoch, REKEY_ANSWER, local.share);
      this._pending = next;
      this._rekey = {phase: 'answer', packet: outbound.slice()};
      this._cache(packet, outbound);
      return {type: 'rekey', outbound: this._remember(outbound)};
    }
    if (kind === REKEY_ANSWER) {
      if (body.length !== this._profile.shareBytes || this._role !== 'initiator' || this._rekey?.phase !== 'offer') reject('Unexpected rekey answer.');
      const next = await this._derive(this._rekey.local, body, this._rekey.offer, body, epoch.id);
      const outbound = await this._seal(next, READY);
      next.localConfirmed = true;
      this._pending = next;
      this._rekey = {phase: 'commit', packet: outbound.slice()};
      this._cache(packet, outbound);
      return {type: 'rekey', outbound: this._remember(outbound)};
    }
    reject('Unsupported encrypted record type.');
  }
}
