// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Browser-only signed-enrollment demonstration. These are custom demo records,
// not X.509 certificates/PKCS#10 CSRs, and do not authenticate the audio session.

const ALGORITHM=Object.freeze({name:'ECDSA',namedCurve:'P-256'});
const SIGN=Object.freeze({name:'ECDSA',hash:'SHA-256'});
const REQUEST_DOMAIN='ToneSeal demo enrollment request v1\0';
const APPROVAL_DOMAIN='ToneSeal demo enrollment approval v1\0';
const REQUEST_TTL=3600,APPROVAL_TTL=3600,CLOCK_SKEW=60;
export const MAX_ARTIFACT_BYTES=2048;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const devices=new WeakMap(),authorities=new WeakMap();
const reject=message=>{throw Error(message);};
const now=()=>Math.floor(Date.now()/1000);
const REQUEST_FIELDS=['type','version','requestId','name','publicKey','createdAt','expiresAt'];
const APPROVAL_FIELDS=['type','version','serial','requestId','requestHash','subjectName','subjectPublicKey','authorityName','authorityPublicKey','issuedAt','expiresAt'];

function fields(value,expected) {
  if(!value||typeof value!=='object'||Array.isArray(value))reject('Unexpected demo record fields or ordering.');
  const keys=Object.keys(value);
  if(keys.length!==expected.length||keys.some((key,index)=>key!==expected[index]))reject('Unexpected demo record fields or ordering.');
}
function name(value) {
  if(typeof value!=='string'||!value.trim()||encoder.encode(value).length>64||/[\u0000-\u001f\u007f]/.test(value)||decoder.decode(encoder.encode(value))!==value)reject('Use a nonempty name of at most 64 UTF-8 bytes without control characters.');
  return value;
}
function b64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
function unb64(value,length) {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))reject('Invalid demo binary encoding.');
  let bytes;
  try{bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));}
  catch{reject('Invalid demo binary encoding.');}
  if(bytes.length!==length||b64(bytes)!==value)reject('Invalid demo binary length or encoding.');
  return bytes;
}
function snapshot(bytes) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX_ARTIFACT_BYTES)reject(`Use a demo record of 1–${MAX_ARTIFACT_BYTES} bytes.`);
  return new Uint8Array(bytes);
}
function encode(value) {
  const bytes=encoder.encode(JSON.stringify(value));
  if(bytes.length>MAX_ARTIFACT_BYTES)reject('Demo record exceeds its size limit.');
  return bytes;
}
function parse(bytes) {
  const copied=snapshot(bytes);let text,value;
  try{text=decoder.decode(copied);value=JSON.parse(text);}
  catch{reject('Invalid UTF-8 or JSON demo record.');}
  // Exact canonical serialization rejects whitespace variations, duplicate
  // members, alternative escapes/numbers, and trailing unparsed input.
  if(JSON.stringify(value)!==text)reject('Noncanonical demo record.');
  fields(value,['body','signature']);
  unb64(value.signature,64);
  return {bytes:copied,...value};
}
function timestamps(start,end,ttl) {
  const current=now();
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start!==ttl)reject('Invalid demo validity period.');
  if(start>current+CLOCK_SKEW)reject('Demo record is from the future. Check both device clocks.');
  if(end<=current)reject('Demo record has expired.');
}
async function publicKey(encoded) {
  const raw=unb64(encoded,65);
  if(raw[0]!==4)reject('Invalid P-256 public key encoding.');
  try{return await crypto.subtle.importKey('raw',raw,ALGORITHM,false,['verify']);}
  catch{reject('Invalid P-256 public key.');}
}
async function fingerprint(encoded) {
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',unb64(encoded,65)));
  return Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('').toUpperCase().match(/.{8}/g).join(' ');
}
function pin(value) {
  if(typeof value!=='string')reject('Independently verify and enter the authority fingerprint before accepting.');
  const compact=value.replaceAll(' ','').toUpperCase();
  if(!/^[0-9A-F]{64}$/.test(compact))reject('Enter the complete SHA-256 authority fingerprint.');
  return compact;
}
async function digest(bytes) {return b64(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));}
function signedBytes(domain,body) {
  const prefix=encoder.encode(domain),data=encode(body),result=new Uint8Array(prefix.length+data.length);
  result.set(prefix);result.set(data,prefix.length);return result;
}
async function sign(privateKey,domain,body) {
  const signature=new Uint8Array(await crypto.subtle.sign(SIGN,privateKey,signedBytes(domain,body)));
  if(signature.length!==64)reject('Unexpected native ECDSA signature encoding.');
  return encode({body,signature:b64(signature)});
}
async function verify(key,domain,body,signature) {
  if(!await crypto.subtle.verify(SIGN,key,unb64(signature,64),signedBytes(domain,body)))reject('Demo signature verification failed.');
}
async function generate() {
  if(!globalThis.crypto?.subtle)reject('Web Crypto requires HTTPS or localhost.');
  const keys=await crypto.subtle.generateKey(ALGORITHM,false,['sign','verify']);
  const raw=new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey));
  if(raw.length!==65||raw[0]!==4||keys.privateKey.extractable)reject('Native P-256 key generation did not preserve the demo key policy.');
  return {privateKey:keys.privateKey,publicKey:b64(raw)};
}
function live(map,handle,state) {
  if(map.get(handle)!==state)reject('This demo identity was cleared. Create a new one.');
}
function stateFor(map,handle) {
  const state=map.get(handle);
  if(!state)reject('This demo identity was cleared or is not a local identity.');
  return state;
}

