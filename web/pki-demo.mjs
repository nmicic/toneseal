// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// A guided native-browser signed-enrollment example. No X.509 or system trust.
import {ArtifactTransfer} from './artifact-transfer.mjs';
import {createDevice,createAuthority,inspectEnrollment,approveEnrollment,inspectApproval,acceptApproval} from './demo-identity.mjs';
import {checkCryptoProfile} from './crypto-profiles.mjs';

const el=id=>document.getElementById(id);
let role='device',device=null,authority=null,enrollment=null,enrollmentInfo=null,approval=null,approvalInfo=null,accepted=null;
let generation=0,busy=false,inspecting=false,notice='',noticeError=false,compactSupport='checking';
let state={phase:'idle',active:false,fingerprint:'',status:'No microphone is open.'};
const phaseLabels={idle:'Choose a role and create its identity',starting:'Opening the audio link',discovering:'Finding the other browser',verify:'Compare the transport fingerprints',confirming:'Confirming the encrypted session',rekeying:'Refreshing encrypted keys',sending:'Sending the signed envelope',receiving:'Receiving the signed envelope',delivered:'Delivery confirmed',received:'Envelope received',stopped:'Audio stopped',error:'Transfer stopped'};
const transfer=new ArtifactTransfer({onChange(next){state=next;render();},onMessage:handleArtifact});
const showNotice=(text,error=false)=>{notice=text;noticeError=error;render();};
const stamp=seconds=>new Date(seconds*1000).toLocaleString();
const validPin=()=>/^[0-9a-f]{64}$/i.test(el('authority-pin').value.replace(/\s/g,''));
const unsupported=()=>el('demo-crypto-profile').value==='x25519'&&compactSupport!=='supported';

function render(){
  const locked=busy||inspecting||state.active,hasIdentity=Boolean(device||authority);
  el('device-panel').hidden=role!=='device';el('authority-panel').hidden=role!=='authority';
  for(const choice of ['device','authority']){
    const button=el('role-'+choice),selected=role===choice;
    button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=locked||hasIdentity;
  }
  el('role-hint').textContent=hasIdentity?'Keep both pages visible. Reset this demonstration to change roles or create new identities.':`Use ${role==='device'?'Device here and Authority':'Authority here and Device'} on the other browser. Keep both pages visible.`;
  el('create-device').disabled=locked||Boolean(device);el('device-name').disabled=locked||Boolean(device);
  el('create-authority').disabled=locked||Boolean(authority);el('authority-name').disabled=locked||Boolean(authority);
  el('device-identity').hidden=!device;el('device-fingerprint').textContent=device?.fingerprint||'';
  el('authority-identity').hidden=!authority;el('authority-fingerprint').textContent=authority?.fingerprint||'';
  el('send-enrollment').disabled=locked||!device||Boolean(accepted)||unsupported();
  el('receive-approval').disabled=locked||!device||Boolean(accepted)||unsupported();
  el('receive-enrollment').disabled=locked||!authority||unsupported();
  el('enrollment-panel').hidden=!enrollmentInfo;
  el('request-name').textContent=enrollmentInfo?.name||'';el('request-id').textContent=enrollmentInfo?.requestId||'';
  el('request-expiry').textContent=enrollmentInfo?stamp(enrollmentInfo.expiresAt):'';
  el('request-fingerprint').textContent=enrollmentInfo?.subjectFingerprint||'';
  el('approve-enrollment').disabled=locked||!authority||!enrollment||Boolean(approval);
  el('approval-ready').textContent=role==='authority'&&approval?`Signed reply ready · ${approval.length} bytes. Approval lasts one hour. Its signature does not install a certificate or grant access by itself.`:'';
  el('send-approval').disabled=locked||!authority||!approval||unsupported();
  el('approval-panel').hidden=role!=='device'||!approvalInfo;
  el('approval-description').textContent=approvalInfo?`A signed reply from “${approvalInfo.authorityName}” names “${approvalInfo.subjectName}”. It expires ${stamp(approvalInfo.expiresAt)}.`:'';
  el('received-authority-fingerprint').textContent=approvalInfo?.authorityFingerprint||'';
  el('authority-pin').readOnly=Boolean(accepted);el('authority-pin').disabled=busy||inspecting;
  el('accept-approval').disabled=state.active||busy||inspecting||!approvalInfo||!device||!validPin()||Boolean(accepted);
  el('acceptance-status').textContent=accepted?'Enrollment accepted. The pinned authority signed this device’s original request. Trust lasts only for this demonstration.':'';
  el('acceptance-status').classList.toggle('accepted',Boolean(accepted));
  el('demo-phase').textContent=phaseLabels[state.phase]||'Transferring through sound';
  el('demo-status').textContent=state.status||'No microphone is open.';
  const chunks=state.artifactChunks,progress=state.artifactProgress;
  el('demo-progress').textContent=chunks?`${state.artifactBytes||0} envelope bytes · ${progress||0} of ${chunks} parts confirmed`:'Requests and replies travel only through the encrypted audio exchange.';
  const confirmation=state.active&&state.verification==='required'&&!state.peerVerified&&Boolean(state.fingerprint);
  el('demo-verification').hidden=!confirmation;el('demo-fingerprint').textContent=state.fingerprint||'';
  el('demo-confirm').disabled=!confirmation;el('demo-stop').hidden=!state.active;
  el('activity-dot').classList.toggle('active',Boolean(state.active));
  el('demo-notice').textContent=notice;el('demo-notice').classList.toggle('rejected',noticeError);
  for(const id of ['demo-audio-profile','demo-crypto-profile'])el(id).disabled=locked;
  el('demo-crypto-profile').querySelector('[value="x25519"]').disabled=compactSupport!=='supported';
}

