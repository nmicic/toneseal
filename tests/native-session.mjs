// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
// Real OpenSSL C <-> Web Crypto interoperability; no substitute crypto or audio.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {AudioSession} from '../web/session.mjs';
import {decodeClearPacket} from '../web/clear-session.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const command=process.env.TONESEAL_SESSION_COMMAND?JSON.parse(process.env.TONESEAL_SESSION_COMMAND):[path.join(root,'build/session-driver')];
if(!process.env.TONESEAL_SESSION_COMMAND)execFileSync('python3',['scripts/build-cli.py','--session-driver',...(process.env.TONESEAL_SANITIZE?['--sanitize']:[])],{cwd:root,stdio:'pipe'});
const hex=bytes=>Buffer.from(bytes).toString('hex');
const bytes=value=>Uint8Array.from(Buffer.from(value,'hex'));
const encoder=new TextEncoder();
const closeNames=['open','drain','commit','ack','final'];
class Native {
  constructor(profile,purpose){
    this.child=spawn(command[0],[...command.slice(1),profile,purpose],{stdio:['pipe','pipe','pipe']});
    this.jobs=[];this.stderr='';this.info={};
    this.child.stderr.on('data',data=>{this.stderr=(this.stderr+data).slice(-3000);});
    createInterface({input:this.child.stdout}).on('line',line=>{
      const job=this.jobs.shift();if(!job)return;
      clearTimeout(job.timer);
      try{const result=JSON.parse(line);this.info=result.info;result.ok?job.resolve(result):job.reject(Error(result.error||'Native command refused.'));}
      catch(error){job.reject(error);}
    });
    this.child.on('error',error=>this.abort(error));
    this.child.on('exit',(code,signal)=>{if(this.jobs.length)this.abort(Error(`Native oracle exited ${code}/${signal}: ${this.stderr}`));});
  }
  abort(error){for(const job of this.jobs.splice(0)){clearTimeout(job.timer);job.reject(error);}}
  call(line){return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.child.kill();this.abort(Error('Native oracle timed out.'));},15000);
    this.jobs.push({resolve,reject,timer});this.child.stdin.write(line+'\n');
  });}
  async packet(line){return bytes((await this.call(line)).packet);}
  offer(){return this.packet('offer');}
  confirm(){return this.packet('confirm');}
  rekey(){return this.packet('rekey');}
  retryPending(){return this.packet('retry-pending');}
  retry(){return this.packet('retry');}
  send(kind,text){return this.packet(`${kind} ${hex(encoder.encode(text))}`);}
  async receive(packet){
    const result=await this.call('receive '+hex(packet));
    if(result.outbound)result.outbound=bytes(result.outbound);
    if(result.text_hex!==undefined)result.text=new TextDecoder('utf-8',{fatal:true}).decode(bytes(result.text_hex));
    return result;
  }
  turn({reply=false,number,pending=false,close='open'}){return this.packet(`turn ${Number(reply)} ${number} ${Number(pending)} ${closeNames.indexOf(close)}`);}
  lockChatEpoch(){return this.call('lock-epoch');}
  lockChatData(){return this.call('lock-data');}
  reset(){return this.call('reset');}
  async close(){this.child.stdin.end();await new Promise(resolve=>{if(this.child.exitCode!==null)return resolve();this.child.once('exit',resolve);});assert.equal(this.child.exitCode,0,this.stderr);}
}
async function pair(nativeFirst,profile,purpose){
  const native=new Native(profile,purpose),js=new AudioSession({cryptoProfile:profile,purpose});
  const a=nativeFirst?native:js,b=nativeFirst?js:native;
  try{
    const offer=await a.offer(),answer=await b.receive(offer);await a.receive(answer.outbound);
    assert.equal(a.info.fingerprint,b.info.fingerprint);assert.match(a.info.fingerprint,/^(?:[0-9A-F]{4} ){7}[0-9A-F]{4}$/);
    await assert.rejects(()=>native.send('message','too early'),/confirm/i);
    const one=await a.confirm();await b.receive(one);
    await assert.rejects(()=>a.send('message','peer not confirmed'));
    const two=await b.confirm();await a.receive(two);
    assert.equal(a.info.state,'ready');assert.equal(b.info.state,'ready');
    return{a,b,native,js,offer,answer:answer.outbound,nativeFirst,purpose};
  }catch(error){await native.close();throw error;}
}
async function rekey(p){
  const fingerprint=p.a.info.fingerprint,first=await p.a.rekey(),second=await p.b.receive(first);
  assert.deepEqual(await p.a.rekey(),first,'resume retains exact rekey flight');
  const third=await p.a.receive(second.outbound),fourth=await p.b.receive(third.outbound);
  // Lose final READY, then repair from the already-switched responder cache.
  const repeat=await p.b.receive(third.outbound);assert.deepEqual(repeat.outbound,fourth.outbound);
  await p.a.receive(repeat.outbound);
  assert.equal(p.a.info.state,'ready');assert.equal(p.b.info.state,'ready');
  assert.equal(p.a.info.fingerprint,p.b.info.fingerprint);assert.notEqual(p.a.info.fingerprint,fingerprint);
}
async function ack(p,sender,receiver,result,number){
  if(p.purpose==='chat')await sender.receive(await receiver.turn({reply:receiver===p.b,number,pending:false}));
  else await sender.receive(result.outbound);
  assert.equal(sender.info.pendingCount,0);
}
for(const profile of ['p256','x25519'])for(const purpose of ['message','chat'])for(const nativeFirst of [true,false]){
  test(`OpenSSL/Web Crypto ${profile} ${purpose}, C ${nativeFirst?'initiator':'responder'}`,async()=>{
    const p=await pair(nativeFirst,profile,purpose);
    try{
      await rekey(p);
      if(purpose==='chat'){await p.a.lockChatEpoch();await p.b.lockChatEpoch();await assert.rejects(()=>p.native.receive(p.offer));}
      let number=1;
      for(const [sender,receiver,text] of [[p.a,p.b,'  é🔑\n\u0000exact bytes  '],[p.b,p.a,'x'.repeat(96)]]){
        const kind=purpose==='chat'?'message':'password',packet=await sender.send(kind,text);
        const bad=packet.slice();bad[bad.length-1]^=1;
        await assert.rejects(()=>receiver.receive(bad));assert.equal(sender.info.pendingCount,1);
        const accepted=await receiver.receive(packet);assert.equal(accepted.type,kind);assert.equal(accepted.text,text);
        assert.deepEqual(await sender.retryPending(),packet);
        const duplicate=await receiver.receive(packet);assert.equal(duplicate.type,'duplicate');assert.equal(duplicate.text,undefined);
        if(purpose==='message')assert.notDeepEqual(accepted.outbound,duplicate.outbound,'duplicate gets a fresh current receipt');
        await ack(p,sender,receiver,duplicate,number++);
      }
      // Eight admitted records, a hole, and explicit selective receipt bits.
      const packets=[];for(let i=0;i<8;i++)packets.push(await p.a.send('message','queue '+i));
      await assert.rejects(()=>p.a.send('message','ninth'));
      let received;
      for(let i=1;i<8;i++)received=await p.b.receive(packets[i]);
      if(purpose==='chat')await p.a.receive(await p.b.turn({reply:true,number:number++,pending:false}));
      else await p.a.receive(received.outbound);
      assert.equal(p.a.info.pendingCount,1);assert.deepEqual(await p.a.retryPending(),packets[0]);
      received=await p.b.receive(packets[0]);await ack(p,p.a,p.b,received,number++);
      if(purpose==='chat'){
        const poll=await p.a.turn({number:number++,pending:false,close:'drain'}),event=await p.b.receive(poll);
        assert.equal(event.close,'drain');const duplicate=await p.b.receive(poll);assert.equal(duplicate.duplicate,true);
        assert.deepEqual(duplicate.acknowledged,[]);
        await p.a.lockChatData();await p.b.lockChatData();
        await assert.rejects(()=>p.a.send('message','after fence'));
      }
      await p.native.reset();assert.equal(p.native.info.state,'idle');await assert.rejects(()=>p.native.receive(p.answer));
    }finally{await p.native.close();}
  });
}
for(const profile of ['p256','x25519']){
  test(`native ${profile} reflection, malformed receipts and Unicode refusal`,async()=>{
    const n=new Native(profile,'message');
    try{
      const offer=await n.offer(),reflected=offer.slice();reflected[2]=2;
      await assert.rejects(()=>n.receive(reflected));assert.equal(n.info.state,'offering');
      const js=new AudioSession({cryptoProfile:profile});await n.receive((await js.receive(offer)).outbound);
      await js.receive(await n.confirm());await n.receive(await js.confirm());
      await n.send('message','one');await n.send('message','two');
      const body=new Uint8Array(12);new DataView(body.buffer).setUint32(0,99,false);body[4]=1;
      const forged=await js._serial(()=>js._seal(js._current,6,body));
      await assert.rejects(()=>n.receive(forged));
      assert.equal(n.info.pendingCount,2,'invalid receipt cannot prune anything');
      await assert.rejects(()=>n.rekey(),/pending/i);
      await assert.rejects(()=>n.call('message c0af'),/UTF-8/);
      const invalid=await js._serial(()=>js._seal(js._current,1,Uint8Array.of(0xed,0xa0,0x80)));
      await assert.rejects(()=>n.receive(invalid),/UTF-8/);
      const valid=await js.send('message','still works');assert.equal((await n.receive(valid)).text,'still works');
    }finally{await n.close();}
  });
}
test('native cleartext records use the existing browser checksum and exact text',async()=>{
  const n=new Native('p256','message');
  try{
    for(const text of ['hello',' é\n\u0000 ','😀'.repeat(24)]){
      const packet=await n.packet('clear '+hex(encoder.encode(text))),decoded=await decodeClearPacket(packet);
      assert.equal(decoded.text,text);
    }
    await assert.rejects(()=>n.call('clear eda080'));
  }finally{await n.close();}
});
