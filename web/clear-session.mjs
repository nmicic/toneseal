// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// One outstanding cleartext message. Receipts detect loss and accidental
// corruption; every field is public and an active sender can forge a receipt.
const MAGIC = 0xa8, VERSION = 1, HEADER = 31, ID_BYTES = 12, CHECKSUM_BYTES = 16;
const kinds = Object.freeze({data:1, ack:2, fin:3});
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8',{fatal:true});
const domain = encoder.encode('audio-text-lab/clear/v1\0');
const equal = (a,b) => a.length === b.length && a.every((value,index) => value === b[index]);
export const MAX_CLEAR_TEXT_BYTES = 96;
export function isClearPacket(packet) { return packet instanceof Uint8Array && packet[0] === MAGIC; }

async function checksum(id,body) {
  const bytes = new Uint8Array(domain.length + id.length + body.length);
  bytes.set(domain); bytes.set(id,domain.length); bytes.set(body,domain.length + id.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)).slice(0,CHECKSUM_BYTES);
}
function header(packet) {
  if (!isClearPacket(packet) || packet[1] !== VERSION || !Object.values(kinds).includes(packet[2]) ||
      packet.length < HEADER || packet.length > HEADER + MAX_CLEAR_TEXT_BYTES ||
      (packet[2] === kinds.data ? packet.length === HEADER : packet.length !== HEADER))
    throw Error('Invalid cleartext record.');
  return {kind:Object.keys(kinds).find(name => kinds[name] === packet[2]),
    id:packet.slice(3,3 + ID_BYTES), checksum:packet.slice(3 + ID_BYTES,HEADER)};
}
export async function encodeClearData(text) {
  if (typeof text !== 'string') throw Error('Cleartext message must be text.');
  const body = encoder.encode(text);
  if (!body.length || body.length > MAX_CLEAR_TEXT_BYTES || decoder.decode(body) !== text)
    throw Error(`Use valid text with 1–${MAX_CLEAR_TEXT_BYTES} UTF-8 bytes.`);
  const packet = new Uint8Array(HEADER + body.length), id = crypto.getRandomValues(new Uint8Array(ID_BYTES));
  packet.set([MAGIC,VERSION,kinds.data]); packet.set(id,3);
  packet.set(await checksum(id,body),3 + ID_BYTES); packet.set(body,HEADER);
  return packet;
}
export async function decodeClearPacket(input) {
  // Own bytes before hashing so callers cannot change the accepted record while
  // Web Crypto is in flight.
  if (!(input instanceof Uint8Array)) throw Error('Cleartext record must be bytes.');
  const packet = new Uint8Array(input), record = header(packet);
  if (record.kind === 'data') {
    const body = packet.slice(HEADER);
    if (!equal(record.checksum,await checksum(record.id,body))) throw Error('Cleartext checksum mismatch.');
    record.text = decoder.decode(body);
  }
  return {...record,packet};
}
export function clearControl(packet,kind) {
  header(packet);
  if (kind !== 'ack' && kind !== 'fin') throw Error('Unknown cleartext control.');
  const control = packet.slice(0,HEADER); control[2] = kinds[kind]; return control;
}
export function sameClearTransfer(a,b) {
  return equal(a.id,b.id) && equal(a.checksum,b.checksum);
}
