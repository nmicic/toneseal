// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {test as nodeTest} from 'node:test';
import {AudioSession as Session, MAX_TEXT_BYTES, isProtocolPacket} from '../web/session.mjs';
import {getCryptoProfile, checkCryptoProfile} from '../web/crypto-profiles.mjs';

for (const cryptoProfile of ['p256','x25519']) {
const profile = getCryptoProfile(cryptoProfile);
const test = (name, run) => nodeTest(`${cryptoProfile}: ${name}`,run);
class AudioSession extends Session { constructor() { super({cryptoProfile}); } }

async function exchange() {
  const a = new AudioSession(), b = new AudioSession();
  const offer = await a.offer();
  const answer = (await b.receive(offer)).outbound;
  await a.receive(answer);
  return {a, b, offer, answer};
}

async function paired() {
  const result = await exchange(), {a, b} = result;
  const ar = await a.confirm(), br = await b.confirm();
  await a.receive(br); await b.receive(ar);
  assert.equal(a.info.state, 'ready'); assert.equal(b.info.state, 'ready');
  return result;
}
async function rekeyPair(a, b, requester = a) {
  let receiver = requester === a ? b : a;
  let packet = await requester.rekey();
  for (let i = 0; i < 6 && packet; i++) {
    const result = await receiver.receive(packet);
    packet = result.outbound;
    receiver = receiver === a ? b : a;
  }
  assert.equal(packet, undefined);
  assert.equal(a.info.state, 'ready'); assert.equal(b.info.state, 'ready');
}
async function deliver(receiver, packet, sender) {
  const result = await receiver.receive(packet);
  if (sender && result.receipt) await sender.receive(result.outbound);
  return {type: result.type, text: result.text};
}
// Construct authenticated hostile records independently of the production sender.
async function hostile(sender, kind, body, counter) {
  const epoch = sender._current;
  counter ??= kind === 1 || kind === 2 ? epoch.txCounter + 100 : 0x80000000 + epoch.txControlCounter + 100;
  const header = new Uint8Array(15);
  header.set([0xa7, profile.version, 3]); header.set(epoch.id, 3);
  new DataView(header.buffer).setUint32(11, counter, false);
  const nonce = new Uint8Array(12); nonce.set(epoch.txPrefix); nonce.set(header.subarray(11), 8);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128}, epoch.txKey, Uint8Array.of(kind, ...body)));
  const result = new Uint8Array(15 + ciphertext.length); result.set(header); result.set(ciphertext, 15);
  return result;
}

test('fixed-size public records, matching full fingerprint, explicit bilateral confirmation', async () => {
  const {a, b, offer, answer} = await exchange();
  assert.equal(offer.length, profile.publicPacketBytes); assert.equal(answer.length, profile.publicPacketBytes);
  assert.equal(offer[1],profile.version); assert.equal(answer[1],profile.version);
  assert.equal(a.info.cryptoProfile,cryptoProfile);
  assert.ok(isProtocolPacket(offer)); assert.ok(!isProtocolPacket(Uint8Array.of(1, 2, 3)));
  assert.match(a.info.fingerprint, /^(?:[A-F0-9]{4} ){7}[A-F0-9]{4}$/);
  assert.equal(a.info.fingerprint, b.info.fingerprint);
  await assert.rejects(a.send('password', 'secret'), /Both devices/);
  await assert.rejects(b.send('message', 'hello'), /Both devices/);
  const ar = await a.confirm(); await b.receive(ar);
  assert.equal(a.info.state, 'verify'); assert.equal(b.info.state, 'verify');
  await assert.rejects(a.send('message', 'hello'), /Both devices/);
  await assert.rejects(b.send('message', 'hello'), /Both devices/);
  await a.receive(await b.confirm());
  assert.equal(a.info.state, 'ready'); assert.equal(b.info.state, 'ready');
  await assert.rejects(a.confirm(), /Already confirmed/);
});