async function makeIdentity(which){
  if(busy||inspecting||state.active||device||authority)return;
  const token=generation;busy=true;notice='Creating a native browser identity…';noticeError=false;render();
  try{
    const handle=await(which==='device'?createDevice(el('device-name').value):createAuthority(el('authority-name').value));
    if(token!==generation){handle.dispose();return;}
    if(which==='device')device=handle;else authority=handle;
    notice=which==='device'?'Device identity ready. On Authority, press Receive request; then send from here.':'Authority identity ready. Share its fingerprint through a trusted comparison, then receive the device’s request.';
  }catch(error){if(token===generation){notice=error.message;noticeError=true;}}
  finally{if(token===generation){busy=false;render();}}
}

async function handleArtifact(message){
  const token=generation;inspecting=true;notice='Checking the signed envelope…';noticeError=false;render();
  try{
    const bytes=new Uint8Array(message.bytes);
    if(role==='authority'&&message.kind==='enrollment'){
      const inspected=await inspectEnrollment(bytes);if(token!==generation)return;
      enrollment=bytes;enrollmentInfo=inspected;approval=null;
      notice='Request signature checked. When audio finishes, inspect the device and decide whether to approve it.';
    }else if(role==='device'&&message.kind==='approval'){
      const inspected=await inspectApproval(bytes);if(token!==generation)return;
      approval=bytes;approvalInfo=inspected;accepted=null;el('authority-pin').value='';
      notice='Reply signature checked, but the authority is not trusted yet. Enter its full fingerprint from a trusted comparison before accepting.';
    }else throw Error('This envelope does not match the selected showcase role.');
  }catch(error){if(token===generation){notice='Signed envelope rejected: '+error.message;noticeError=true;}}
  finally{if(token===generation){inspecting=false;render();}}
}

