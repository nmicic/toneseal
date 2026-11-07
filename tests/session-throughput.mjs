// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Real session/Web Crypto operations with modeled modem airtime. No microphone,
// renderer, room, turnaround, retransmission timer, or hardware latency is timed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {AudioSession} from '../web/session.mjs';
import {getCryptoProfile} from '../web/crypto-profiles.mjs';
import {encodePayload, preamble} from '../web/communication-codec.mjs';

const utf8 = new TextEncoder();
const airtime = packet => 80 + (preamble.length + encodePayload(packet).length) * 20;
const rounded = value => Number(value.toFixed(3));
const packetsMs = packets => packets.reduce((total, packet) => total + airtime(packet), 0);
const a = new AudioSession(), b = new AudioSession(), setupPackets = [];
const keepSetup = (kind, packet) => { setupPackets.push({kind, packet:packet.slice()}); return packet; };
const setupStart = performance.now();
const offer = keepSetup('offer', await a.offer());
const answer = keepSetup('answer', (await b.receive(offer)).outbound);
await a.receive(answer);
await b.receive(keepSetup('ready-a', await a.confirm()));
await a.receive(keepSetup('ready-b', await b.confirm()));
let receiver = b, packet = keepSetup('rekey-offer', await a.rekey()), rekeyStep = 0;
while (packet) {
  const result = await receiver.receive(packet);
  packet = result.outbound;
  if (packet) keepSetup(['rekey-answer','rekey-ready-a','rekey-ready-b'][rekeyStep++], packet);
  receiver = receiver === a ? b : a;
}
const setupWallMs = performance.now() - setupStart;
assert.equal(a.info.state, 'ready'); assert.equal(b.info.state, 'ready');
assert.equal(setupPackets.length, 8);
const setup = {packets:setupPackets.map(({kind,packet}) => ({kind,bytes:packet.length,airtimeMs:airtime(packet)})),
  airtimeMs:packetsMs(setupPackets.map(({packet}) => packet)), cryptoWallMs:rounded(setupWallMs)};

// Each direction keeps its own counters and receipt bitmap. This sequence uses
// one pairing and one rekey throughout, including whitespace and UTF-8 content.
const texts = ['a', 'Reply 1', 'Hello through sound', 'é🔐', 'The current time is 2026-10-28T12:34:56.000Z.',
  ' \0\n ', 'x'.repeat(32), 'x'.repeat(64), 'x'.repeat(96), 'Final reply'];
const payloads = [];
for (let index = 0; index < texts.length; index++) {
  const sender = index % 2 ? b : a, peer = sender === a ? b : a;
  const kind = index % 3 === 1 ? 'password' : 'message', text = texts[index], start = performance.now();
  const data = await sender.send(kind, text), result = await peer.receive(data);
  assert.equal(result.type, kind); assert.equal(result.text, text);
  assert.deepEqual(utf8.encode(result.text), utf8.encode(text));
  assert.equal(result.receipt, true);
  await sender.receive(result.outbound);
  assert.equal(sender.info.pendingCount, 0);
  const cryptoWallMs = rounded(performance.now() - start);
  payloads.push({bytes:utf8.encode(text).length, direction:sender === a ? 'a-to-b' : 'b-to-a', kind,
    packetCount:2, airtimeMs:airtime(data) + airtime(result.outbound), cryptoWallMs});
}
const messageAirMs = payloads.reduce((total, item) => total + item.airtimeMs, 0);
const sharedSessionAirMs = setup.airtimeMs + messageAirMs;
const freshSessionsAirMs = texts.length * setup.airtimeMs + messageAirMs;

