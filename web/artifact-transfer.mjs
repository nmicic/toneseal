// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Bounded public demo envelopes over an existing verified encrypted session.
// This module does not parse identities, install trust, or execute received data.
import {AutoTransfer} from './auto-transfer.mjs';

export const MAX_ARTIFACT_BYTES=2048;
export const ARTIFACT_KINDS=Object.freeze(['enrollment','approval']);
const CHUNK_BYTES=48,MAX_RUN_MS=600000;
const hex=bytes=>Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const same=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
const fail=message=>{throw Error(message);};
function unbase64(text,length){
  if(typeof text!=='string'||!text.length||!/^[A-Za-z0-9_-]+$/.test(text)||text.length%4===1)fail('Invalid artifact encoding.');
  let value;
  try{value=Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-text.length%4)%4)),char=>char.charCodeAt(0));}
  catch{fail('Invalid artifact encoding.');}
  if(b64(value)!==text||(length!==undefined&&value.length!==length))fail('Noncanonical artifact encoding.');
  return value;
}
function validKind(kind){if(!ARTIFACT_KINDS.includes(kind))fail('Choose enrollment or approval.');return kind;}
function validBytes(bytes){if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>MAX_ARTIFACT_BYTES)fail(`Public demo envelopes must contain 1–${MAX_ARTIFACT_BYTES} bytes.`);}
const hash=async bytes=>new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));

export async function encodeArtifactFrames(input,kind){
  validKind(kind);validBytes(input);
  const bytes=new Uint8Array(input);
  try{
    const id=b64(crypto.getRandomValues(new Uint8Array(16))),digest=await hash(bytes),count=Math.ceil(bytes.length/CHUNK_BYTES);
    const frames=[`TS1M|${id}|${kind}|${bytes.length.toString(16).padStart(4,'0')}|${count.toString(16).padStart(2,'0')}|${b64(digest)}`];
    for(let index=0;index<count;index++)frames.push(`TS1D|${id}|${index.toString(16).padStart(2,'0')}|${b64(bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES))}`);
    if(frames.some(frame=>frame.length>96))fail('Artifact framing exceeds the encrypted message limit.');
    return{id,kind,sha256:hex(digest),digest:b64(digest),bytes:bytes.length,chunks:count,frames};
  }finally{bytes.fill(0);}
}

/** A malformed authenticated fragment poisons this object until reset. Partial
 * bytes never become an application artifact; only a complete digest match does. */
export class ArtifactAssembler{
  constructor({kind}){this.kind=validKind(kind);this.generation=0;this.reset();}
  _clear(){for(const part of this.parts||[])part.fill(0);this.parts=[];this.meta=null;this.next=0;}
  reset(){this.generation++;this._clear();this.failed=false;this.done=false;}
  async accept(text){
    const generation=this.generation;
    try{
      if(this.failed||this.done)fail('Artifact assembly is closed.');
      if(typeof text!=='string'||text.length>96||!/^[\x20-\x7e]+$/.test(text))fail('Invalid artifact fragment.');
      if(!this.meta){
        const match=/^TS1M\|([A-Za-z0-9_-]{22})\|(enrollment|approval)\|([0-9a-f]{4})\|([0-9a-f]{2})\|([A-Za-z0-9_-]{43})$/.exec(text);
        if(!match)fail('Expected an artifact manifest.');
        const [,id,kind,size,count,digest]=match,bytes=parseInt(size,16),chunks=parseInt(count,16);
        unbase64(id,16);unbase64(digest,32);
        if(kind!==this.kind)fail('The received artifact kind does not match this receiver.');
        if(bytes<1||bytes>MAX_ARTIFACT_BYTES||chunks!==Math.ceil(bytes/CHUNK_BYTES))fail('Artifact length or chunk count is invalid.');
        this.meta=Object.freeze({id,kind,bytes,chunks,digest});
        return{...this.meta,progress:0,complete:false};
      }
      const match=/^TS1D\|([A-Za-z0-9_-]{22})\|([0-9a-f]{2})\|([A-Za-z0-9_-]{1,64})$/.exec(text);
      if(!match)fail('Expected an artifact data fragment.');
      const [,id,indexText,encoded]=match,index=parseInt(indexText,16),meta=this.meta;
      if(id!==meta.id||index!==this.next||index>=meta.chunks)fail('Mixed, repeated, or out-of-order artifact fragment.');
      const expected=Math.min(CHUNK_BYTES,meta.bytes-index*CHUNK_BYTES),part=unbase64(encoded,expected);
      this.parts.push(part);this.next++;
      if(this.next<meta.chunks)return{...meta,progress:this.next,complete:false};
      this.done=true;
      const bytes=new Uint8Array(meta.bytes);let offset=0;
      for(const fragment of this.parts){bytes.set(fragment,offset);offset+=fragment.length;}
      try{
        const digest=await hash(bytes);
        if(generation!==this.generation)fail('Artifact assembly was reset.');
        if(this.failed)fail('Artifact assembly is closed.');
        if(!same(digest,unbase64(meta.digest,32)))fail('The complete artifact digest does not match its manifest.');
        const result={...meta,progress:this.next,complete:true,bytes:bytes.slice(),sha256:hex(digest)};
        this._clear();return result;
      }finally{bytes.fill(0);}
    }catch(error){if(generation===this.generation){this.failed=true;this._clear();}throw error;}
  }
}

