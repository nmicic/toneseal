// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDevice,createAuthority,inspectEnrollment,approveEnrollment,inspectApproval,acceptApproval,MAX_ARTIFACT_BYTES} from '../web/demo-identity.mjs';

const encoder=new TextEncoder(),decode=bytes=>JSON.parse(new TextDecoder().decode(bytes));
const encode=value=>encoder.encode(JSON.stringify(value));
const b64=bytes=>Buffer.from(bytes).toString('base64url');
async function fixture() {
  const device=await createDevice('Demo robot é'),authority=await createAuthority('Demo manufacturer');
  const request=device.enrollment(),approval=await approveEnrollment(authority,request);
  return {device,authority,request,approval};
}

test('native signed enrollment and explicit authority pin bind one credential to the original device request',async()=>{
  const {device,authority,request,approval}=await fixture();
  const inspected=await inspectEnrollment(request),candidate=await inspectApproval(approval);
  assert.equal(inspected.name,device.name);assert.equal(inspected.requestId,device.requestId);
  assert.equal(inspected.subjectFingerprint,device.fingerprint);assert.equal(inspected.proofVerified,true);
  assert.equal(candidate.authorityFingerprint,authority.fingerprint);assert.equal(candidate.subjectFingerprint,device.fingerprint);
  assert.equal(candidate.signatureVerified,true);assert.equal(candidate.accepted,undefined);
  assert.ok(request.length<=MAX_ARTIFACT_BYTES);assert.ok(approval.length<=MAX_ARTIFACT_BYTES);
  await assert.rejects(acceptApproval(device,approval,''),/complete SHA-256/);
  await assert.rejects(acceptApproval(device,approval),/Independently verify/);
  const accepted=await acceptApproval(device,approval,authority.fingerprint.toLowerCase().replaceAll(' ',''));
  assert.equal(accepted.accepted,true);assert.equal(accepted.subjectName,device.name);
  await assert.rejects(acceptApproval(device,approval,authority.fingerprint),/already accepted/);
});

test('request and approval bind every field and refuse changed signatures',async()=>{
  const {device,authority,request,approval}=await fixture();
  for(const field of ['requestId','name','publicKey','createdAt','expiresAt','type','version']) {
    const altered=decode(request),old=altered.body[field];
    altered.body[field]=typeof old==='number'?old+1:field==='name'?old+'!':old.slice(0,-1)+(old.endsWith('A')?'B':'A');
    await assert.rejects(inspectEnrollment(encode(altered)),undefined,field);
  }
  for(const field of ['serial','requestId','requestHash','subjectName','subjectPublicKey','authorityName','authorityPublicKey','issuedAt','expiresAt','type','version']) {
    const altered=decode(approval),old=altered.body[field];
    altered.body[field]=typeof old==='number'?old+1:field.endsWith('Name')?old+'!':old.slice(0,-1)+(old.endsWith('A')?'B':'A');
    await assert.rejects(acceptApproval(device,encode(altered),authority.fingerprint),undefined,field);
  }
  for(const [bytes,inspect] of [[request,inspectEnrollment],[approval,inspectApproval]]) {
    const altered=decode(bytes),signature=Buffer.from(altered.signature,'base64url');signature[0]^=1;altered.signature=b64(signature);
    await assert.rejects(inspect(encode(altered)),/signature verification/);
  }
  assert.equal((await acceptApproval(device,approval,authority.fingerprint)).accepted,true,'failed attempts do not consume the pending request');
});

test('wrong authority and another device request fail without silently trusting a received key',async()=>{
  const {device,authority,approval}=await fixture(),otherDevice=await createDevice(device.name),otherAuthority=await createAuthority(authority.name);
  await assert.rejects(acceptApproval(device,approval,otherAuthority.fingerprint),/Authority fingerprint/);
  await assert.rejects(acceptApproval(otherDevice,approval,authority.fingerprint),/original enrollment/);
  const rogueApproval=await approveEnrollment(otherAuthority,device.enrollment());
  await assert.rejects(acceptApproval(device,rogueApproval,authority.fingerprint),/Authority fingerprint/);
  assert.equal((await acceptApproval(device,approval,authority.fingerprint)).accepted,true);
});