// Queue a bounded burst at BOTH ends. The application admits each unique
// message once; missing receipts cause retries of the original ciphertext.
const burstStart = performance.now(), attempts = [], inbound = [new Map(),new Map()];
const peers = [a,b], originals = [new Map(),new Map()], bursts = [[],[]], acks = [[],[]];
let droppedDataFrames = 0, droppedAckFrames = 0, retransmittedDataFrames = 0, duplicateDataFrames = 0;
for (let side = 0; side < 2; side++) {
  for (let index = 0; index < 4; index++) {
    const text = `Burst ${side}:${index} · é\0\n`, data = await peers[side].send('message', text);
    const counter = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(11, false);
    bursts[side].push({text,data,counter}); originals[side].set(counter,data.slice());
    attempts.push(data);
  }
  assert.equal(peers[side].info.pendingCount, 4, 'Both sides retain all four unacknowledged ciphertexts');
}
async function deliver(side, data) {
  const result = await peers[1-side].receive(data);
  if (result.type === 'duplicate') duplicateDataFrames++;
  else {
    assert.equal(result.type, 'message');
    const expected = bursts[side].find(item => item.counter === result.counter);
    assert.ok(expected); assert.equal(result.text, expected.text);
    assert.deepEqual(utf8.encode(result.text), utf8.encode(expected.text));
    inbound[1-side].set(result.counter, (inbound[1-side].get(result.counter) || 0) + 1);
  }
  assert.equal(result.receipt, true); attempts.push(result.outbound);
  return result.outbound;
}
// Lose one DATA in each direction and deliver the others out of order.
for (const [side,order] of [[0,[3,0,2]],[1,[1,3,0]]]) {
  droppedDataFrames++;
  for (const index of order) acks[side].push(await deliver(side,bursts[side][index].data));
  // Only the first ACK arrives. Later receipt bitmaps are deliberately lost.
  await peers[side].receive(acks[side][0]); droppedAckFrames += acks[side].length - 1;
  assert.equal(peers[side].info.pendingCount, 3);
}
for (let side = 0; side < 2; side++) {
  for (let repairs = 0; peers[side].info.pendingCount; repairs++) {
    assert.ok(repairs < 4, 'Selective receipt repair must drain this bounded burst');
    const retry = peers[side].retryPending();
    const counter = new DataView(retry.buffer, retry.byteOffset, retry.byteLength).getUint32(11, false);
    assert.deepEqual(retry,originals[side].get(counter), 'Retransmit the exact retained ciphertext and nonce');
    attempts.push(retry); retransmittedDataFrames++;
    await peers[side].receive(await deliver(side,retry));
  }
}
const burstWallMs = performance.now() - burstStart;
assert.equal(a.info.pendingCount, 0); assert.equal(b.info.pendingCount, 0);
for (const deliveries of inbound) {
  assert.equal(deliveries.size, 4);
  for (const count of deliveries.values()) assert.equal(count, 1, 'Every application message is delivered once');
}
assert.equal(retransmittedDataFrames, 4, 'Current bitmaps repair lost ACKs without retrying every old DATA');
assert.equal(duplicateDataFrames, 2);
for (const item of [...setupPackets.map(item=>item.packet),...attempts]) assert.ok(item.length <= 128);

// Compare actual public/rekey records, not estimates based on key bits. AES
// keys never cross the link, and data/tag sizes stay identical in both suites.
const cryptoProfiles=[];
for(const id of ['p256','x25519']) {
  const profile=getCryptoProfile(id),left=new AudioSession({cryptoProfile:id}),right=new AudioSession({cryptoProfile:id}),frames=[];
  const retain=packet=>{frames.push(packet);return packet;};
  const offer=retain(await left.offer()),answer=retain((await right.receive(offer)).outbound);
  await left.receive(answer);
  assert.equal(left.info.fingerprint,right.info.fingerprint);
  await right.receive(retain(await left.confirm()));await left.receive(retain(await right.confirm()));
  let next=retain(await left.rekey()),peer=right;
  while(next){const result=await peer.receive(next);next=result.outbound;if(next)retain(next);peer=peer===left?right:left;}
  assert.equal(frames.length,8);assert.equal(left.info.state,'ready');assert.equal(right.info.state,'ready');
  const data=await left.send('password','é'.repeat(48)),result=await right.receive(data);
  assert.equal(result.text,'é'.repeat(48));assert.equal(result.type,'password');await left.receive(result.outbound);
  assert.equal(left.info.pendingCount,0);assert.equal(data.length,128);assert.equal(result.outbound.length,44);
  const nearbySetupMs=packetsMs(frames),telephoneSetupMs=nearbySetupMs/0.75;
  cryptoProfiles.push({id,publicKeyBytes:profile.publicKeyBytes,publicPacketBytes:offer.length,rekeyPacketBytes:frames[4].length,
    setupWireBytes:frames.reduce((sum,p)=>sum+p.length,0),nearbySetupMs,telephoneSetupMs:rounded(telephoneSetupMs),
    savedNearbyMs:setup.airtimeMs-nearbySetupMs,savedTelephoneMs:rounded((setup.airtimeMs-nearbySetupMs)/0.75),
    maximumDataBytes:data.length,receiptBytes:result.outbound.length,byteExact:true});
  left.reset();right.reset();
}
assert.equal(cryptoProfiles[1].savedNearbyMs,3600,'Compact setup saving must include actual modem framing');

const report = {schemaVersion:1,
  model:'Real Web Crypto/session operations; acoustic times are deterministic framing airtime only, without playback, room, waits, or device latency.',
  setup,payloads,cryptoProfiles,
  reuse:{messages:texts.length,sharedSessionAirMs,freshSessionsAirMs,savedAirMs:freshSessionsAirMs-sharedSessionAirMs},
  bidirectional:{messages:8,queuedPerDirection:4,droppedDataFrames,droppedAckFrames,retransmittedDataFrames,
    duplicateDataFrames,deliveredOnce:8,pendingA:a.info.pendingCount,pendingB:b.info.pendingCount,
    packetCount:attempts.length,airtimeMs:packetsMs(attempts),cryptoWallMs:rounded(burstWallMs)}};
const output = new URL('../out/session-throughput.json',import.meta.url);
await fs.mkdir(new URL('../out/',import.meta.url),{recursive:true});
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log('PASS real session reuse: 10 alternating byte-exact messages, then 4 queued each way with lost DATA/ACK, exact retries and one application delivery each.');
console.log(JSON.stringify(report,null,2));