function start(kind,bytes){
  if(state.active||busy||inspecting||unsupported())return;
  const token=++generation;
  if(bytes===null){
    if(kind==='enrollment'){enrollment=null;enrollmentInfo=null;approval=null;}
    else{approval=null;approvalInfo=null;accepted=null;el('authority-pin').value='';}
  }
  notice='Compare every transport fingerprint group and Continue on both browsers when asked.';noticeError=false;
  // Keep transport.start in this click gesture. Preparation/signing happens in
  // separate explicit actions; no awaited work precedes microphone activation.
  const opening=transfer.start({kind,bytes,verifyPeer:true,profile:el('demo-audio-profile').value,cryptoProfile:el('demo-crypto-profile').value,volume:1});
  Promise.resolve(opening).catch(error=>{if(token===generation)showNotice(error.message,true);});render();
}

async function approve(){
  if(state.active||busy||inspecting||!authority||!enrollment||approval)return;
  const token=generation;busy=true;notice='Signing this enrollment request…';noticeError=false;render();
  try{
    const bytes=await approveEnrollment(authority,enrollment);
    if(token!==generation)return;approval=bytes;
    notice='Signed reply prepared. On Device, press Receive reply; then Send signed reply here.';
  }catch(error){if(token===generation){notice=error.message;noticeError=true;}}
  finally{if(token===generation){busy=false;render();}}
}

async function accept(){
  if(state.active||busy||inspecting||!device||!approval||!approvalInfo||accepted||!validPin())return;
  const token=generation;busy=true;notice='Checking the pinned authority and original request…';noticeError=false;render();
  try{
    const result=await acceptApproval(device,approval,el('authority-pin').value.replace(/\s/g,''));
    if(token!==generation)return;accepted=result;notice='Accepted locally. No system certificate was installed and no command was executed.';
  }catch(error){if(token===generation){notice='Approval not accepted: '+error.message;noticeError=true;}}
  finally{if(token===generation){busy=false;render();}}
}

function reset(){
  generation++;transfer.stop();device?.dispose();authority?.dispose();
  device=null;authority=null;enrollment=null;enrollmentInfo=null;approval=null;approvalInfo=null;accepted=null;busy=false;inspecting=false;
  el('authority-pin').value='';state={phase:'idle',active:false,fingerprint:'',status:'Demo identities and trust decision cleared. No microphone is open.'};
  notice='Create a new identity to begin again.';noticeError=false;render();
}
for(const which of ['device','authority'])el('role-'+which).onclick=()=>{if(state.active||busy||inspecting||device||authority)return;generation++;role=which;render();};
el('create-device').onclick=()=>makeIdentity('device');el('create-authority').onclick=()=>makeIdentity('authority');
el('send-enrollment').onclick=()=>{if(device&&!accepted)start('enrollment',device.enrollment());};
el('receive-enrollment').onclick=()=>{if(authority)start('enrollment',null);};
el('receive-approval').onclick=()=>{if(device&&!accepted)start('approval',null);};
el('approve-enrollment').onclick=approve;el('send-approval').onclick=()=>{if(authority&&approval)start('approval',approval.slice());};
el('accept-approval').onclick=accept;el('authority-pin').oninput=render;
el('demo-confirm').onclick=()=>{const token=generation;Promise.resolve(transfer.confirm()).catch(error=>{if(token===generation)showNotice(error.message,true);});};
el('demo-stop').onclick=()=>{transfer.stop();showNotice('Audio stopped. If the other browser has confirmed delivery, continue with the next step.');};
el('demo-reset').onclick=reset;
for(const id of ['demo-audio-profile','demo-crypto-profile']){el(id).oninput=render;el(id).onchange=render;}
document.addEventListener('visibilitychange',()=>{if(document.hidden){transfer.stop();showNotice('Page hidden: audio stopped. Demo identities remain in memory; press Reset to discard them.');}});
window.addEventListener('pagehide',()=>{reset();});
checkCryptoProfile('x25519').then(()=>{compactSupport='supported';el('demo-crypto-support').textContent='Compact key exchange is supported here. Both browsers must select the same option.';render();},error=>{compactSupport='unsupported';el('demo-crypto-support').textContent=error.message;render();});
render();