test('bidirectional Unicode messages and passwords remain byte exact, bounded, channel-specific', async () => {
  const {a, b} = await paired();
  const value = '  Pässw🔐rd\n\u0000  ';
  const packet = await a.send('password', value);
  assert.equal(Buffer.from(packet).includes(Buffer.from(value)), false);
  assert.deepEqual(await deliver(b, packet, a), {type: 'password', text: value});
  assert.deepEqual(await deliver(a, await b.send('message', '<b>é</b>'), b), {type: 'message', text: '<b>é</b>'});
  const maximum = await a.send('message', 'x'.repeat(MAX_TEXT_BYTES));
  assert.equal(maximum.length, 128);
  assert.equal((await b.receive(maximum)).text.length, 96);
  await assert.rejects(a.send('message', 'x'.repeat(97)), /96-byte/);
  await assert.rejects(a.send('password', '🔐'.repeat(25)), /96-byte/);
  await assert.rejects(a.send('password', '\ud800'), /Unicode/);
  await assert.rejects(a.send('event', 'execute'), /Unsupported/);
  await assert.rejects(a.send('message', ''), /nonempty/);
});

test('tampering with header, counter, ciphertext, tag, length or session cannot destroy a live session', async () => {
  const {a, b} = await paired();
  const packet = await a.send('password', 'authentication-test');
  for (const position of [0, 1, 2, 3, 10, 11, 12, 13, 14, 15, packet.length - 1]) {
    const corrupted = packet.slice(); corrupted[position] ^= 0x80;
    await assert.rejects(b.receive(corrupted));
    assert.equal(b.info.state, 'ready');
  }
  await assert.rejects(b.receive(packet.subarray(0, packet.length - 1)));
  await assert.rejects(b.receive(new Uint8Array(129)));
  await assert.rejects(b.receive('string'));
  assert.deepEqual(await deliver(b, packet, a), {type: 'password', text: 'authentication-test'});
});

test('wrong peer, reflection, unsolicited pairing, and repeated payloads are rejected', async () => {
  const {a, b} = await paired(), {a: c} = await paired();
  const packet = await a.send('message', 'one delivery');
  await assert.rejects(a.receive(packet), /authentication/);
  await assert.rejects(c.receive(packet), /another session/);
  const outsider = new AudioSession();
  await assert.rejects(b.receive(await outsider.offer()), /Already pairing/);
  assert.equal((await b.receive(packet)).text, 'one delivery');
  const duplicate = await b.receive(packet);
  assert.equal(duplicate.type, 'duplicate'); assert.equal(duplicate.text, undefined); assert.equal(duplicate.receipt, true);
  assert.equal(b.info.state, 'ready');
});

test('out-of-order frames are accepted once within a bounded 64-frame replay window', async () => {
  const {a, b} = await paired();
  const packets = [];
  for (let i = 0; i < 8; i++) packets.push(await a.send('message', String(i)));
  assert.equal((await b.receive(packets[7])).text, '7');
  assert.equal((await b.receive(packets[6])).text, '6');
  for (let i = 0; i < 6; i++) await deliver(b, packets[i], a);
  assert.equal(a.info.pendingCount, 0);
  for (let i = 8; i < 70; i++) await deliver(b, await a.send('message', String(i)), a);
  await assert.rejects(b.receive(packets[5]), /Replay/);
  assert.ok(b._current.received.size <= 64);
});

test('authenticated invalid UTF-8, unknown kinds and malformed control records are rejected transactionally', async () => {
  const {a, b} = await paired();
  const high = b._current.rxHigh;
  for (const [kind, body] of [[1, [0xc0, 0xaf]], [2, []], [255, [1]], [0, [1]], [3, [1]], [4, []], [5, [1]]]) {
    await assert.rejects(b.receive(await hostile(a, kind, body)));
    assert.equal(b._current.rxHigh, high);
    assert.equal(b.info.state, 'ready');
  }
  assert.equal((await b.receive(await a.send('message', 'still works'))).text, 'still works');
});