test('canonical grammar rejects duplicates, unknown fields, alternate encodings, invalid keys, and oversized input',async()=>{
  const {request}=await fixture(),text=new TextDecoder().decode(request);
  const invalid=[encoder.encode(' '+text),encoder.encode(text+'\n'),encoder.encode(text.replace('"version":1','"version":1,"version":1')),
    Uint8Array.of(0xc0,0xaf),new Uint8Array(MAX_ARTIFACT_BYTES+1),new Uint8Array()];
  let altered=decode(request);altered.extra=true;invalid.push(encode(altered));
  altered=decode(request);altered.body.extra=true;invalid.push(encode(altered));
  altered=decode(request);altered.signature+='=';invalid.push(encode(altered));
  altered=decode(request);altered.body.publicKey=b64(Uint8Array.of(4,...new Uint8Array(64)));invalid.push(encode(altered));
  altered=decode(request);altered.body.publicKey=b64(new Uint8Array(65));invalid.push(encode(altered));
  altered=decode(request);altered.body.publicKey=b64(new Uint8Array(64));invalid.push(encode(altered));
  altered=decode(request);altered.body.createdAt=1.5;invalid.push(encode(altered));
  const reordered=decode(request);invalid.push(encode({signature:reordered.signature,body:reordered.body}));
  for(const bytes of invalid)await assert.rejects(inspectEnrollment(bytes));
  await assert.rejects(inspectEnrollment(text),/demo record/);
  assert.equal((await inspectEnrollment(request)).proofVerified,true);
});

test('requests and approvals expire after one hour, and future records fail',async()=>{
  const original=Date.now;let clock=2_000_000_000_000;Date.now=()=>clock;
  try {
    const {device,authority,request,approval}=await fixture();
    clock-=61_000;
    await assert.rejects(inspectEnrollment(request),/future/);
    await assert.rejects(inspectApproval(approval),/future/);
    clock+=3_662_000;
    await assert.rejects(inspectEnrollment(request),/expired/);
    const anotherAuthority=await createAuthority('Another authority');
    await assert.rejects(approveEnrollment(anotherAuthority,request),/expired/);
    await assert.rejects(acceptApproval(device,approval,authority.fingerprint),/expired/);
  } finally {Date.now=original;}
});

test('private keys remain native and nonextractable; public handles and copied requests expose no private key',async()=>{
  const original=crypto.subtle.generateKey.bind(crypto.subtle),privateKeys=[];
  crypto.subtle.generateKey=async(...args)=>{const result=await original(...args);privateKeys.push(result.privateKey);return result;};
  try {
    const {device,authority,request}=await fixture();
    assert.equal(privateKeys.length,2);
    for(const key of privateKeys) {
      assert.equal(key.extractable,false);await assert.rejects(crypto.subtle.exportKey('jwk',key));
    }
    assert.deepEqual(Object.keys(device),['name','fingerprint','requestId','enrollment','dispose']);
    assert.deepEqual(Object.keys(authority),['name','fingerprint','dispose']);
    assert.equal(JSON.stringify(device).includes('private'),false);
    assert.ok(Object.isFrozen(device));assert.ok(Object.isFrozen(authority));
    const altered=device.enrollment();altered.fill(0);assert.deepEqual(device.enrollment(),request);
  } finally {crypto.subtle.generateKey=original;}
});

test('approval and acceptance are serialized per identity; replay cannot issue or install twice',async()=>{
  const device=await createDevice('Concurrent device'),authority=await createAuthority('Concurrent authority');
  const issued=await Promise.allSettled([approveEnrollment(authority,device.enrollment()),approveEnrollment(authority,device.enrollment())]);
  assert.equal(issued.filter(result=>result.status==='fulfilled').length,1);
  const approval=issued.find(result=>result.status==='fulfilled').value;
  const accepted=await Promise.allSettled([acceptApproval(device,approval,authority.fingerprint),acceptApproval(device,approval,authority.fingerprint)]);
  assert.equal(accepted.filter(result=>result.status==='fulfilled').length,1);
  await assert.rejects(approveEnrollment(authority,device.enrollment()),/already approved/);
  await assert.rejects(acceptApproval(device,approval,authority.fingerprint),/already accepted/);
});

test('clearing identities invalidates handles and aborts pending acceptance',async()=>{
  const {device,authority,approval}=await fixture();
  const accepting=acceptApproval(device,approval,authority.fingerprint);device.dispose();
  await assert.rejects(accepting,/cleared/);
  assert.throws(()=>device.enrollment(),/cleared/);
  await assert.rejects(acceptApproval(device,approval,authority.fingerprint),/cleared/);
  authority.dispose();await assert.rejects(approveEnrollment(authority,new Uint8Array([1])),/cleared/);
});

test('human labels are bounded and invalid Unicode is rejected',async()=>{
  for(const value of ['', '  ', 'x'.repeat(65), '\ud800', 'bad\nname', null]) {
    await assert.rejects(createDevice(value));await assert.rejects(createAuthority(value));
  }
  const device=await createDevice('é'.repeat(32));assert.equal((await inspectEnrollment(device.enrollment())).name,'é'.repeat(32));
});
