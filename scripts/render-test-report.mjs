// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Standalone local report: no dependencies, network requests, or secret payloads.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.resolve(process.argv[2] || path.join(root,'out'));
async function read(name) {
  try { return JSON.parse(await fs.readFile(path.join(directory,name),'utf8')); }
  catch(error) { if(error.code==='ENOENT')return null;throw error; }
}
const data={generatedAt:new Date().toISOString(),simulation:await read('simulated-transfer.json'),
  acoustic:await read('acoustic-impairments.json'),telephone:await read('telephone-channel.json'),throughput:await read('session-throughput.json'),
  profiles:await read('telephone-profiles.json'),profilesExtended:await read('telephone-profiles-extended.json')};
if(!data.simulation)throw Error('Run npm run test:simulation before generating the report.');
const json=JSON.stringify(data).replaceAll('<','\\u003c');
const html=String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ToneSeal · Transfer test report</title>
<style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#173638;background:#f4f6f1;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1200px;margin:auto;padding:32px 24px 60px}h1{font-size:clamp(28px,5vw,42px);letter-spacing:-1.2px;margin:10px 0}h2{font-size:21px;letter-spacing:-.3px}p{line-height:1.6}.subtle{color:#596c66;font-size:14px}.eyebrow{font:12px ui-monospace,monospace;letter-spacing:1.4px;color:#386754}.cards{display:flex;flex-wrap:wrap;gap:14px;margin:24px 0}.card{flex:1;min-width:180px;border:1px solid #d7dfd2;background:white;border-radius:10px;padding:18px}.card strong{display:block;font-size:29px;margin-bottom:4px}.card span{font-size:13px;color:#596c66}.section{margin-top:28px;padding:24px;border:1px solid #d7dfd2;border-radius:12px;background:#fff}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}th{font-weight:600;color:#53675e;white-space:nowrap}th,td{padding:11px 9px;border-bottom:1px solid #e5eae2;vertical-align:top}button,select{font:inherit;color:#184d42;border:1px solid #bdcfc2;border-radius:6px;background:#f5f9f2;padding:8px 10px;cursor:pointer}button:hover{background:#e5efdd}button:focus-visible,select:focus-visible{outline:3px solid #bf812b;outline-offset:2px}.name-button{border:0;background:none;padding:0;text-align:left;text-decoration:underline;text-underline-offset:3px}.pass{color:#256b43}.fail{color:#a33229}.expected{color:#8a6024}.mono{font:12px ui-monospace,monospace}.legend{display:flex;gap:20px;flex-wrap:wrap;font-size:12px;margin:14px 0}.legend span:before{content:'';display:inline-block;width:13px;height:10px;border-radius:2px;margin-right:6px;background:#386f65}.legend .b:before{background:#bf8330}.legend .lost:before{background:#c14c48}.legend .rx:before{background:#5273a0}.timeline-wrap{overflow:auto;margin-top:18px}svg{min-width:740px;width:100%;display:block}details{margin-top:18px}summary{cursor:pointer;color:#315d4d}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f1;padding:15px;border-radius:6px;font-size:12px}.note{border-left:3px solid #b58b49;padding-left:14px}.events{max-height:420px;overflow:auto}a{color:#245f4d}@media(max-width:600px){main{padding:22px 12px}.section{padding:16px}.cards{gap:8px}.card{min-width:140px;padding:14px}.card strong{font-size:24px}}
select{max-width:100%}
</style></head><body><main>
<div class="eyebrow">TONESEAL / LOCAL TEST REPORT</div><h1>Both devices, one timeline.</h1>
<p class="subtle">Byte accuracy, completion time, and recovery under controlled faults. This report separates virtual protocol timing, real synthetic audio decoding, and session reuse measurements.</p>
<div id="summary" class="cards"></div>
<section class="section"><h2>Protocol scenarios</h2><p class="subtle">Select a scenario to see both sides on the same clock. An expected failure passes only when it ends safely without a false delivery claim.</p><details><summary>All scenario results</summary><div class="table-wrap" id="scenarios"></div></details></section>
<section class="section" id="detail"><h2 id="scenario-title">Shared timeline</h2><label for="scenario-select">Scenario </label><select id="scenario-select"></select> <label style="font-size:12px;white-space:nowrap"><input id="show-linger" type="checkbox"> Include final listening interval</label><p id="scenario-description" class="subtle"></p><div id="metrics" class="cards"></div>
<div class="legend"><span>Device A transmission</span><span class="b">Device B transmission</span><span class="lost">Lost / collided transmission</span><span class="rx">Packet decoded</span></div>
<div id="timeline" class="timeline-wrap"></div><p class="subtle">Bars show waveform airtime. Empty spans include preparation, response waits, retries, or final listening. Hover a bar for the frame and time.</p>
<details><summary>Events and assertions</summary><div id="assertions"></div><div id="events" class="events"></div></details></section>
<section class="section"><h2>Actual audio impairments</h2><p class="subtle">These cases render PCM with the real synth and decode it with the native receiver. They test waveform damage; the protocol scenarios above model packet loss and turn taking.</p><div id="acoustic"></div></section>
<section class="section"><h2>Telephone codec diagnostics</h2><p class="subtle">Synthetic codec passes for a laptop → speakerphone call → laptop route. A diagnostic may finish successfully while a codec loses packets. This is not a qualification of an actual telephone call.</p><div id="telephone"></div></section>
<section class="section"><h2>Slower audio profiles</h2><p class="subtle">Reversible playback scaling narrows the tones and increases airtime. Nearby uses rate 1; experimental Telephone uses 0.75. Both devices select the same profile before Start.</p><div id="profiles"></div></section>
<section class="section"><h2>Keeping an encrypted session open</h2><p class="subtle">The cryptographic session supports both directions. Message chat reuses its session; Password and Clear text remain single transfers. These measurements compare session-layer airtime, without claiming physical-device latency.</p><div id="throughput"></div></section>
<section class="section"><h2>Model and limits</h2><p class="note">A simulation is not a room or phone measurement. The model uses production frame durations and timers, with explicit assumptions for preparation, capture, collisions, and loss. Acoustic cases use reproducible synthetic noise and gaps. Real microphones, speaker routing, echoes, operating-system interruptions, and human delays require device tests.</p><details><summary>Model configuration and report metadata</summary><pre id="model"></pre></details><p id="generated" class="subtle"></p></section>
</main><script id="report-data" type="application/json">__REPORT_DATA__</script>
<script>
'use strict';
const report=JSON.parse(document.getElementById('report-data').textContent),sim=report.simulation;
const el=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const seconds=value=>Number.isFinite(value)?(value/1000).toFixed(2)+' s':'—';
const number=value=>Number.isFinite(value)?value.toFixed(2):'—';
const card=(value,label)=>'<div class="card"><strong>'+esc(value)+'</strong><span>'+esc(label)+'</span></div>';
const scenarios=sim.scenarios||[],passed=scenarios.filter(s=>s.passed).length;
el('summary').innerHTML=card(passed+'/'+scenarios.length,'protocol scenarios passed')+card(scenarios.filter(s=>s.expected==='delivered').length,'delivery scenarios')+card(seconds(sim.summary?.virtualDurationMs),'virtual time covered')+card(seconds(sim.summary?.wallDurationMs),'simulation wall time');
const completion=s=>s.metrics?.deliveryMs??s.metrics?.elapsedMs;
el('scenarios').innerHTML='<table><thead><tr><th>Scenario</th><th>Expected outcome</th><th>Result</th><th>Completion</th><th>Bytes exact</th><th>Retries</th></tr></thead><tbody>'+scenarios.map((s,i)=>'<tr><td><button class="name-button" data-scenario="'+i+'">'+esc(s.name)+'</button></td><td class="'+(s.expected==='delivered'?'':'expected')+'">'+esc(s.expected)+'</td><td class="'+(s.passed?'pass':'fail')+'">'+(s.passed?'PASS':'FAIL')+'</td><td>'+seconds(completion(s))+'</td><td>'+esc(s.metrics?.byteExact===true?'Yes':s.metrics?.byteExact===false?'NO':'—')+'</td><td>'+esc(s.metrics?.retryCount??'—')+'</td></tr>').join('')+'</tbody></table>';
el('scenario-select').innerHTML=scenarios.map((s,i)=>'<option value="'+i+'">'+esc(s.name)+'</option>').join('');
function show(index){
 const s=scenarios[index];if(!s)return;el('scenario-select').value=String(index);el('scenario-title').textContent=s.name;
 const m=s.metrics||{},events=s.timeline||[];el('scenario-description').textContent='Mode: '+s.mode+' · Audio A/B: '+(s.profile||'nearby')+'/'+(s.receiverProfile||'nearby')+' · Crypto A/B: '+(s.cryptoProfile||'p256')+'/'+(s.receiverCryptoProfile||'p256')+' · Expected: '+s.expected+' · '+(s.passed?'Checks passed':'CHECK FAILED');
 el('metrics').innerHTML=card(seconds(completion(s)),m.deliveryMs==null?'elapsed without confirmation':'sender confirmation time')+card(seconds(m.airtimeMs),'total transmitted airtime')+card(m.deliveredBytes??0,'application bytes delivered')+card(number(m.goodputBytesPerSecond)+' B/s','application goodput');
 const endings=new Map(events.filter(e=>e.event==='tx-end').map(e=>[e.frameId,e]));
 const duration=e=>endings.get(e.frameId)?.durationMs??e.durationMs??0;
 const activity=events.filter(e=>['tx-start','rx','message','confirm'].includes(e.event));
 const end=Math.max(1,el('show-linger').checked?m.elapsedMs||0:completion(s)||0,...activity.map(e=>(e.atMs||0)+(e.event==='tx-start'?duration(e):0))),left=75,width=870;
 const x=t=>left+width*t/end, lane=id=>id==='B'?145:90;
 const lost=new Map(events.filter(e=>e.event==='drop'||e.event==='collision').map(e=>[e.frameId,e.reason||e.event]));
 let svg='<svg viewBox="0 0 1000 205" role="img" aria-label="Transmission timeline for '+esc(s.name)+'"><rect width="1000" height="205" fill="#fff"/>';
 for(let i=0;i<=5;i++){const at=end*i/5;svg+='<line x1="'+x(at)+'" x2="'+x(at)+'" y1="40" y2="170" stroke="#e3e8df"/><text x="'+x(at)+'" y="27" text-anchor="middle" font-size="12" fill="#53675e">'+(at/1000).toFixed(1)+'s</text>';}
 for(const id of ['A','B'])svg+='<text x="14" y="'+(lane(id)+4)+'" font-size="14" fill="#173638">Device '+id+'</text><line x1="'+left+'" x2="945" y1="'+lane(id)+'" y2="'+lane(id)+'" stroke="#d5dfd2"/>';
 for(const e of events){
  if(e.event==='tx-start'){
   const why=lost.get(e.frameId),fill=why?'#c14c48':e.device==='B'?'#bf8330':'#386f65',w=Math.max(2,duration(e)*width/end);
   svg+='<g><title>'+esc(e.device+' '+e.kind+' · '+seconds(e.atMs)+' · '+seconds(duration(e))+(endings.get(e.frameId)?.aborted?' · interrupted':'')+(why?' · '+why:''))+'</title><rect x="'+x(e.atMs)+'" y="'+(lane(e.device)-11)+'" width="'+w+'" height="22" rx="3" fill="'+fill+'"/>'+(w>48?'<text x="'+(x(e.atMs)+4)+'" y="'+(lane(e.device)+4)+'" font-size="10" fill="white">'+esc(e.kind)+'</text>':'')+'</g>';
  }else if(e.event==='rx'&&(e.device==='A'||e.device==='B'))svg+='<circle cx="'+x(e.atMs)+'" cy="'+(lane(e.device)+20)+'" r="4" fill="#5273a0"><title>'+esc(e.device+' decoded '+e.kind+' at '+seconds(e.atMs))+'</title></circle>';
 }
 el('timeline').innerHTML=svg+'</svg>';
 el('assertions').innerHTML='<pre>'+esc(JSON.stringify({assertions:s.assertions,error:s.error,devices:s.devices},null,2))+'</pre>';
 el('events').innerHTML='<table><thead><tr><th>Time</th><th>Device</th><th>Event</th><th>Detail</th></tr></thead><tbody>'+events.map(e=>'<tr><td class="mono">'+seconds(e.atMs)+'</td><td>'+esc(e.device)+'</td><td>'+esc(e.event)+'</td><td>'+esc(e.kind||e.phase||'')+' '+esc(e.reason||e.status||'')+'</td></tr>').join('')+'</tbody></table>';
}
el('scenario-select').onchange=event=>show(Number(event.target.value));
el('show-linger').onchange=()=>show(Number(el('scenario-select').value));
el('scenarios').onclick=event=>{const button=event.target.closest('[data-scenario]');if(button){show(Number(button.dataset.scenario));el('detail').scrollIntoView({behavior:'smooth'});}};
show(0);
const acoustic=report.acoustic;
if(acoustic){
 const cases=acoustic.cases||acoustic.scenarios||[];
 el('acoustic').innerHTML=cases.length?'<div class="table-wrap"><table><thead><tr><th>Case</th><th>Result</th><th>Expected</th><th>Bytes exact</th><th>Audio duration</th></tr></thead><tbody>'+cases.map(c=>'<tr><td>'+esc(c.name)+'</td><td class="'+(c.passed?'pass':'fail')+'">'+(c.passed?'PASS':'FAIL')+'</td><td>'+esc(Array.isArray(c.expected)?c.expected.join(', ')||'No packets':c.expected??'')+'</td><td>'+esc(c.byteExact===true?'Yes':c.byteExact===false?'NO':'—')+'</td><td>'+seconds(c.audioDurationMs??c.durationMs)+'</td></tr>').join('')+'</tbody></table></div>':'<p>Acoustic report available in details.</p>';
 el('acoustic').innerHTML+='<details><summary>Acoustic results and parameters</summary><pre>'+esc(JSON.stringify(acoustic,null,2))+'</pre></details>';
}else el('acoustic').textContent='Run npm run test:acoustic to add measured waveform cases.';
const telephone=report.telephone;
if(telephone){
 el('telephone').innerHTML='<div class="table-wrap"><table><thead><tr><th>Transform</th><th>Outcome</th><th>Exact packets</th></tr></thead><tbody>'+(telephone.cases||[]).map(c=>'<tr><td>'+esc(c.name)+'</td><td class="'+(c.channelSuccess?'pass':'expected')+'">'+esc(c.status)+'</td><td>'+esc(c.status==='skipped'?'—':c.decodedPackets+'/'+c.expectedPackets)+'</td></tr>').join('')+'</tbody></table></div><details><summary>Codec settings, tool versions, and limits</summary><pre>'+esc(JSON.stringify(telephone,null,2))+'</pre></details>';
}else el('telephone').textContent='Run npm run test:telephone to add optional FFmpeg/SoX diagnostics.';
const profileReports=[['Initial comparison',report.profiles],['Expanded validation',report.profilesExtended]].filter(pair=>pair[1]);
el('profiles').innerHTML=profileReports.length?profileReports.map(([label,data])=>'<h3>'+esc(label)+'</h3><div class="table-wrap"><table><thead><tr><th>Playback rate</th><th>Tone range</th><th>Max frame</th><th>Channel</th><th>Exact packets</th></tr></thead><tbody>'+data.profiles.flatMap(p=>p.cases.map(c=>'<tr><td>'+number(p.playbackRate)+'</td><td>'+esc(p.toneMinHz.toFixed(0)+'–'+p.toneMaxHz.toFixed(0)+' Hz')+'</td><td>'+seconds(p.maxPacketAudioMs)+'</td><td>'+esc(c.channel)+'</td><td class="'+(c.decodedPackets===c.expectedPackets?'pass':'expected')+'">'+esc(c.decodedPackets+'/'+c.expectedPackets)+'</td></tr>')).join('')+'</tbody></table></div><details><summary>Profile measurements and limits</summary><pre>'+esc(JSON.stringify(data,null,2))+'</pre></details>').join(''):'Run npm run test:profiles to add the optional playback-rate comparison.';
const throughput=report.throughput;
if(throughput){
 const setup=throughput.setup||{},reuse=throughput.reuse||{};
 el('throughput').innerHTML='<div class="cards">'+card(seconds(setup.airtimeMs),'pairing and rekey airtime')+card(seconds(reuse.sharedSessionAirMs),'same messages, one session')+card(seconds(reuse.freshSessionsAirMs),'same messages, fresh sessions')+card(seconds(reuse.savedAirMs),'modeled airtime saved')+'</div><details><summary>Session measurements and bidirectional recovery</summary><pre>'+esc(JSON.stringify(throughput,null,2))+'</pre></details>';
 if(throughput.cryptoProfiles?.length)el('throughput').innerHTML+='<h3>Compact key exchange</h3><p class="subtle">Actual packet lengths and modeled waveform airtime across initial pairing plus mandatory rekey. Message encryption and 16-byte authentication tags remain unchanged.</p><div class="table-wrap"><table><thead><tr><th>Profile</th><th>Public key</th><th>Public record</th><th>Rekey record</th><th>Nearby setup</th><th>Telephone setup</th></tr></thead><tbody>'+throughput.cryptoProfiles.map(p=>'<tr><td>'+esc(p.id)+'</td><td>'+p.publicKeyBytes+' B</td><td>'+p.publicPacketBytes+' B</td><td>'+p.rekeyPacketBytes+' B</td><td>'+seconds(p.nearbySetupMs)+'</td><td>'+seconds(p.telephoneSetupMs)+'</td></tr>').join('')+'</tbody></table></div>';
}else el('throughput').textContent='Run npm run test:throughput to add session reuse measurements.';
el('model').textContent=JSON.stringify({model:sim.model,seed:sim.seed,summary:sim.summary},null,2);
el('generated').textContent='Generated '+report.generatedAt+'. Local report; no network requests.';
</script></body></html>`;
await fs.mkdir(directory,{recursive:true});
const destination=path.join(directory,'e2e-report.html');
await fs.writeFile(destination,html.replace('__REPORT_DATA__',()=>json));
console.log(destination);