test('unconfirmed application data is refused even when its encryption is valid', async () => {
  const {a, b} = await exchange();
  await assert.rejects(b.receive(await hostile(a, 2, new TextEncoder().encode('secret'))), /Unconfirmed/);
  assert.equal(b._current.rxHigh, 0);
});

test('public key validation rejects reflection and invalid curve points without losing an offer', async () => {
  const a = new AudioSession(), offer = await a.offer();
  const reflection = offer.slice(); reflection[2] = 2;
  await assert.rejects(a.receive(reflection), /reflected/);
  const invalid = reflection.slice(); invalid.fill(0, cryptoProfile === 'p256' ? 4 : 3, 3 + profile.publicKeyBytes);
  await assert.rejects(a.receive(invalid));
  assert.equal(a.info.state, 'offering');
  const b = new AudioSession(), answer = (await b.receive(offer)).outbound;
  await a.receive(answer);
  assert.equal(a.info.fingerprint, b.info.fingerprint);
});

test('rekey by either device creates fresh directional traffic keys and retires old traffic', async () => {
  const {a, b} = await paired();
  for (const requester of [a, b, a]) {
    const fingerprint = a.info.fingerprint;
    const old = await a.send('password', 'old epoch');
    await deliver(b, old, a);
    await rekeyPair(a, b, requester);
    assert.notEqual(a.info.fingerprint, fingerprint);
    assert.equal(a.info.fingerprint, b.info.fingerprint);
    await assert.rejects(b.receive(old), /another session/);
    assert.deepEqual(await deliver(b, await a.send('password', 'new epoch'), a), {type: 'password', text: 'new epoch'});
    assert.deepEqual(await deliver(a, await b.send('message', 'reverse'), b), {type: 'message', text: 'reverse'});
  }
});

test('rekey pauses payloads, rejects tampering, and repairs every lost flight with exact retries', async () => {
  const {a, b} = await paired();
  const offer = await a.rekey();
  assert.equal(offer.length,profile.rekeyPacketBytes);
  assert.deepEqual(a.retry(), offer);
  await assert.rejects(a.send('password', 'paused'), /Both devices/);
  const altered = offer.slice(); altered[20] ^= 1;
  await assert.rejects(b.receive(altered), /authentication/);
  assert.equal(b.info.state, 'ready');
  const answer = (await b.receive(offer)).outbound;
  assert.deepEqual((await b.receive(offer)).outbound, answer);
  await assert.rejects(b.send('message', 'paused'), /Both devices/);
  const commit = (await a.receive(answer)).outbound;
  assert.deepEqual((await a.receive(answer)).outbound, commit);
  const finish = (await b.receive(commit)).outbound;
  assert.equal(b.info.state, 'ready'); assert.equal(a.info.state, 'rekeying');
  // Final response is lost. The already-switched receiver must still answer.
  assert.deepEqual((await b.receive(commit)).outbound, finish);
  await a.receive(finish);
  assert.equal(a.info.state, 'ready');
  assert.equal((await b.receive(await a.send('message', 'recovered'))).text, 'recovered');
});

test('initial offer retry is byte-identical and does not replace pending or confirmed keys', async () => {
  const {a, b, offer, answer} = await exchange();
  const fingerprint = b.info.fingerprint;
  const response = await b.receive(offer);
  assert.equal(response.type, 'duplicate'); assert.deepEqual(response.outbound, answer);
  assert.equal(b.info.fingerprint, fingerprint);
  const copy = b.retry(); copy.fill(0);
  assert.deepEqual(b.retry(), answer);
  await b.receive(await a.confirm()); await a.receive(await b.confirm());
  assert.deepEqual((await b.receive(offer)).outbound, answer);
  assert.equal(b.info.state, 'ready');
});