/** One public envelope per verified session. Manifest and data use the existing
 * encrypted message kind and its exact-ciphertext retries. A final authenticated
 * application completion proves that a compatible artifact receiver assembled
 * the object, rather than merely acknowledging ordinary message fragments. */
export class ArtifactTransfer extends AutoTransfer{
  constructor(options={}){
    const maxRunMs=options.timing?.maxRunMs??MAX_RUN_MS;
    if(!Number.isInteger(maxRunMs)||maxRunMs<1||maxRunMs>MAX_RUN_MS)fail('Artifact lifetime must be positive and at most ten minutes.');
    super({...options,timing:{...options.timing,maxRunMs}});
  }
  _transportOptions(){return{maxRunMs:this._timing.maxRunMs};}
  _clearArtifact(){
    this._artifactBytes?.fill(0);this._artifactBytes=null;
    this._assembler?.reset();this._assembler=null;
    this._artifactFrames=null;this._artifactMeta=null;this._artifactIndex=0;
    this._artifactDone=false;this._artifactProofAccepted=false;this._artifactLastSent=false;
  }
  _cleanup(){super._cleanup();this._clearArtifact();}
  async start({bytes=null,kind,verifyPeer=true,profile='nearby',cryptoProfile='p256',volume}={}){
    if(this.state.active)fail('Stop the current artifact transfer before starting another.');
    validKind(kind);if(bytes!==null)validBytes(bytes);
    if(verifyPeer!==true)fail('Public enrollment transfers require Verify peer on both devices.');
    const snapshot=bytes===null?null:new Uint8Array(bytes);
    // super.start opens/resumes audio before its first await. Hashing and frame
    // preparation happen after pairing; no async work consumes the Start gesture.
    const opening=super.start({mode:'message',text:snapshot?'artifact':'',verifyPeer:true,profile,cryptoProfile,volume});
    const generation=this._generation;
    this._artifactKind=kind;this._artifactBytes=snapshot;
    this._assembler=snapshot?null:new ArtifactAssembler({kind});
    this._state={...this._state,artifactKind:kind,artifactBytes:snapshot?.length??0,
      artifactChunks:snapshot?Math.ceil(snapshot.length/CHUNK_BYTES):0,artifactProgress:0};
    if(this.state.active)this._emit();
    try{const state=await opening;if(generation===this._generation&&!state.active)this._clearArtifact();return state;}
    catch(error){if(generation===this._generation)this._clearArtifact();throw error;}
  }
  async _sendMessage(generation){
    if(this._dataPacket)return;
    if(!this._artifactFrames){
      const encoded=await encodeArtifactFrames(this._artifactBytes,this._artifactKind);this._check(generation);
      this._artifactMeta=encoded;this._artifactFrames=encoded.frames;this._artifactBytes.fill(0);this._artifactBytes=null;
    }
    const text=this._artifactFrames[this._artifactIndex];
    if(typeof text!=='string')fail('Artifact send state is invalid.');
    const packet=await this._session.send('message',text);this._check(generation);
    this._dataPacket=packet.slice();this._artifactLastSent=this._artifactIndex===this._artifactFrames.length-1;
    this._state={...this._state,artifactProgress:Math.max(0,this._artifactIndex-1)};
    this._emit('sending',this._artifactIndex===0?'Sending the public artifact manifest…':`Sending public artifact fragment ${this._artifactIndex} of ${this._artifactMeta.chunks}…`);
    this._setFlight(packet,'artifact-fragment',generation);
  }
  async _handlePayload(result,generation){
    if(!this._rekeyComplete)return;
    if(result.type!=='message'){this._fail(Error('Unexpected artifact channel.'),generation);return;}
    try{
      if(this._state.role==='sender'){
        const match=/^TS1F\|([A-Za-z0-9_-]{22})\|(enrollment|approval)\|([A-Za-z0-9_-]{43})$/.exec(result.text);
        const meta=this._artifactMeta;
        if(!match||!meta||!this._artifactLastSent||match[1]!==meta.id||match[2]!==meta.kind||match[3]!==meta.digest)fail('Invalid artifact completion receipt.');
        this._artifactProofAccepted=true;this._dropFlight();
        this._state={...this._state,artifactProgress:meta.chunks};
        if(result.outbound)await this._respond(result.outbound,generation);
        this._check(generation);
        this._finish('delivered','Public artifact delivery confirmed after the peer validated its complete digest.');
        return;
      }
      if(this._artifactDone)return;
      const assembled=await this._assembler.accept(result.text);this._check(generation);
      this._received=true;
      this._state={...this._state,artifactBytes:assembled.complete?assembled.bytes.length:assembled.bytes,
        artifactChunks:assembled.chunks,artifactProgress:assembled.progress};
      if(!assembled.complete){
        this._emit('receiving',`Receiving public artifact fragments: ${assembled.progress} of ${assembled.chunks}…`);
        if(result.outbound)await this._respond(result.outbound,generation);
        return;
      }
      try{this._onMessage({kind:assembled.kind,bytes:assembled.bytes.slice(),sha256:assembled.sha256});}
      finally{assembled.bytes.fill(0);}
      this._check(generation);this._artifactDone=true;
      this._emit('received','Public artifact received and its complete digest verified. Confirming completion…');
      this._timer(()=>this._finish('received','Public artifact verified. Completion receipt was not acknowledged; audio stopped automatically.'),this._timing.lingerMs);
      // Do not ACK the last fragment until complete-object verification succeeds.
      if(result.outbound)await this._respond(result.outbound,generation);
      this._check(generation);
      const completion=`TS1F|${assembled.id}|${assembled.kind}|${assembled.digest}`;
      const packet=await this._session.send('message',completion);this._check(generation);
      this._dataPacket=packet.slice();this._setFlight(packet,'artifact-complete',generation);
    }catch(error){if(error?.name==='AbortError')throw error;this._fail(error,generation);}
  }
  async _handleAck(result,generation){
    if(!this._dataPacket||this._session.info.pendingCount!==0)return;
    this._dropFlight();this._dataPacket=null;
    if(this._state.role==='receiver'){
      if(this._artifactDone)this._finish('received','Public artifact verified. Completion confirmed; audio stopped.');
      return;
    }
    this._state={...this._state,artifactProgress:Math.max(0,this._artifactIndex)};
    if(this._artifactIndex<this._artifactFrames.length-1){this._artifactIndex++;await this._sendMessage(generation);}
    else this._emit('sending','All fragments acknowledged. Waiting for the peer’s complete-artifact validation…');
  }
  async _handleDuplicateReceipt(result,generation){
    if(this._state.role==='sender'){
      if(this._artifactProofAccepted&&result.outbound)await this._respond(result.outbound,generation);
    }else await super._handleDuplicateReceipt(result,generation);
  }
  _fail(error,generation=this._generation){
    if(!this._active||generation!==this._generation)return;
    if(this._artifactDone&&this._state.role==='receiver'){
      this._finish('received','Public artifact verified. The final completion exchange did not finish; audio stopped.');return;
    }
    if(this._artifactProofAccepted&&this._state.role==='sender'){
      this._finish('delivered','Public artifact delivery confirmed. The final acknowledgment could not be sent.');return;
    }
    super._fail(error,generation);
  }
}
