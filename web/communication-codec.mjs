// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Experimental protected four-tone profile. This writes TL; only C reads TL.
import {getAudioProfile} from './audio-profiles.mjs';
export const acousticLimits = Object.freeze({sampleRate:48000, seconds:20, textBytes:127, wireBytes:128,
  jsonMessages:8, workerSeconds:60, fileBytes:4 * 1024 * 1024});
export const preamble = Uint8Array.from([0,255,85,170,51,204,105,150]);
const utf8 = new TextEncoder(), textDecoder = new TextDecoder('utf-8', {fatal:true});
function mul(a,b) { let value=0; for(let i=0;i<4;i++){if(b&1)value^=a;b>>=1;a<<=1;if(a&16)a^=19;}return value; }
function crc(bytes,width,polynomial,initial) {
  let value=initial; const top=1<<(width-1),mask=(1<<width)-1;
  for(const byte of bytes){value^=byte<<(width-8);for(let i=0;i<8;i++)value=((value<<1)^((value&top)?polynomial:0))&mask;}return value;
}
const nibbles = bytes => Array.from(bytes).flatMap(value=>[value>>4,value&15]);
const pack = values => Uint8Array.from(Array.from({length:Math.ceil(values.length/2)},(_,i)=>(values[2*i]<<4)|(values[2*i+1]||0)));
export function rsEncode(data) {
  if(data.length!==11 || data.some(x=>!Number.isInteger(x)||x<0||x>15))throw Error('RS needs eleven nibbles.');
  let polynomial=[1],power=1;
  for(let root=1;root<=4;root++){power=mul(power,2);const next=Array(polynomial.length+1).fill(0);
    polynomial.forEach((value,i)=>{next[i]^=value;next[i+1]^=mul(value,power);});polynomial=next;}
  const out=[...data,0,0,0,0];
  for(let i=0;i<11;i++){const value=out[i];for(let j=1;j<polynomial.length;j++)out[i+j]^=mul(value,polynomial[j]);}
  return [...data,...out.slice(11)];
}
export function encodePayload(payload,sender=0) {
  if(!(payload instanceof Uint8Array)||payload.length>128||!Number.isInteger(sender)||sender<0||sender>65535)throw Error('Payload or sender exceeds this experimental profile.');
  const length=payload.length*2,prefix=[(length>>8)&15,(length>>4)&15,length&15,0,(sender>>12)&15,(sender>>8)&15,(sender>>4)&15,sender&15];
  const check=crc(pack([...prefix,0]),8,7,0),header=pack(rsEncode([...prefix,check>>4,check&15,0]));
  const trailer=crc(payload,16,0x1021,0xffff),data=[...nibbles(payload),trailer>>12,(trailer>>8)&15,(trailer>>4)&15,trailer&15];
  while(data.length%11)data.push(0);
  const blocks=[];for(let i=0;i<data.length;i+=11)blocks.push(rsEncode(data.slice(i,i+11)));
  const interleaved=[];for(let i=0;i<15;i++)for(const block of blocks)interleaved.push(block[i]);
  const body=pack(interleaved);
  return Uint8Array.from([...header,...body.slice(0,8),...header,...body.slice(8)]);
}
export function textPayload(text) {
  if(typeof text!=='string')throw Error('Message must be text.');
  const data=utf8.encode(text);
  if(textDecoder.decode(data)!==text)throw Error('Message contains an invalid Unicode character.');
  if(!data.length||data.length>127)throw Error('Use 1–127 UTF-8 bytes; some characters use several bytes.');
  return Uint8Array.from([0,...data]); // Existing raw application mode; no dictionary or compression.
}
export function payloadText(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length<2||bytes.length>128||bytes[0]!==0)throw Error('Unsupported application payload; raw text mode is required.');
  return textDecoder.decode(bytes.slice(1));
}
export function glyphFrequencies(value,profile='nearby') {
  if(!Number.isInteger(value)||value<0||value>255)throw Error('Glyph must be a byte.');
  const audio=getAudioProfile(profile);
  return [0,1,2,3].map(band=>audio.toneBaseHz+audio.toneStepHz*(band*16+((value>>4)^mul(value&15,band))));
}
export function messageTimeline(text,engine) {
  return payloadTimeline(textPayload(text),engine);
}
export function payloadTimeline(payload,engine,profile='nearby') {
  if(typeof engine!=='string'||!/^a1(?: [A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_-]+)+$/.test(engine))throw Error('Native engine identity is unavailable.');
  const audio=getAudioProfile(profile),scale=audio.symbolMs/20;
  const values=Uint8Array.from([...preamble,...encodePayload(payload)]);
  const rows=['timeline draft1','engine '+engine,'fs 48000','length_ns '+((80*scale+values.length*audio.symbolMs)*1000000),'streams message',
    'patch sine 0 65536 300 0 0 0 1 1 0 1','patch sine 1 65536 0 0 0 0 1 1 0 1',
    ...[0,1,2,3].map(voice=>'voice '+voice+' sine')];
  values.forEach((value,index)=>{const start=(40*scale+index*audio.symbolMs)*1000000;glyphFrequencies(value,profile).forEach((frequency,voice)=>{
    rows.push(start+' message '+voice+' on '+(frequency*1000)+' 32767');rows.push((start+18000000*scale)+' message '+voice+' off');});});
  return rows.join('\n')+'\n';
}
// Nominal-rate conversion only. This does not estimate physical clock drift.
export function receiverPCM(samples,rate) {
  if(!(samples instanceof Float32Array)||![44100,48000].includes(rate)||!samples.length||samples.length>rate*20)throw Error('Use up to 20 seconds of 44.1/48 kHz audio.');
  for(const sample of samples)if(!Number.isFinite(sample))throw Error('Audio contains a non-finite sample.');
  const count=Math.floor(samples.length*48000/rate),out=new Int16Array(count);let clipped=0;
  for(let i=0;i<count;i++){const position=i*rate/48000,index=Math.floor(position),fraction=position-index;
    const value=samples[index]*(1-fraction)+samples[Math.min(index+1,samples.length-1)]*fraction;
    if(value>32767/32768||value< -1)clipped++;out[i]=Math.max(-32768,Math.min(32767,Math.round(value*32768)));}
  return {pcm:out,clipped,inputRate:rate,resampled:rate!==48000};
}
export function readCaptureWav(buffer) {
  if(!(buffer instanceof ArrayBuffer)||buffer.byteLength>acousticLimits.fileBytes||buffer.byteLength<44)throw Error('WAV exceeds the 4 MiB limit or is incomplete.');
  const view=new DataView(buffer),tag=offset=>String.fromCharCode(...new Uint8Array(buffer,offset,4));
  if(tag(0)!=='RIFF'||tag(8)!=='WAVE'||view.getUint32(4,true)+8!==buffer.byteLength)throw Error('Use a complete PCM16 WAV file.');
  let format=null,data=null;
  for(let offset=12;offset+8<=buffer.byteLength;){const size=view.getUint32(offset+4,true),end=offset+8+size;
    if(end>buffer.byteLength)throw Error('Truncated WAV chunk.');
    if(tag(offset)==='fmt '){if(format||size<16)throw Error('Invalid WAV format chunk.');format={encoding:view.getUint16(offset+8,true),channels:view.getUint16(offset+10,true),rate:view.getUint32(offset+12,true),align:view.getUint16(offset+20,true),bits:view.getUint16(offset+22,true)};}
    if(tag(offset)==='data'){if(data)throw Error('Repeated WAV data chunk.');data={offset:offset+8,size};}offset=end+(size&1);
  }
  if(!format||!data||format.encoding!==1||format.bits!==16||![1,2].includes(format.channels)||format.align!==format.channels*2||data.size%format.align||![44100,48000].includes(format.rate))throw Error('Use mono/stereo PCM16 WAV at 44.1 or 48 kHz.');
  const frames=data.size/format.align;
  if(!frames||frames>format.rate*20)throw Error('WAV must contain up to 20 seconds of audio.');
  const samples=new Float32Array(frames);
  for(let frame=0;frame<frames;frame++)samples[frame]=view.getInt16(data.offset+frame*format.align,true)/32768;
  return {samples,rate:format.rate,channels:format.channels}; // First capture channel; never an antiphase-sensitive mid mix.
}
export function pcmWav(pcm,rate=48000) {
  const out=new Uint8Array(44+pcm.length*2),view=new DataView(out.buffer);const label=(at,value)=>out.set(utf8.encode(value),at);
  label(0,'RIFF');view.setUint32(4,out.length-8,true);label(8,'WAVE');label(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);label(36,'data');view.setUint32(40,pcm.length*2,true);
  pcm.forEach((sample,i)=>view.setInt16(44+i*2,sample,true));return out;
}
export async function decodePCM(module,pcm) {
  if(!(pcm instanceof Int16Array)||!pcm.length||pcm.length>48000*20)throw Error('Receiver PCM exceeds the 20-second limit.');
  const instance=await WebAssembly.instantiate(module,{}),api=instance.exports;
  if(api.memory.buffer.byteLength>262144)throw Error('Decoder memory limit exceeded.');
  api.acoustic_reset();const input=new Int16Array(api.memory.buffer,api.acoustic_input(),4096);
  for(let offset=0;offset<pcm.length;offset+=4096){const part=pcm.subarray(offset,offset+4096);input.set(part);if(api.acoustic_feed(part.length))throw Error('Receiver refused: capacity, state or numeric limit.');}
  if(api.acoustic_finish()||api.acoustic_numeric_errors())throw Error('Receiver did not finish cleanly.');
  const messages=[];
  for(let i=0;i<api.acoustic_count();i++){const bytes=new Uint8Array(api.memory.buffer,api.acoustic_payload(i),api.acoustic_length(i)).slice();
    messages.push({bytes,sender:api.acoustic_sender(i),onsetSample:api.acoustic_onset(i),correctedNibbles:api.acoustic_corrected(i)});}
  return {messages,receiverStateBytes:api.acoustic_state_bytes()};
}
