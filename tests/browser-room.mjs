// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Local browser-operation bridge for two-browser integration tests.
// The HTTP bridge operates UI only. Peer messages cross the encrypted transport.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {randomBytes, createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {StreamingDecoder} from '../web/auto-decoder.mjs';
import {payloadTimeline} from '../web/communication-codec.mjs';
import {getAudioProfile} from '../web/audio-profiles.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const assets=path.resolve(option('--assets',path.join(root,'dist')));
const evidence=path.resolve(option('--report',path.join(root,'out/browser-room.json')));
const channel=option('--channel','pcm');
const initialView=option('--view','app');
assert.ok(['app','web'].includes(initialView),'--view must be app or web');
assert.ok(['pcm','frames'].includes(channel),'--channel must be pcm or frames');
const timingMode=option('--timing','interactive');
assert.ok(['production','interactive','fast'].includes(timingMode),'--timing must be production, interactive, or fast');
const timing=timingMode==='production'?{}:timingMode==='fast'
  ?{retryMs:180,retryJitterMs:20,turnaroundMs:12,initialDelayMs:5,turnTimeoutMs:400,idlePollMs:35,maxIdlePollMs:120,maxRunMs:45000,maxAttempts:20,closeTimeoutMs:6000,closeMaxAttempts:3,closeLingerMs:1800}
  :{retryMs:5000,retryJitterMs:100,turnaroundMs:80,initialDelayMs:10,turnTimeoutMs:15000,idlePollMs:500,maxIdlePollMs:5000,maxRunMs:600000,maxAttempts:60};
const noisePeak=Number(option('--noise','0.001'));
assert.ok(Number.isFinite(noisePeak)&&noisePeak>=0&&noisePeak<=0.1);
const playwright=path.resolve(option('--playwright',process.env.PLAYWRIGHT_MODULE||path.join(root,'node_modules/playwright/index.mjs')));
const chrome=option('--chrome',process.env.CHROME_PATH);
const ids=['alice','bob'],tokens=Object.fromEntries([...ids,'admin'].map(id=>[id,randomBytes(18).toString('hex')]));
const pages=[],contexts=[],browsers=[],knownTexts=new Set(),errors=[],snapshotSignatures=new Map();
const log={schemaVersion:1,createdAt:new Date().toISOString(),channel,timingMode,timingOverrides:timing,
  limitations:'Local test only. Browser UI and native crypto are real. Audio capture/playback is replaced. PCM mode uses the production synth and decoder with fixed-seed noise, resets the decoder per frame, and does not model real-time airtime, room echo, physical microphones, or telephone speech codecs. Frame mode bypasses synthesis and decoding.',
  noisePeak:channel==='pcm'?noisePeak:null,actions:[],frames:[],observations:[],errors};