test('concurrent sends reserve unique nonces, sequence exhaustion refuses, reset cancels async work', async () => {
  const {a, b} = await paired();
  const packets = await Promise.all(Array.from({length: 8}, (_, i) => a.send('message', String(i))));
  assert.equal(new Set(packets.map(packet => Buffer.from(packet.subarray(11, 15)).toString('hex'))).size, 8);
  for (let i = 0; i < packets.length; i++) assert.equal((await deliver(b, packets[i], a)).text, String(i));
  a._current.txCounter = 0x7fffffff;
  await assert.rejects(a.send('message', 'overflow'), /Sequence exhausted/);
  const c = new AudioSession();
  const pending = c.offer(); c.reset();
  await assert.rejects(pending, /reset/);
  assert.equal(c.info.state, 'idle');
  await c.offer(); assert.equal(c.info.state, 'offering');
  c.reset(); assert.equal(c.info.state, 'idle');
  assert.equal(c.info.fingerprint, '');
  assert.throws(() => c.retry(), /no packet/);
});

test('reset during key generation cannot resurrect session state', async () => {
  const original = crypto.subtle.generateKey.bind(crypto.subtle);
  let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  crypto.subtle.generateKey = async (...args) => { started(); await held; return original(...args); };
  const session = new AudioSession();
  try {
    const operation = session.offer();
    await began;
    session.reset(); release();
    await assert.rejects(operation, /reset/);
    assert.equal(session.info.state, 'idle');
    assert.equal(session.info.role, null);
    assert.throws(() => session.retry(), /no packet/);
  } finally { crypto.subtle.generateKey = original; release(); }
});

test('queued transport input is copied, including Uint8Array subclasses', async () => {
  const a = new AudioSession(), b = new AudioSession();
  const offer = Buffer.from(await a.offer());
  const reception = b.receive(offer);
  offer.fill(0);
  const answer = (await reception).outbound;
  await a.receive(answer);
  assert.equal(a.info.fingerprint, b.info.fingerprint);
});

test('selective bitmap receipts remove only received packets and retain exact missing ciphertext', async () => {
  const {a, b} = await paired();
  const first = await a.send('message', 'first'), second = await a.send('password', 'second'), third = await a.send('message', 'third');
  assert.equal(a.info.pendingCount, 3); assert.equal(a.info.lastDelivery.status, 'pending');
  const thirdResult = await b.receive(third);
  assert.equal(thirdResult.outbound.length, 44); assert.equal(thirdResult.receipt, true);
  assert.deepEqual(await a.receive(thirdResult.outbound), {type: 'ack', acknowledged: [3], pendingCount: 2});
  assert.equal(a.info.lastDelivery.status, 'delivered');
  assert.deepEqual(a.pending().map(entry => entry.counter), [1, 2]);
  assert.deepEqual(a.retryPending(), first);
  const firstResult = await b.receive(first);
  assert.deepEqual(await a.receive(firstResult.outbound), {type: 'ack', acknowledged: [1], pendingCount: 1});
  assert.deepEqual(a.retryPending(), second);
  const secondResult = await b.receive(second);
  assert.deepEqual(await a.receive(secondResult.outbound), {type: 'ack', acknowledged: [2], pendingCount: 0});
  assert.throws(() => a.retryPending(), /no unacknowledged/);
  await assert.rejects(a.receive(thirdResult.outbound), /Replay/);
});

test('lost receipt causes exact retransmission and fresh receipt without duplicate application delivery', async () => {
  const {a, b} = await paired();
  const packet = await a.send('password', 'one display');
  const initial = await b.receive(packet); // Drop this receipt.
  assert.equal(a.info.pendingCount, 1);
  const copied = a.pending()[0].packet; copied.fill(0);
  assert.deepEqual(a.retryPending(), packet);
  const duplicate = await b.receive(a.retryPending());
  assert.equal(duplicate.type, 'duplicate'); assert.equal(duplicate.text, undefined);
  assert.equal(duplicate.receipt, true); assert.notDeepEqual(duplicate.outbound, initial.outbound);
  assert.deepEqual((await a.receive(duplicate.outbound)).acknowledged, [1]);
  assert.equal(a.info.pendingCount, 0); assert.equal(a.info.lastDelivery.status, 'delivered');
  const tampered = packet.slice(); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(b.receive(tampered), /authentication/);
});