export async function createDevice(deviceName) {
  deviceName=name(deviceName);
  const key=await generate(),createdAt=now();
  const body={type:'toneseal-enrollment',version:1,requestId:b64(crypto.getRandomValues(new Uint8Array(16))),
    name:deviceName,publicKey:key.publicKey,createdAt,expiresAt:createdAt+REQUEST_TTL};
  const bytes=await sign(key.privateKey,REQUEST_DOMAIN,body),publicFingerprint=await fingerprint(key.publicKey);
  const state={...key,body,bytes,accepted:false,accepting:false};
  const handle=Object.freeze({name:deviceName,fingerprint:publicFingerprint,requestId:body.requestId,
    enrollment(){return stateFor(devices,handle).bytes.slice();},
    dispose(){devices.delete(handle);state.privateKey=null;}});
  devices.set(handle,state);return handle;
}

export async function createAuthority(authorityName) {
  authorityName=name(authorityName);
  const key=await generate(),publicFingerprint=await fingerprint(key.publicKey);
  const state={...key,name:authorityName,issued:new Set(),pending:new Set()};
  const handle=Object.freeze({name:authorityName,fingerprint:publicFingerprint,
    dispose(){authorities.delete(handle);state.privateKey=null;state.issued.clear();state.pending.clear();}});
  authorities.set(handle,state);return handle;
}

async function enrollment(bytes) {
  const record=parse(bytes),body=record.body;
  fields(body,REQUEST_FIELDS);
  if(body.type!=='toneseal-enrollment'||body.version!==1)reject('Unsupported demo enrollment.');
  name(body.name);unb64(body.requestId,16);timestamps(body.createdAt,body.expiresAt,REQUEST_TTL);
  const key=await publicKey(body.publicKey);
  await verify(key,REQUEST_DOMAIN,body,record.signature);
  return record;
}

export async function inspectEnrollment(bytes) {
  const record=await enrollment(bytes),body=record.body;
  return Object.freeze({name:body.name,requestId:body.requestId,subjectFingerprint:await fingerprint(body.publicKey),
    createdAt:body.createdAt,expiresAt:body.expiresAt,byteLength:record.bytes.length,proofVerified:true});
}

export async function approveEnrollment(authority,bytes) {
  const state=stateFor(authorities,authority),record=await enrollment(bytes);
  live(authorities,authority,state);
  const requestHash=await digest(record.bytes);live(authorities,authority,state);
  const requestKey=record.body.publicKey+'/'+record.body.requestId;
  if(state.issued.size+state.pending.size>=128)reject('This demo authority has issued or queued 128 records. Clear it before issuing more.');
  if(state.issued.has(requestKey)||state.pending.has(requestKey))reject('This enrollment was already approved or approval is in progress.');
  state.pending.add(requestKey);
  try {
    const issuedAt=now(),request=record.body;
    timestamps(request.createdAt,request.expiresAt,REQUEST_TTL);
    const body={type:'toneseal-demo-approval',version:1,serial:b64(crypto.getRandomValues(new Uint8Array(16))),
      requestId:request.requestId,requestHash,subjectName:request.name,subjectPublicKey:request.publicKey,
      authorityName:state.name,authorityPublicKey:state.publicKey,issuedAt,expiresAt:issuedAt+APPROVAL_TTL};
    const result=await sign(state.privateKey,APPROVAL_DOMAIN,body);
    live(authorities,authority,state);state.issued.add(requestKey);return result;
  } finally {state.pending.delete(requestKey);}
}

async function approval(bytes) {
  const record=parse(bytes),body=record.body;
  fields(body,APPROVAL_FIELDS);
  if(body.type!=='toneseal-demo-approval'||body.version!==1)reject('Unsupported demo approval.');
  unb64(body.serial,16);unb64(body.requestId,16);unb64(body.requestHash,32);
  name(body.subjectName);name(body.authorityName);timestamps(body.issuedAt,body.expiresAt,APPROVAL_TTL);
  const issuer=await publicKey(body.authorityPublicKey);
  await publicKey(body.subjectPublicKey);
  await verify(issuer,APPROVAL_DOMAIN,body,record.signature);
  return record;
}
async function approvalSummary(record) {
  const body=record.body;
  return Object.freeze({subjectName:body.subjectName,subjectFingerprint:await fingerprint(body.subjectPublicKey),
    authorityName:body.authorityName,authorityFingerprint:await fingerprint(body.authorityPublicKey),serial:body.serial,
    requestId:body.requestId,issuedAt:body.issuedAt,expiresAt:body.expiresAt,byteLength:record.bytes.length,signatureVerified:true});
}

export async function inspectApproval(bytes) {return approvalSummary(await approval(bytes));}

export async function acceptApproval(device,bytes,expectedAuthorityFingerprint) {
  const expectedPin=pin(expectedAuthorityFingerprint),state=stateFor(devices,device);
  if(state.accepted||state.accepting)reject('This enrollment was already accepted or acceptance is in progress.');
  state.accepting=true;
  try {
    const record=await approval(bytes),body=record.body;live(devices,device,state);
    const summary=await approvalSummary(record);live(devices,device,state);
    if(pin(summary.authorityFingerprint)!==expectedPin)reject('Authority fingerprint does not match the independently verified pin.');
    const requestHash=await digest(state.bytes);live(devices,device,state);
    if(body.requestId!==state.body.requestId||body.requestHash!==requestHash||body.subjectName!==state.body.name||body.subjectPublicKey!==state.publicKey)reject('Approval does not match this device’s original enrollment.');
    if(body.issuedAt<state.body.createdAt-CLOCK_SKEW||body.issuedAt>=state.body.expiresAt)reject('Approval was issued outside this enrollment’s validity.');
    timestamps(body.issuedAt,body.expiresAt,APPROVAL_TTL);
    state.accepted=true;
    return Object.freeze({...summary,accepted:true});
  } finally {state.accepting=false;}
}