let blocked=false,dropNextData=false,dropClose=null,closed=false,server,roomEpoch=1,writeQueue=Promise.resolve();
const hash=value=>createHash('sha256').update(value).digest('hex');
const redact=value=>[...knownTexts].sort((a,b)=>b.length-a.length).reduce((text,secret)=>text.split(secret).join('[message redacted]'),String(value));
const elapsed=()=>Date.now()-Date.parse(log.createdAt);
const persist=()=>{writeQueue=writeQueue.then(async()=>{await fs.mkdir(path.dirname(evidence),{recursive:true});await fs.writeFile(evidence,JSON.stringify(log,null,2)+'\n');});return writeQueue;};
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.wasm':'application/wasm','.json':'application/json','.md':'text/plain'};
let synth,receiver,runCLI,engine;
if(channel==='pcm'){
  const registry=JSON.parse(await fs.readFile(path.join(assets,'engines.json'),'utf8'));
  engine=registry.engines.find(item=>item.id===registry.default||item.release_id===registry.default);
  ({runCLI}=await import(pathToFileURL(path.join(assets,engine.runtime_module||'runtime.mjs'))));
  const synthBytes=await fs.readFile(path.join(assets,engine.browser_wasm)),receiverBytes=await fs.readFile(path.join(assets,'communication-decoder.wasm'));
  synth=await WebAssembly.compile(synthBytes);receiver=await WebAssembly.compile(receiverBytes);
  log.rendererSha256=hash(synthBytes);log.receiverSha256=hash(receiverBytes);
}
function capture(pcm,profile,seed){
  const playbackRate=getAudioProfile(profile).playbackRate,lead=4800,length=Math.ceil(pcm.length/playbackRate),samples=new Float32Array(lead+length+14400);
  for(let i=0;i<length;i++){
    const position=i*playbackRate,index=Math.floor(position),mix=position-index;
    samples[lead+i]=(pcm[index]*(1-mix)+pcm[Math.min(index+1,pcm.length-1)]*mix)/32768*.6;
  }
  let state=seed>>>0;
  for(let i=0;i<samples.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;samples[i]+=((state>>>0)/0x100000000*2-1)*noisePeak;}
  return samples;
}
async function transmit(side,bytes,profile,turn){
  const packet=Uint8Array.from(bytes),at=elapsed(),peer=pages[1-side],epoch=roomEpoch;
  const row={round:epoch,atMs:at,side:ids[side],bytes:packet.length,kind:packet[2],sha256:hash(packet),channel,delivered:false};
  // Test-only metadata associates an actually sealed packet with its public
  // turn options. Neither plaintext nor a production control API is exposed.
  if(turn)row.turn={number:turn.number,reply:Boolean(turn.reply),close:turn.close||'open'};
  row.containsKnownPlaintext=[...knownTexts].some(text=>Buffer.byteLength(text)>=8&&Buffer.from(packet).includes(Buffer.from(text)));
  log.frames.push(row);
  if(blocked){row.dropReason='blocked';return {metrics:{}};}
  if(dropNextData&&packet[2]===3&&packet.length>=15&&new DataView(packet.buffer).getUint32(11,false)<0x80000000){dropNextData=false;row.dropReason='injected DATA loss';return {metrics:{}};}
  if(dropClose&&turn?.close===dropClose.stage&&(!dropClose.side||dropClose.side===ids[side])){
    row.dropReason='injected close '+dropClose.stage+' loss';
    if(--dropClose.count===0)dropClose=null;
    return {metrics:{}};
  }
  if(!peer){row.dropReason='peer not open';return {metrics:{}};}
  let decoded=[packet],metrics={};
  if(channel==='pcm'){
    const rendered=await runCLI(synth,['--play','record.tl','--merged','canonical.tl'],{'record.tl':payloadTimeline(packet,engine.identity)});
    assert.equal(rendered.code,0,rendered.stderr);
    const decoder=await StreamingDecoder.create(receiver,48000,profile),samples=capture(rendered.pcm,profile,0x38473+log.frames.length);
    decoded=[];for(let offset=0;offset<samples.length;offset+=2048)decoded.push(...decoder.push(samples.slice(offset,offset+2048)));
    let energy=0,peak=0,clipped=0;
    for(const sample of samples){energy+=sample*sample;peak=Math.max(peak,Math.abs(sample));if(Math.abs(sample)>=.99)clipped++;}
    metrics={...decoder.metrics,inputRms:Math.sqrt(energy/samples.length),inputPeak:peak,inputClippedSamples:clipped};row.pcmSamples=rendered.pcm.length;row.waveformAirMs=Math.round(rendered.pcm.length/48/getAudioProfile(profile).playbackRate);
    row.decodedFrames=decoded.length;row.byteExact=decoded.length===1&&Buffer.from(decoded[0]).equals(Buffer.from(packet));
    assert.ok(row.byteExact,'Synthetic PCM must recover exactly the transmitted frame.');
  }
  row.processingMs=elapsed()-at;
  if(epoch!==roomEpoch){row.dropReason='previous room round';return {metrics:{}};}
  row.delivered=await peer.evaluate(({frames,metrics})=>{
    const air=window.__trialAir;if(!air?.running||air.playing)return false;
    air.metrics.rxFrames+=frames.length;air.metrics.rxBytes+=frames.reduce((sum,frame)=>sum+frame.length,0);
    for(const [key,value] of Object.entries(metrics))air.metrics[key]=['inputRms','inputPeak'].includes(key)?value:(air.metrics[key]||0)+value;
    air.options.onMetrics?.({...air.metrics});void air.options.onPackets(frames.map(frame=>Uint8Array.from(frame)));return true;
  },{frames:decoded.map(frame=>Array.from(frame)),metrics});
  if(!row.delivered)row.dropReason='peer stopped or half-duplex busy';
  return {metrics:{}};
}
const transport=`export class AutoAudioLink {
 constructor(options={}){this.options=options;this.running=false;this.playing=false;this.generation=0;this.metrics={txFrames:0,txBytes:0,rxFrames:0,rxBytes:0,playbackLevel:1};window.__trialAir=this;}
 async start(){this.generation++;this.running=true;this.options.onStatus?.('Synthetic ${channel==='pcm'?'PCM sound':'encrypted frame'} channel ready');}
 async send(packet){if(!this.running)throw Error('Stopped');const token=this.generation;this.playing=true;try{const key=Array.from(packet,value=>value.toString(16).padStart(2,'0')).join('');await window.__trialTransmit(Array.from(packet),this.options.profile||'nearby',window.__trialTurns?.get(key)||null);if(token!==this.generation)throw new DOMException('Stopped','AbortError');this.metrics.txFrames++;this.metrics.txBytes+=packet.length;this.options.onMetrics?.({...this.metrics});}finally{this.playing=false;}}
 stop(){this.generation++;this.running=false;this.playing=false;this.metrics.inputRms=0;this.metrics.inputPeak=0;}
}`;
const wrapper=`import {ChatTransfer as Real} from './chat-transfer-real.mjs';
export class ChatTransfer extends Real {
 constructor(options={}){super({...options,timing:${JSON.stringify(timing)}});window.__trialTurns=new Map();}
 _createSession(profile){const session=super._createSession(profile),turn=session.turn.bind(session);session.turn=async options=>{const packet=await turn(options),key=Array.from(packet,value=>value.toString(16).padStart(2,'0')).join('');window.__trialTurns.set(key,{number:options.number,reply:options.reply,close:options.close||'open'});while(window.__trialTurns.size>128)window.__trialTurns.delete(window.__trialTurns.keys().next().value);return packet;};return session;}
}`;
async function snapshot(side){
  const page=pages[side];
  const captured=await page.evaluate(()=>{
    const visible=node=>{
      if(!node?.getClientRects().length||getComputedStyle(node).visibility==='hidden')return false;
      for(let parent=node.parentElement;parent;parent=parent.parentElement){
        if(parent.tagName==='DETAILS'&&!parent.open){const summary=parent.querySelector(':scope > summary');if(!summary?.contains(node))return false;}
      }
      return true;
    };
    const selector=node=>{
      const parts=[];
      for(let current=node;current?.nodeType===1;current=current.parentElement){
        if(current.id&&document.querySelectorAll('#'+CSS.escape(current.id)).length===1){parts.unshift('#'+CSS.escape(current.id));break;}
        if(current.dataset.messageId){parts.unshift('[data-message-id="'+CSS.escape(current.dataset.messageId)+'"]');break;}
        const tag=current.tagName.toLowerCase(),peers=current.parentElement?[...current.parentElement.children].filter(peer=>peer.tagName===current.tagName):[current];
        parts.unshift(tag+':nth-of-type('+(peers.indexOf(current)+1)+')');
      }
      return parts.join(' > ');
    };
    const controls=[...document.querySelectorAll('button,input,textarea,select,a,summary')].filter(visible).map(node=>({
      selector:selector(node),tag:node.tagName.toLowerCase(),role:node.getAttribute('role')||({BUTTON:'button',TEXTAREA:'textbox',SELECT:'combobox',A:'link',SUMMARY:'button'}[node.tagName]||node.type),
      name:node.getAttribute('aria-label')||[...(node.labels||[])].map(label=>label.innerText).join(' ').trim()||node.innerText.trim(),
      disabled:node.disabled===true||node.getAttribute('aria-disabled')==='true',checked:['checkbox','radio'].includes(node.type)?node.checked:undefined,
      value:node.type==='password'?'[redacted]':('value' in node?node.value:undefined),
      href:node.tagName==='A'?node.getAttribute('href'):undefined,
      options:node.tagName==='SELECT'?[...node.options].map(option=>({value:option.value,label:option.text,disabled:option.disabled})):undefined
    }));
    const helpLinks=[...document.querySelectorAll('link[rel~=help]')].map(node=>({url:node.href,type:node.type,title:node.title}));
    const publicAgentState=typeof window.tonesealAgent?.getState==='function'?window.tonesealAgent.getState():null;
    const inspector=document.getElementById('agent-state');
    const messages=[...document.querySelectorAll('#chat-history li')].map(node=>({
      id:node.dataset.messageId||null,direction:node.dataset.direction||(node.classList.contains('incoming')?'incoming':'outgoing'),
      counter:node.dataset.counter||null,delivery:node.dataset.delivery||null,
      text:node.querySelector('p')?.textContent||'',receipt:node.querySelector('.chat-receipt')?.textContent||''
    }));
    return {view:{url:location.href,title:document.title,text:document.body.innerText,controls,helpLinks,publicAgentState,
      visibleStateJson:visible(inspector)?inspector.textContent:null},
      observation:{phase:document.querySelector('#auto-phase')?.textContent||null,
        status:document.querySelector('#auto-status')?.textContent||null,
        active:publicAgentState?.session.active??null,connected:publicAgentState?.session.connected??null,
        close:publicAgentState?.session.close||null,messages}};
  });
  // Capture only changed evidence from each inspected page. Hash message text
  // before persistence so later clearing, changing modes, or restarting cannot
  // erase delivery evidence or turn this report into a plaintext transcript.
  const observation={...captured.observation,messages:captured.observation.messages.map(({text,...message})=>({...message,bytes:Buffer.byteLength(text),sha256:hash(text)}))};
  const signature=JSON.stringify(observation);
  if(snapshotSignatures.get(side)!==signature){
    snapshotSignatures.set(side,signature);
    log.observations.push({kind:'page-change',round:roomEpoch,atMs:elapsed(),side:ids[side],...observation});
    await persist();
  }
  return captured.view;
}
async function act(side,body){
  const page=pages[side],allowed=['click','fill','select','check'];
  if(body.action==='read-help'){
    const links=(await snapshot(side)).helpLinks.filter(link=>link.type==='application/json'&&new URL(link.url).origin===new URL(page.url()).origin&&new URL(link.url).pathname.endsWith('/automation-guide.json'));
    const link=body.url?links.find(link=>link.url===body.url):links.length===1?links[0]:null;
    if(!link)throw Error('Only the page-linked, same-origin automation-guide.json can be read.');
    const response=await page.request.get(link.url);
    if(!response.ok())throw Error('Linked guide could not be loaded: '+response.status());
    log.actions.push({round:roomEpoch,atMs:elapsed(),side:ids[side],action:'read-help',url:link.url,ok:true});await persist();
    return {url:link.url,guide:await response.json()};
  }
  if(!allowed.includes(body.action))throw Error('Use click, fill, select, check, or read-help; GET returns the page.');
  if(!body.selector&&!body.role)throw Error('Choose a discovered selector or role + name.');
  let target=body.selector?page.locator(body.selector):page.getByRole(body.role,{name:body.name,exact:true});
  if(!body.selector&&await target.count()===0){
    // WebKit/Chromium do not consistently expose <summary> as role=button.
    // Fall back only to one matching discovered DOM control, never an arbitrary
    // first match; its selector retains the real element type and location.
    const normalize=text=>String(text||'').replace(/\s+/g,' ').trim();
    const matching=(await snapshot(side)).controls.filter(control=>control.role===body.role&&normalize(control.name)===normalize(body.name));
    if(matching.length===1)target=page.locator(matching[0].selector);
  }
  if(await target.count()!==1)throw Error('Action must identify exactly one visible control.');
  if(!await target.isVisible()||!await target.evaluate(node=>{
    for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open&&!parent.querySelector(':scope > summary')?.contains(node))return false;
    return true;
  }))throw Error('Control is not visible.');
  if(!await target.isEnabled()||await target.getAttribute('aria-disabled')==='true')throw Error('Control is disabled.');
  const record={round:roomEpoch,atMs:elapsed(),side:ids[side],action:body.action,selector:body.selector,role:body.role,name:body.name};
  if(typeof body.value==='string'){record.valueBytes=Buffer.byteLength(body.value);record.valueSha256=hash(body.value);if(body.action==='fill'&&body.value)knownTexts.add(body.value);}
  log.actions.push(record);
  try{
    if(body.action==='click')await target.click({timeout:3000});
    if(body.action==='fill')await target.fill(String(body.value),{timeout:3000});
    if(body.action==='select')await target.selectOption(String(body.value),{timeout:3000});
    if(body.action==='check')await target.setChecked(Boolean(body.value),{timeout:3000});
    record.ok=true;
  }catch(error){record.ok=false;record.error=redact(error.message);throw Error(record.error);}
  await persist();return snapshot(side);
}
async function report(){
  const endpoints=[];
  for(const [side,page] of pages.entries()){
    const result=await page.evaluate(()=>({
      phase:document.querySelector('#auto-phase')?.textContent,status:document.querySelector('#auto-status')?.textContent,
      messages:[...document.querySelectorAll('#chat-history li')].map(node=>({direction:node.classList.contains('incoming')?'incoming':'outgoing',text:node.querySelector('p')?.textContent||'',receipt:node.querySelector('.chat-receipt')?.textContent||''})),
      telemetry:Object.fromEntries([...document.querySelectorAll('[id^="metric-"]')].map(node=>[node.id,node.textContent]))
    }));
    endpoints.push({side:ids[side],...result,messages:result.messages.map(({text,...message})=>({...message,bytes:Buffer.byteLength(text),sha256:hash(text)}))});
  }
  log.observations.push({round:roomEpoch,atMs:elapsed(),endpoints});
  await persist();
  const frames=log.frames.filter(row=>row.round===roomEpoch);
  return {round:roomEpoch,channel,timingMode,limitations:log.limitations,blocked,dropNextData,dropClose,frames:frames.length,deliveredFrames:frames.filter(row=>row.delivered).length,droppedFrames:frames.filter(row=>row.dropReason).length,closeFrames:frames.filter(row=>row.turn?.close&&row.turn.close!=='open').map(row=>({side:row.side,turn:row.turn,delivered:row.delivered,dropReason:row.dropReason,sha256:row.sha256})),pcmByteExactFrames:frames.filter(row=>row.byteExact).length,plaintextLeaks:frames.filter(row=>row.containsKnownPlaintext).length,endpoints,errors};
}
async function readBody(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw Error('Request too large');}return body?JSON.parse(body):{};}
async function handle(req,res){
  const url=new URL(req.url,'http://localhost');
  const answer=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value,null,2));};
  const parts=url.pathname.split('/').filter(Boolean),id=parts[0];
  if([...ids,'admin'].includes(id)){
    if(parts[1]!==tokens[id]||parts.length!==2)return answer(404,{error:'Not found'});
    if(req.headers.origin)return answer(403,{error:'Browser origins cannot operate this local test bridge.'});
    try{
      if(id==='admin'){
        if(req.method==='POST'){
          const body=await readBody(req);
          if(body.action==='block')blocked=Boolean(body.value);
          else if(body.action==='drop-next-data')dropNextData=true;
          else if(body.action==='drop-next-close'){
            const count=body.count??1;
            if(!['drain','commit','ack','final'].includes(body.stage)||!Number.isInteger(count)||count<1||count>8||(body.side&&!ids.includes(body.side)))throw Error('Choose a close stage, count 1–8, and optional alice/bob side.');
            dropClose={stage:body.stage,count,side:body.side||null};
          }
          else if(body.action==='reset'){
            await report();roomEpoch++;blocked=false;dropNextData=false;dropClose=null;knownTexts.clear();snapshotSignatures.clear();
            for(const page of pages){const stop=page.locator('#auto-stop');if(await stop.isVisible())await stop.click();}
            for(const page of pages)await page.goto(origin+'/?view='+initialView);
          }
          else if(body.action==='capture'){
            const side=ids.indexOf(body.side),width=Number(body.width),height=Number(body.height||844);
            if(side<0||!Number.isInteger(width)||width<320||width>1600||!Number.isInteger(height)||height<480||height>1200)throw Error('Capture needs a valid side and viewport size.');
            const page=pages[side];await page.setViewportSize({width,height});
            await page.evaluate(()=>{
              const title=document.querySelector('#agent-title'),header=document.querySelector('#site-header');
              if(title)window.scrollTo(0,title.getBoundingClientRect().top+scrollY-(header?.getBoundingClientRect().height||0)-12);
            });
            const file=path.join(root,'out',`automation-observer-${body.side}-${width}.png`);await fs.mkdir(path.dirname(file),{recursive:true});
            await page.screenshot({path:file});
            const layout=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,headerTop:document.querySelector('#site-header')?.getBoundingClientRect().top,inspectorOverflow:document.querySelector('#agent-state')?.scrollWidth>document.querySelector('#agent-state')?.clientWidth,
              headerActions:[...document.querySelectorAll('#header-stop,#header-abort')].filter(node=>node.getClientRects().length).map(node=>{const rect=node.getBoundingClientRect();return{id:node.id,x:rect.x,right:rect.right,width:rect.width,height:rect.height};})}));
            return answer(200,{file,layout});
          }
          else if(body.action==='stop'){answer(200,await report());setTimeout(()=>shutdown(),10);return;}
          else throw Error('Admin actions: block {value}, drop-next-data, drop-next-close {stage,count?,side?}, reset (reload current assets), capture {side,width,height}, stop.');
        }
        return answer(200,await report());
      }
      const side=ids.indexOf(id);
      return answer(200,req.method==='GET'?await snapshot(side):req.method==='POST'?await act(side,await readBody(req)):{error:'Use GET or POST'});
    }catch(error){return answer(400,{error:error.message});}
  }
  try{
    let name=url.pathname;if(name==='/chat-transfer-real.mjs')name='/chat-transfer.mjs';
    const file=path.resolve(assets,'.'+(name.endsWith('/')?name+'index.html':name));
    if(!file.startsWith(assets+path.sep))throw Error('Invalid path');
    const bytes=await fs.readFile(file);
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
  }catch{res.writeHead(404);res.end('Not found');}
}
async function shutdown(){
  if(closed)return;closed=true;
  try{await report();}catch{}
  for(const context of contexts)await context.close();for(const browser of browsers)await browser.close();
  await persist();server?.close();process.exitCode=errors.length?1:0;
}
server=http.createServer((req,res)=>void handle(req,res).catch(error=>{errors.push(error.message);res.writeHead(500);res.end('Harness error');}));
await new Promise(resolve=>server.listen(Number(option('--port','0')),'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const {chromium,webkit}=await import(pathToFileURL(playwright));
try{
  browsers.push(await chromium.launch({executablePath:chrome,headless:true,args:['--mute-audio']}));
  browsers.push(await webkit.launch({headless:true}));
  for(const [side,browser] of browsers.entries()){
    const context=await browser.newContext({viewport:side?{width:390,height:844}:{width:1280,height:900}});contexts.push(context);
    await context.route('**/auto-audio-link.mjs',route=>route.fulfill({contentType:'text/javascript',body:transport}));
    await context.route('**/chat-transfer.mjs',route=>route.fulfill({contentType:'text/javascript',body:wrapper}));
    await context.addInitScript(()=>{
      navigator.mediaDevices.getUserMedia=async()=>{throw Error('Synthetic channel: no real microphone should open.');};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}});
    });
    await context.exposeBinding('__trialTransmit',(_,bytes,profile,turn)=>transmit(side,bytes,profile,turn));
    const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/?view='+initialView);
  }
  await persist();
  console.log(JSON.stringify({channel,alice:`${origin}/alice/${tokens.alice}`,bob:`${origin}/bob/${tokens.bob}`,admin:`${origin}/admin/${tokens.admin}`,report:evidence,instructions:'GET your URL to inspect your page and controls. POST the same URL with JSON {action:click|fill|select|check,selector:#discovered-id,value:...}, or {action:click,role:button,name:exact accessible name}. Only operate your own URL. No direct protocol, page JS, peer state, or message APIs are provided.'},null,2));
  process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
}catch(error){errors.push(error.message);await shutdown();throw error;}