test('forged, future, malformed and wrong-space receipts cannot prune retained packets', async () => {
  const {a, b} = await paired();
  const packet = await a.send('password', 'retain until proven');
  const valid = (await b.receive(packet)).outbound;
  const forged = valid.slice(); forged[forged.length - 1] ^= 1;
  await assert.rejects(a.receive(forged), /authentication/);
  const bodies = [new Uint8Array(11)];
  for (const [highest, bits] of [[0, 1], [2, 1], [1, 0], [1, 3]]) {
    const body = new Uint8Array(12); new DataView(body.buffer).setUint32(0, highest, false); body[4] = bits; bodies.push(body);
  }
  const previousHigh = a._current.rxControlHigh;
  for (const body of bodies) {
    await assert.rejects(a.receive(await hostile(b, 6, body)));
    assert.equal(a.info.pendingCount, 1); assert.equal(a._current.rxControlHigh, previousHigh);
  }
  const body = new Uint8Array(12); new DataView(body.buffer).setUint32(0, 1, false); body[4] = 1;
  await assert.rejects(a.receive(await hostile(b, 6, body, 123)), /sequence space/);
  assert.equal(a.info.pendingCount, 1);
  await a.receive(valid); assert.equal(a.info.pendingCount, 0);
});

test('retained outbox applies backpressure rather than evicting pending messages', async () => {
  const {a, b} = await paired();
  const packets = [];
  for (let i = 0; i < 8; i++) packets.push(await a.send('message', String(i)));
  await assert.rejects(a.send('message', 'ninth'), /Eight messages/);
  assert.equal(a.info.pendingCount, 8); assert.deepEqual(a.retryPending(), packets[0]);
  await assert.rejects(a.rekey(), /delivery receipts/);
  await deliver(b, packets[0], a);
  await a.send('message', 'space freed'); assert.equal(a.info.pendingCount, 8);
});

test('oldest lost packet survives 64 app positions and more than 64 independent ACK controls', async () => {
  const {a, b} = await paired();
  const first = await a.send('message', 'oldest is lost');
  let latest, oldestReceipt;
  for (let i = 2; i <= 64; i++) {
    latest = await a.send('message', `position ${i}`);
    const result = await b.receive(latest);
    oldestReceipt ??= result.outbound;
    await a.receive(result.outbound);
  }
  assert.equal(a.info.pendingCount, 1);
  await assert.rejects(a.send('message', 'would expire oldest'), /Delivery window/);
  for (let i = 0; i < 70; i++) {
    const duplicate = await b.receive(latest);
    assert.equal(duplicate.type, 'duplicate'); assert.equal(duplicate.text, undefined);
    await a.receive(duplicate.outbound);
  }
  await assert.rejects(a.receive(oldestReceipt), /Replay/);
  assert.deepEqual(a.retryPending(), first);
  const repaired = await b.receive(a.retryPending());
  assert.equal(repaired.text, 'oldest is lost');
  assert.deepEqual((await a.receive(repaired.outbound)).acknowledged, [1]);
  assert.equal(a.info.pendingCount, 0);
  await deliver(b, await a.send('message', 'window reopened'), a);
});

test('bidirectional loss blocks rekey until repaired, including peer pending data discovered after offering', async () => {
  for (const peerAlreadyReceived of [false, true]) {
    const {a, b} = await paired();
    const fromA = await a.send('message', 'from A'), fromB = await b.send('password', 'from B');
    await b.receive(fromA); // Receipt lost.
    if (peerAlreadyReceived) await a.receive(fromB); // Receipt lost, or the data itself was lost.
    await assert.rejects(a.rekey(), /delivery receipts/);
    await assert.rejects(b.rekey(), /delivery receipts/);
    await a.receive((await b.receive(a.retryPending())).outbound);
    const offer = await a.rekey();
    await assert.rejects(b.receive(offer), /delivery receipts/);
    assert.equal(b.info.state, 'ready'); assert.equal(a.info.state, 'rekeying');
    const repair = await a.receive(b.retryPending());
    assert.equal(repair.type, peerAlreadyReceived ? 'duplicate' : 'password');
    await b.receive(repair.outbound);
    assert.equal(b.info.pendingCount, 0);
    const resumed = await a.rekey(); assert.deepEqual(resumed, offer);
    const answer = (await b.receive(resumed)).outbound;
    const commit = (await a.receive(answer)).outbound;
    const finish = (await b.receive(commit)).outbound;
    await a.receive(finish);
    assert.equal(a.info.state, 'ready'); assert.equal(b.info.state, 'ready');
    await deliver(b, await a.send('password', 'after repair and rekey'), a);
  }
});

test('responder rekey request can repair initiator pending data before resuming', async () => {
  const {a, b} = await paired();
  const pending = await a.send('password', 'lost before responder requests rekey');
  const request = await b.rekey();
  await assert.rejects(a.receive(request), /delivery receipts/);
  const repaired = await b.receive(a.retryPending());
  assert.equal(repaired.type, 'password'); assert.equal(repaired.receipt, true);
  await a.receive(repaired.outbound);
  assert.equal(a.info.pendingCount, 0);
  assert.deepEqual(await b.rekey(), request);
  const offer = (await a.receive(request)).outbound;
  const answer = (await b.receive(offer)).outbound;
  const commit = (await a.receive(answer)).outbound;
  const finish = (await b.receive(commit)).outbound;
  await a.receive(finish);
  assert.equal(a.info.state, 'ready'); assert.equal(b.info.state, 'ready');
  await assert.rejects(b.receive(pending), /another session/);
});

}

nodeTest('crypto profiles are fixed, unsupported options fail, and both native capability checks complete',async()=>{
  assert.throws(()=>new Session({cryptoProfile:'rsa-small'}),/supported cryptographic profile/);
  assert.throws(()=>getCryptoProfile('__proto__'),/supported cryptographic profile/);
  for (const id of ['p256','x25519']) {
    const profile = getCryptoProfile(id), session = new Session({cryptoProfile:id});
    assert.equal(await checkCryptoProfile(id),profile);
    assert.ok(Object.isFrozen(profile));assert.ok(Object.isFrozen(profile.algorithm));
    assert.throws(()=>{profile.version=1;},TypeError);
    assert.throws(()=>{session._profile=getCryptoProfile(id==='p256'?'x25519':'p256');},TypeError);
    session.reset();assert.equal(session.info.cryptoProfile,id);
  }
});

nodeTest('X25519 absence is explicit for capability checks and sending, without a P-256 fallback',async()=>{
  const original = crypto.subtle.generateKey.bind(crypto.subtle), algorithms=[];
  crypto.subtle.generateKey = async (algorithm,...args)=>{
    algorithms.push(algorithm.name);
    if (algorithm.name==='X25519') throw new DOMException('Unsupported','NotSupportedError');
    return original(algorithm,...args);
  };
  try {
    await assert.rejects(checkCryptoProfile('x25519'),/Choose P-256 on both devices/);
    const session=new Session({cryptoProfile:'x25519'});
    await assert.rejects(session.offer(),/Choose P-256 on both devices/);
    assert.equal(session.info.state,'idle');assert.equal(session.info.cryptoProfile,'x25519');
    assert.deepEqual(algorithms,['X25519','X25519']);
  } finally {crypto.subtle.generateKey=original;}
});

nodeTest('wire versions bind suites and mismatches cannot replace either pairing',async()=>{
  const a=new Session(),b=new Session({cryptoProfile:'x25519'});
  const offerA=await a.offer(),offerB=await b.offer();
  await assert.rejects(a.receive(offerB),/cryptographic profile/);
  await assert.rejects(b.receive(offerA),/cryptographic profile/);
  assert.equal(a.info.state,'offering');assert.equal(b.info.state,'offering');
  for(const [target,foreign,version] of [[a,offerB,2],[b,offerA,3]]) {
    const altered=foreign.slice();altered[1]=version;
    await assert.rejects(target.receive(altered));
    assert.equal(target.info.state,'offering');
  }
  const legacy=new Session(),compact=new Session({cryptoProfile:'x25519'});
  await a.receive((await legacy.receive(offerA)).outbound);
  await b.receive((await compact.receive(offerB)).outbound);
  assert.equal(a.info.fingerprint,legacy.info.fingerprint);
  assert.equal(b.info.fingerprint,compact.info.fingerprint);
  assert.notEqual(a.info.fingerprint,b.info.fingerprint);
});

nodeTest('X25519 refuses low-order and noncanonical keys without consuming pairing or rekey state',async()=>{
  const profile=getCryptoProfile('x25519');
  const prime=new Uint8Array(32).fill(255);prime[0]=0xed;prime[31]=0x7f;
  const above=prime.slice();above[0]++;
  const topBit=new Uint8Array(32);topBit[0]=9;topBit[31]=0x80;
  const one=new Uint8Array(32);one[0]=1;
  const keys=[new Uint8Array(32),one,prime,above,topBit,new Uint8Array(32).fill(255)];
  const a=new Session({cryptoProfile:'x25519'}),b=new Session({cryptoProfile:'x25519'});
  const offer=await a.offer(),answer=(await b.receive(offer)).outbound;
  for(const publicKey of keys) {
    const invalidAnswer=answer.slice();invalidAnswer.set(publicKey,3);
    await assert.rejects(a.receive(invalidAnswer));assert.equal(a.info.state,'offering');
    const invalidOffer=offer.slice();invalidOffer.set(publicKey,3);
    const fresh=new Session({cryptoProfile:'x25519'});
    await assert.rejects(fresh.receive(invalidOffer));assert.equal(fresh.info.state,'idle');
    assert.equal(fresh.info.role,null);
  }
  await a.receive(answer);await b.receive(await a.confirm());await a.receive(await b.confirm());
  const before=b._current.rxControlHigh;
  for(const publicKey of keys) {
    const share=new Uint8Array(profile.shareBytes);share.set(publicKey);
    const hostile=await a._seal(a._current,3,share);
    await assert.rejects(b.receive(hostile));
    assert.equal(b.info.state,'ready');assert.equal(b._pending,null);
    assert.equal(b._current.rxControlHigh,before);
  }
  const rekeyOffer=await a.rekey(),rekeyAnswer=(await b.receive(rekeyOffer)).outbound;
  const commit=(await a.receive(rekeyAnswer)).outbound,finish=(await b.receive(commit)).outbound;
  await a.receive(finish);
  assert.equal(a.info.state,'ready');assert.equal(b.info.state,'ready');
  assert.equal((await b.receive(await a.send('message','valid after rejection'))).text,'valid after rejection');
});

nodeTest('defensive all-zero key-agreement check rejects a nonconforming native provider',async()=>{
  const original=crypto.subtle.deriveBits.bind(crypto.subtle);
  const a=new Session({cryptoProfile:'x25519'}),b=new Session({cryptoProfile:'x25519'});
  const offer=await a.offer(),answer=(await b.receive(offer)).outbound;
  crypto.subtle.deriveBits=async (algorithm,...args)=>algorithm.name==='X25519'?new ArrayBuffer(32):original(algorithm,...args);
  try {
    await assert.rejects(a.receive(answer),/Invalid key agreement result/);
    assert.equal(a.info.state,'offering');
    await assert.rejects(checkCryptoProfile('x25519'),/Choose P-256 on both devices/);
  } finally {crypto.subtle.deriveBits=original;}
  await a.receive(answer);assert.equal(a.info.fingerprint,b.info.fingerprint);
});
