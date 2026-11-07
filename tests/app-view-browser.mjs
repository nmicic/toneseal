// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Real UI/controllers/native crypto, with only the acoustic room and clipboard
// substituted. Mobile/keyboard checks emulate viewport geometry, not hardware.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const assets=option('--assets',path.join(root,'dist'));
const shots=option('--screenshots',path.join(root,'out/app-view-browser'));
const playwright=option('--playwright',process.env.PLAYWRIGHT_MODULE||path.join(root,'node_modules/playwright/index.mjs'));
const chrome=option('--chrome',process.env.CHROME_PATH);
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.wasm':'application/wasm','.json':'application/json'};
const csp="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const server=http.createServer(async(req,res)=>{
  try{
    let name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(name==='/chat-transfer-real.mjs')name='/chat-transfer.mjs';
    if(name==='/auto-transfer-real.mjs')name='/auto-transfer.mjs';
    const file=path.resolve(assets,'.'+(name.endsWith('/')?name+'index.html':name));
    if(!file.startsWith(assets+path.sep))throw Error('Path refused');
    const bytes=await fs.readFile(file);
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Security-Policy':csp,'Cache-Control':'no-store'});res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const stub=`export class AutoAudioLink {
 constructor(options={}){window.__calls.transports++;this.options=options;this.running=false;this.playing=false;this.generation=0;this.metrics={txFrames:0,txBytes:0,rxFrames:0,rxBytes:0};window.__air=this;}
 async start(){window.__calls.audioStarts++;this.generation++;this.running=true;this.options.onStatus?.('Synthetic room ready');}
 async send(packet){if(!this.running)throw Error('Stopped');const token=this.generation;this.playing=true;await new Promise(resolve=>setTimeout(resolve,15));if(token!==this.generation)throw new DOMException('Stopped','AbortError');await window.__airSend(Array.from(packet));this.playing=false;this.metrics.txFrames++;this.metrics.txBytes+=packet.length;this.options.onMetrics?.({...this.metrics});}
 stop(){window.__calls.audioStops++;this.generation++;this.running=false;this.playing=false;}
}`;
const autoWrapper=`export * from './auto-transfer-real.mjs';import {AutoTransfer as Native} from './auto-transfer-real.mjs';
export class AutoTransfer extends Native {
 constructor(options={}){super({...options,timing:{retryMs:180,retryJitterMs:20,turnaroundMs:12,initialDelayMs:5,maxRunMs:90000,lingerMs:5000,maxAttempts:25,...options.timing}});window.__calls.controllers++;window.__controller=this;}
 start(options){window.__calls.starts++;return super.start(options);}
 confirm(){window.__calls.confirms++;return super.confirm();}
 stop(){window.__calls.stops++;return super.stop();}
}`;
const chatWrapper=`import {ChatTransfer as Native} from './chat-transfer-real.mjs';export class ChatTransfer extends Native {
 constructor(options={}){super({...options,timing:{retryMs:180,retryJitterMs:20,turnaroundMs:12,initialDelayMs:5,turnTimeoutMs:400,idlePollMs:35,maxIdlePollMs:120,maxRunMs:90000,maxAttempts:25,closeTimeoutMs:6000,closeMaxAttempts:3,closeLingerMs:1800}});window.__controller=this;}
}`;
const errors=[],browsers=[],contexts=[],results=[];
const wait=(page,fn,arg)=>page.waitForFunction(fn,arg,{timeout:25000});
const ids=['auto-text','auto-password','auto-start','auto-stop','auto-end','auto-confirm','auto-fingerprint','auto-received-secret','auto-copy','verify-peer','audio-profile','chat-history','progress-panel','compose-panel','received-panel','chat-panel','audio-visuals'];

async function createContext(browser,options={}){
  const context=await browser.newContext(options);contexts.push(context);
  await context.route('**/auto-audio-link.mjs',route=>route.fulfill({contentType:'text/javascript',body:stub}));
  await context.route('**/auto-transfer.mjs',route=>route.fulfill({contentType:'text/javascript',body:autoWrapper}));
  await context.route('**/chat-transfer.mjs',route=>route.fulfill({contentType:'text/javascript',body:chatWrapper}));
  await context.addInitScript(()=>{
    window.__calls={media:0,audioContexts:0,transports:0,controllers:0,starts:0,stops:0,confirms:0,audioStarts:0,audioStops:0,clipboardWrites:0};
    window.__clipboard='';
    navigator.mediaDevices.getUserMedia=async()=>{window.__calls.media++;throw Error('Room is synthetic');};
    for(const name of ['AudioContext','webkitAudioContext'])if(window[name])window[name]=new Proxy(window[name],{construct(Target,args){window.__calls.audioContexts++;return Reflect.construct(Target,args);}});
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
      readText:()=>window.__holdClipboard?new Promise((resolve,reject)=>{window.__releaseClipboard=resolve;window.__denyClipboard=reject;}):Promise.resolve(window.__clipboard),
      writeText:async text=>{window.__calls.clipboardWrites++;window.__clipboard=text;},
    }});
  });
  return context;
}
async function open(context,label){
  const page=await context.newPage();page.on('pageerror',error=>errors.push(`${label}: ${error.message}`));
  page.on('dialog',dialog=>{errors.push(`${label}: unexpected dialog ${dialog.message()}`);void dialog.dismiss();});
  await page.goto(url);await wait(page,()=>document.body.dataset.experience==='app');
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.evaluate(()=>['Inter','Michroma'].every(name => [...document.fonts].some(face => face.family === name && face.status === 'loaded'))),true,`${label}: local display font loads under the app policy`);
  await page.evaluate(ids=>{window.__originalNodes=new Map(ids.map(id=>[id,document.getElementById(id)]));},ids);
  return page;
}
async function view(page,value){
  if(await page.evaluate(()=>document.body.dataset.experience)!==value)await page.locator('#experience-toggle').click();
  await wait(page,value=>document.body.dataset.experience===value,value);
}
async function stableNodes(page,label){
  assert.deepEqual(await page.evaluate(()=>[...window.__originalNodes].filter(([id,node])=>document.getElementById(id)!==node||document.querySelectorAll(`[id="${id}"]`).length!==1).map(([id])=>id)),[],`${label}: same controls, exactly one node per ID`);
}
async function calls(page){return page.evaluate(()=>({...window.__calls}));}
async function toggleRoundTrip(page,label){
  const before=await calls(page);const initial=await page.evaluate(()=>document.body.dataset.experience);
  await view(page,initial==='app'?'web':'app');await view(page,initial);
  assert.deepEqual(await calls(page),before,`${label}: layout does not start/stop audio, create a controller, confirm, or access clipboard`);
  await stableNodes(page,label);
}
async function revealOptions(page){
  // The settings control can move, but it must be discoverable and operable.
  const verification=page.locator('#verify-peer');
  if(!await verification.isVisible()){
    await page.locator('#app-options').click();
  }
  await verification.waitFor({state:'visible'});
}
async function screenshot(page,name){await page.screenshot({path:path.join(shots,`${name}.png`)});}
async function box(page,selector){return page.locator(selector).boundingBox();}
async function reachable(page,selector,label,{initial=false}={}){
  const item=page.locator(selector);assert.equal(await item.isVisible(),true,`${label}: ${selector} exists visibly`);
  if(!initial)await item.scrollIntoViewIfNeeded();
  const r=await item.boundingBox(), viewport=await page.evaluate(()=>({width:innerWidth,height:visualViewport?.height||innerHeight,top:visualViewport?.offsetTop||0}));
  assert.ok(r&&r.x>=-1&&r.x+r.width<=viewport.width+1,`${label}: ${selector} fits horizontally`);
  assert.ok(r.y>=viewport.top-1&&r.y+r.height<=viewport.top+viewport.height+1,`${label}: ${selector} fits visible viewport (${JSON.stringify({r,viewport})})`);
  const hit=await item.evaluate(node=>{const r=node.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return Boolean(hit&&(hit===node||node.contains(hit)));});
  assert.equal(hit,true,`${label}: ${selector} is not covered by another panel`);
}
// Unlike Playwright click/scrollIntoView or isVisible(), this assertion never
// scrolls and rejects clipping by *any* ancestor. A heading in a tiny conversation
// slot must not stand in for readable message text or a visible fingerprint.
async function painted(page,selector,label){
  const geometry=await page.locator(selector).evaluate(node=>{
    const rect=node.getBoundingClientRect();
    const viewport={left:visualViewport?.offsetLeft||0,top:visualViewport?.offsetTop||0,right:(visualViewport?.offsetLeft||0)+(visualViewport?.width||innerWidth),bottom:(visualViewport?.offsetTop||0)+(visualViewport?.height||innerHeight)};
    const clip={...viewport},ancestors=[];
    for(let parent=node.parentElement;parent;parent=parent.parentElement){
      const style=getComputedStyle(parent),r=parent.getBoundingClientRect();
      const x=/(auto|scroll|hidden|clip)/.test(style.overflowX),y=/(auto|scroll|hidden|clip)/.test(style.overflowY);
      if(x){clip.left=Math.max(clip.left,r.left+parent.clientLeft);clip.right=Math.min(clip.right,r.left+parent.clientLeft+parent.clientWidth);}
      if(y){clip.top=Math.max(clip.top,r.top+parent.clientTop);clip.bottom=Math.min(clip.bottom,r.top+parent.clientTop+parent.clientHeight);}
      if(x||y)ancestors.push({id:parent.id,top:r.top,bottom:r.bottom,scrollTop:parent.scrollTop,clientHeight:parent.clientHeight,scrollHeight:parent.scrollHeight});
    }
    // Inline text has one rectangle per wrapped fragment; its union includes
    // other inline siblings and empty line space that are not part of the text.
    const fragments=[...node.getClientRects()].filter(r=>r.width>0&&r.height>0);
    const points=fragments.flatMap(fragment=>[[.1,.1],[.9,.1],[.5,.5],[.1,.9],[.9,.9]].map(([x,y])=>{
      const target=document.elementFromPoint(fragment.left+fragment.width*x,fragment.top+fragment.height*y);
      return Boolean(target&&(target===node||node.contains(target)));
    }));
    return {rect:rect.toJSON(),clip,ancestors,points};
  });
  const {rect,clip,points}=geometry;
  const fits=rect.width>0&&rect.height>0&&rect.left>=clip.left-1&&rect.right<=clip.right+1&&rect.top>=clip.top-1&&rect.bottom<=clip.bottom+1;
  if(!fits||points.some(hit=>!hit))await screenshot(page,`failure-${label.replaceAll(/[^a-zA-Z0-9-]/g,'-')}`);
  assert.ok(fits&&points.every(Boolean),`${label}: ${selector} is fully painted without test scrolling ${JSON.stringify(geometry)}`);
  return rect;
}
async function verificationGeometry(page,label){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const before=await page.evaluate(()=>({page:scrollY,main:document.querySelector('body > main').scrollTop,status:document.getElementById('app-view-status').scrollTop}));
  const fingerprint=await painted(page,'#auto-fingerprint',`${label}/fingerprint`);
  const confirm=await painted(page,'#auto-confirm',`${label}/continue`);
  assert.ok(fingerprint.bottom<=confirm.top+1||fingerprint.right<=confirm.left+1||confirm.right<=fingerprint.left+1,`${label}: fingerprint and Continue do not overlap`);
  assert.equal(before.page,0,`${label}: verification is visible in the initial page viewport`);
  assert.equal(before.main,0,`${label}: verification does not depend on scrolling the App`);
  assert.equal(before.status,0,`${label}: verification does not depend on scrolling Status to its confirmation button`);
  assert.deepEqual(await page.evaluate(()=>({page:scrollY,main:document.querySelector('body > main').scrollTop,status:document.getElementById('app-view-status').scrollTop})),before,`${label}: geometry inspection did not scroll`);
}
async function composerActions(page,label,{connected=false}={}){
  const state=await page.evaluate(()=>window.tonesealAgent.getState());
  const stop=state.actions.find(action=>action.id==='stop'),end=state.actions.find(action=>action.id==='endChat');
  assert.equal(stop.selector,'#auto-stop',`${label}: observer binds App Stop to the composer`);assert.equal(stop.available,true);
  const stopBox=await painted(page,stop.selector,`${label}/stop`);
  if(connected){
    const send=await painted(page,'#auto-start',`${label}/send`);
    assert.ok(Math.abs(stopBox.top-send.top)<2,`${label}: Stop and Send share one action row`);
    assert.equal(end.selector,'#auto-end',`${label}: observer binds App End chat to the composer`);assert.equal(end.available,true);
    const endBox=await painted(page,end.selector,`${label}/end`);assert.ok(Math.abs(endBox.top-send.top)<2,`${label}: End and Send share one action row`);
  }
  assert.equal(await page.locator('#header-stop').isVisible(),false,`${label}: App does not duplicate actions in a second header row`);
  return state;
}
async function messageGeometry(page,label){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const last='#chat-history li:last-child';
  const text=await painted(page,`${last} p`,`${label}/message`);
  await painted(page,`${last} .chat-receipt`,`${label}/receipt`);
  const copy=await painted(page,`${last} button`,`${label}/copy`);
  assert.ok((copy.right<=text.left+1||copy.left>=text.right-1)&&Math.min(copy.bottom,text.bottom)>Math.max(copy.top,text.top),`${label}: Copy sits beside message text, without its own row`);
  const clear=await painted(page,'#chat-clear',`${label}/clear`),title=await box(page,'#chat-title');
  assert.ok(Math.min(clear.bottom,title.y+title.height)>Math.max(clear.top,title.y),`${label}: Clear is in the conversation header`);
  await composerActions(page,label,{connected:true});
}
async function checkLayout(page,label,{compact=false}={}){
  const metrics=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,header:document.querySelector('#site-header').getBoundingClientRect().toJSON(),tabs:[...document.querySelectorAll('#site-nav button')].map(node=>({id:node.id,...node.getBoundingClientRect().toJSON()}))}));
  assert.ok(metrics.scrollWidth<=metrics.width+1,`${label}: no page horizontal overflow`);
  assert.ok(Math.abs(metrics.header.top)<1,`${label}: header stays at viewport top`);
  assert.equal(metrics.tabs.length,4,`${label}: four primary tabs`);
  for(const tab of metrics.tabs){assert.ok(tab.width>=44&&tab.height>=44,`${label}: ${tab.id} touch target`);assert.ok(tab.x>=0&&tab.right<=metrics.width+1,`${label}: ${tab.id} fits`);}
  await reachable(page,'#experience-toggle',label,{initial:true});
  await reachable(page,'#auto-start',label,{initial:!compact});
  const composer=await box(page,'#compose-panel'),live=await box(page,'#audio-visuals');
  // A landscape composer may be taller than its scrolling main area. Assert
  // the painted portion and entire action remain above Live, not an unclipped
  // DOM bounding box that legitimately extends outside a scroll container.
  const main=await box(page,'body > main'),primary=await box(page,'#auto-start');
  const paintedBottom=compact?Math.min(composer.y+composer.height,main.y+main.height):composer.y+composer.height;
  if(paintedBottom>live.y+1)await screenshot(page,`failure-${label.replaceAll(/[^a-zA-Z0-9-]/g,'-')}`);
  assert.ok(paintedBottom<=live.y+1&&primary.y+primary.height<=live.y+1,`${label}: Live does not cover the composer action ${JSON.stringify({composer,main,primary,live})}`);
  if(!compact){
    await reachable(page,'#auto-text',label,{initial:true});
    const status=await box(page,'#app-view-status'),chat=await box(page,'#app-view-content');
    assert.ok(status.y+status.height<=chat.y+1&&chat.y+chat.height<=composer.y+1,`${label}: Status, conversation, composer, Live remain ordered`);
  }
  await stableNodes(page,label);
  return metrics;
}

async function passwordOptionsLayout(page,label,{compact=false}={}){
  if(!await page.locator('#transfer-options').evaluate(node=>node.open))await page.locator('#app-options').click();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const layout=await page.evaluate(()=>{
    const options=document.getElementById('transfer-options'),content=document.getElementById('app-view-content'),composer=document.getElementById('app-view-composer'),main=document.querySelector('body > main');
    const r=options.getBoundingClientRect(),c=content.getBoundingClientRect(),editor=composer.getBoundingClientRect();
    return {viewport:{width:innerWidth,height:innerHeight},options:{height:options.clientHeight,scrollHeight:options.scrollHeight,top:r.top,bottom:r.bottom,overflow:getComputedStyle(options).overflowY},content:{height:content.clientHeight,scrollHeight:content.scrollHeight,overflow:getComputedStyle(content).overflowY},main:{height:main.clientHeight,scrollHeight:main.scrollHeight,overflow:getComputedStyle(main).overflowY},gap:editor.top-c.bottom};
  });
  assert.equal(await page.locator('#app-options').getAttribute('aria-expanded'),'true',`${label}: Options exposes its selected state`);
  assert.ok(layout.gap>=-1&&layout.gap<=9,`${label}: Password content uses the space above its bottom composer ${JSON.stringify(layout)}`);
  if(!compact){
    assert.ok(layout.main.scrollHeight<=layout.main.height+1,`${label}: normal portrait/desktop keeps primary controls on screen`);
    const roomy=(layout.viewport.width===390&&layout.viewport.height===844)||(layout.viewport.width===1280&&layout.viewport.height===720)||(layout.viewport.width===1440&&layout.viewport.height===780);
    if(roomy)assert.ok(layout.options.scrollHeight<=layout.options.height+1,`${label}: Options must use available space instead of unnecessarily scrolling ${JSON.stringify(layout)}`);
    assert.ok(layout.options.scrollHeight<=layout.options.height+1||!/auto|scroll/.test(layout.options.overflow),`${label}: Password settings do not create a nested scroller`);
  }else{
    assert.ok(layout.main.scrollHeight>layout.main.height&&/(auto|scroll)/.test(layout.main.overflow),`${label}: short viewport uses the main scrolling region`);
    assert.ok(layout.options.scrollHeight<=layout.options.height+1||!/auto|scroll/.test(layout.options.overflow),`${label}: short viewport has no nested Options scroller ${JSON.stringify(layout)}`);
    assert.ok(layout.content.scrollHeight<=layout.content.height+1||!/auto|scroll/.test(layout.content.overflow),`${label}: short viewport has no nested content scroller`);
  }
  for(const selector of ['#auto-start','#app-options','#audio-profile']){
    const target=await box(page,selector);assert.ok(target.width>=44&&target.height>=44,`${label}: ${selector} retains a touch target`);
  }
  await reachable(page,'#audio-profile',`${label}/audio connection`);
  await reachable(page,'#auto-start',`${label}/primary action`);
  await page.locator('#app-options').click();
  assert.equal(await page.locator('#transfer-options').evaluate(node=>node.open),false);
}

async function layoutMatrix(chromium,webkit,devices){
  const cases=[
    {name:'desktop-1280x640',browser:chromium,options:{viewport:{width:1280,height:640}}},
    {name:'desktop-1280x720',browser:chromium,options:{viewport:{width:1280,height:720}}},
    {name:'desktop-1440x780',browser:chromium,options:{viewport:{width:1440,height:780}}},
    {name:'webkit-390',browser:webkit,options:{...devices['iPhone 13'],viewport:{width:390,height:844}}},
    {name:'webkit-320',browser:webkit,options:{...devices['iPhone SE'],viewport:{width:320,height:568}}},
    {name:'android-360',browser:chromium,options:{...devices['Galaxy S9+'],viewport:{width:360,height:740}}},
    {name:'webkit-landscape',browser:webkit,options:{...devices['iPhone 13 landscape'],viewport:{width:844,height:390}},compact:true},
    {name:'android-landscape',browser:chromium,options:{...devices['Pixel 7 landscape'],viewport:{width:740,height:360}},compact:true},
  ];
  for(const entry of cases){
    const context=await createContext(entry.browser,entry.options);await context.exposeBinding('__airSend',()=>{});
    const page=await open(context,entry.name);await checkLayout(page,entry.name,entry);await screenshot(page,entry.name);
    const messageStart=await box(page,'#auto-start');
    const actionGap=(await box(page,'#audio-visuals')).y-messageStart.y-messageStart.height;
    assert.equal(await page.locator('#received-panel').isVisible(),false,`${entry.name}: Message uses one conversation area`);
    assert.equal(await page.locator('#auto-text').inputValue(),'');assert.equal(await page.locator('#auto-start').textContent(),'Start receiving');
    await page.locator('#auto-text').fill('Keep this draft é across layout changes.');
    await toggleRoundTrip(page,entry.name);assert.equal(await page.locator('#auto-text').inputValue(),'Keep this draft é across layout changes.');
    await view(page,'web');
    const originalOrder=await page.locator('#transfer-panel').evaluate(node=>[...node.children].map(n=>n.id).filter(Boolean));
    for(const id of ['compose-panel','progress-panel','chat-panel','received-panel'])assert.ok(originalOrder.includes(id),`${entry.name}: Web restores ${id}`);
    assert.ok(originalOrder.indexOf('compose-panel')<originalOrder.indexOf('progress-panel')&&originalOrder.indexOf('progress-panel')<originalOrder.indexOf('chat-panel'),`${entry.name}: Web restores original section order`);
    await toggleRoundTrip(page,`${entry.name}/web`);assert.deepEqual(await page.locator('#transfer-panel').evaluate(node=>[...node.children].map(n=>n.id).filter(Boolean)),originalOrder);
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await view(page,'app');
    assert.equal(await page.evaluate(()=>Math.round(scrollY)),0,`${entry.name}: Web deep scroll does not offset App`);
    await page.locator('#mode-advanced').click();
    assert.equal(await page.evaluate(()=>document.body.dataset.experience),'web','Advanced retains document layout');
    assert.equal(await page.locator('#advanced-options').isVisible(),true);assert.equal(await page.locator('#transfer-panel').isVisible(),false);
    await page.locator('#mode-message').click();await wait(page,()=>document.body.dataset.experience==='app');
    assert.equal(await page.locator('#auto-text').inputValue(),'Keep this draft é across layout changes.');
    await page.locator('#auto-text').fill('x'.repeat(97));assert.equal(await page.locator('#auto-start').isDisabled(),true);
    assert.match(await page.locator('#composer-validation').textContent(),/Too long|96/);await reachable(page,'#composer-validation',`${entry.name}/overlimit`);
    await page.locator('#auto-text').fill('');
    for(const mode of ['password','clear','message']){
      await page.locator(`#mode-${mode}`).click();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#chat-panel').isVisible(),mode==='message',`${entry.name}: only Message offers chat`);
      if(mode==='password'){
        assert.equal(await page.locator('#status-details').evaluate(node=>node.open),true,'Password opens Ready details initially');
        assert.equal(await page.locator('#app-status-details').getAttribute('aria-expanded'),'true');
        if(!entry.compact){
          const start=await painted(page,'#auto-start',`${entry.name}/Password initial Start`);
          assert.ok(Math.abs((await box(page,'#audio-visuals')).y-start.bottom-actionGap)<1,'Password Start shares the Message bottom anchor above Live while Details and Options are open');
        }
        await screenshot(page,`${entry.name}-password-ready`);
        await passwordOptionsLayout(page,`${entry.name}/Password Options`,entry);
        await page.locator('#app-status-details').click();
        assert.equal(await page.locator('#status-details').evaluate(node=>node.open),false);
        await toggleRoundTrip(page,'Password manually closed details');
        assert.equal(await page.locator('#status-details').evaluate(node=>node.open),false,'View changes preserve a manually closed Details choice');
      }
      if(mode==='clear')assert.match(await page.locator('#mode-lifecycle').textContent(),/single|one|again|transfer/i);
      await reachable(page,'#auto-start',`${entry.name}/${mode}`,{initial:!entry.compact});
      if(!entry.compact){
        const start=await box(page,'#auto-start');
        assert.ok(Math.abs((await box(page,'#audio-visuals')).y-start.y-start.height-actionGap)<1,`${entry.name}: ${mode} keeps Start at the same bottom position above Live`);
      }
    }
    if(entry.name==='webkit-390'){
      await page.locator('#mode-password').click();
      await page.locator('#auto-password').fill('Keyboard preserves this draft');await page.locator('#auto-password').focus();
      await page.evaluate(()=>{
        window.__passwordViewportHeight=Object.getOwnPropertyDescriptor(visualViewport,'height');
        Object.defineProperty(visualViewport,'height',{configurable:true,value:400});visualViewport.dispatchEvent(new Event('resize'));
      });
      await wait(page,()=>document.body.dataset.appKeyboard==='true');
      await passwordOptionsLayout(page,`${entry.name}/Password visual viewport keyboard`,{compact:true});
      assert.equal(await page.locator('#auto-password').inputValue(),'Keyboard preserves this draft','Keyboard layout preserves the typed password');
      await page.evaluate(()=>{
        if(window.__passwordViewportHeight)Object.defineProperty(visualViewport,'height',window.__passwordViewportHeight);else delete visualViewport.height;
        visualViewport.dispatchEvent(new Event('resize'));
      });
      await page.locator('#mode-message').click();
    }
    if(entry.options.isMobile){
      const viewport=entry.options.viewport;await page.locator('#auto-text').fill('Keyboard keeps this draft');await page.locator('#auto-text').focus();
      // A real resized viewport covers browser resize/rotation; a smaller visual
      // viewport covers the separate geometry reported by an on-screen keyboard.
      await page.setViewportSize({width:viewport.width,height:Math.max(300,viewport.height-260)});
      await page.waitForTimeout(80);await reachable(page,'#auto-start',`${entry.name}/resized keyboard`);
      assert.equal(await page.locator('#auto-text').inputValue(),'Keyboard keeps this draft');
      await page.setViewportSize(viewport);await page.locator('#auto-text').focus();
      await page.evaluate(()=>{window.__vvHeight=Object.getOwnPropertyDescriptor(visualViewport,'height');Object.defineProperty(visualViewport,'height',{configurable:true,value:Math.max(300,innerHeight-260)});visualViewport.dispatchEvent(new Event('resize'));});
      await page.waitForTimeout(80);await reachable(page,'#auto-start',`${entry.name}/visual viewport keyboard`);
      assert.equal(await page.locator('#auto-text').inputValue(),'Keyboard keeps this draft');
      await page.evaluate(()=>{if(window.__vvHeight)Object.defineProperty(visualViewport,'height',window.__vvHeight);else delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});
      await page.locator('#auto-text').blur();
    }
    assert.equal((await calls(page)).starts,0);assert.equal((await calls(page)).media,0);assert.equal((await calls(page)).audioContexts,0);
    results.push({case:entry.name,viewport:entry.options.viewport,status:'passed'});console.log(`PASS ${entry.name}: operational layout, original Web restoration, drafts, Advanced and mobile/keyboard controls.`);
    await context.close();
  }
}

async function pair(chromium,webkit,{options=[{viewport:{width:1280,height:640}},{viewport:{width:390,height:844},hasTouch:true}],label='pair'}={}){
  const p={pages:[],records:[],blocked:false,dropNext:false,dropped:0};
  for(const [side,browser] of [chromium,webkit].entries()){
    const context=await createContext(browser,options[side]);
    await context.exposeBinding('__airSend',async(_,bytes)=>{
      p.records.push({side,bytes});if(p.blocked)return;
      if(p.dropNext&&bytes[2]===3&&new DataView(Uint8Array.from(bytes).buffer).getUint32(11,false)<0x80000000){p.dropNext=false;p.dropped++;return;}
      const peer=p.pages[1-side];if(!peer||peer.isClosed())return;
      await peer.evaluate(bytes=>{const air=window.__air;if(air?.running&&!air.playing){air.metrics.rxFrames++;air.metrics.rxBytes+=bytes.length;air.options.onMetrics?.({...air.metrics});void air.options.onPackets([Uint8Array.from(bytes)]);}},bytes);
    });
    p.pages.push(await open(context,`${label}-${side}`));
  }
  return p;
}
async function preserveSession(page,label){
  await page.evaluate(()=>{window.__sessionRefs={controller:window.__controller,session:window.__controller._session,current:window.__controller._session._current,generation:window.__controller._session._generation,transport:window.__air};});
  const fingerprint=await page.locator('#auto-fingerprint').textContent();const run=await page.evaluate(()=>window.tonesealAgent.getState().session.run);
  await toggleRoundTrip(page,label);
  assert.equal(await page.evaluate(()=>{const old=window.__sessionRefs,c=window.__controller;return old.controller===c&&old.session===c._session&&old.current===c._session._current&&old.generation===c._session._generation&&old.transport===window.__air;}),true,`${label}: established session and key objects survive`);
  assert.equal(await page.locator('#auto-fingerprint').textContent(),fingerprint);assert.equal(await page.evaluate(()=>window.tonesealAgent.getState().session.run),run);
}
async function send(page,text){await page.locator('#auto-text').fill(text);await page.locator('#auto-start').click();await wait(page,()=>document.querySelector('#auto-text').value==='');}
async function drain(p){for(const page of p.pages)await wait(page,()=>window.tonesealAgent.getState().queue.pending===0);}
async function stop(p){for(const page of p.pages){const action=await page.evaluate(()=>window.tonesealAgent.getState().actions.find(action=>action.id==='stop'));if(action.available)await page.locator(action.selector).click();}}

async function operationalGeometry(chromium,webkit,devices){
  const scenarios=[
    {name:'readable-desktop-1280x640',browser:chromium,options:{viewport:{width:1280,height:640}}},
    {name:'readable-iphone-390',browser:webkit,options:{...devices['iPhone 13'],viewport:{width:390,height:844}}},
    {name:'readable-iphone-320',browser:webkit,options:{...devices['iPhone SE'],viewport:{width:320,height:568}}},
    {name:'readable-android-360',browser:chromium,options:{...devices['Galaxy S9+'],viewport:{width:360,height:740}}},
  ];
  for(const entry of scenarios){
    const p=await pair(chromium,entry.browser,{options:[{viewport:{width:1280,height:640}},entry.options],label:entry.name}),[sender,receiver]=p.pages;
    for(const page of p.pages){await revealOptions(page);await page.locator('#verify-peer').check();}
    await sender.locator('#auto-text').fill('Visible first message é.');await receiver.locator('#auto-start').click();await sender.locator('#auto-start').click();
    for(const page of p.pages)await page.locator('#auto-confirm').waitFor({state:'visible'});
    await verificationGeometry(receiver,entry.name);await composerActions(receiver,`${entry.name}/verifying`);await screenshot(receiver,`${entry.name}-verification`);
    assert.equal((await calls(receiver)).confirms,0);assert.equal(await receiver.locator('#chat-history li').count(),0);
    await sender.locator('#auto-confirm').click();await receiver.locator('#auto-confirm').click();
    for(const page of p.pages)await wait(page,()=>window.tonesealAgent.getState().session.connected);
    await drain(p);assert.equal(await receiver.locator('#chat-history li:last-child p').textContent(),'Visible first message é.');
    await messageGeometry(receiver,entry.name);await screenshot(receiver,`${entry.name}-conversation`);
    // A second real transfer must remain readable as history grows. No test
    // scroll, focus change, view switch, or Latest click precedes this assertion.
    await send(sender,'The latest message is visible.');await drain(p);
    assert.equal(await receiver.locator('#chat-history li:last-child p').textContent(),'The latest message is visible.');await messageGeometry(receiver,`${entry.name}/latest`);
    const longer='A longer message wraps naturally: every word stays readable beside Copy on a small phone.';
    await send(sender,longer);await drain(p);assert.equal(await receiver.locator('#chat-history li:last-child p').textContent(),longer);
    await messageGeometry(receiver,`${entry.name}/wrapped`);await screenshot(receiver,`${entry.name}-wrapped-conversation`);
    const before=await calls(receiver);await receiver.locator('#chat-history li:last-child button').click();
    assert.equal(await receiver.evaluate(()=>window.__clipboard),longer);assert.equal((await calls(receiver)).clipboardWrites,before.clipboardWrites+1);
    await receiver.evaluate(()=>{const c=window.__controller;window.__detailSession={controller:c,session:c._session,current:c._session._current,generation:c._session._generation};});
    const beforeDetails=await calls(receiver);await receiver.locator('#app-status-details').click();
    assert.equal(await receiver.locator('#status-details').evaluate(node=>node.open),true);
    await send(sender,'Details stay open for incoming messages.');await drain(p);
    assert.equal(await receiver.locator('#status-details').evaluate(node=>node.open),true,'Incoming chat does not close Details the user is reading');
    assert.equal(await receiver.evaluate(()=>{const previous=window.__detailSession,c=window.__controller;return c===previous.controller&&c._session===previous.session&&c._session._current===previous.current&&c._session._generation===previous.generation;}),true,'Inspecting Details during delivery preserves the session and keys');
    assert.deepEqual(await calls(receiver),beforeDetails,'Details inspection neither restarts audio nor confirms or copies anything');
    await receiver.locator('#app-status-details').click();assert.equal(await receiver.locator('#status-details').evaluate(node=>node.open),false);
    if(await receiver.locator('#chat-latest').isVisible())await receiver.locator('#chat-latest').click();
    await send(sender,'Normal chat after closing Details.');await drain(p);await messageGeometry(receiver,`${entry.name}/after Details`);
    await receiver.locator('#mode-advanced').click();
    assert.equal(await receiver.evaluate(()=>document.body.dataset.experience),'web');
    const advanced=await receiver.evaluate(()=>window.tonesealAgent.getState());
    assert.equal(advanced.actions.find(action=>action.id==='stop').selector,'#header-abort');assert.equal(advanced.actions.find(action=>action.id==='stop').available,true);
    assert.equal(await receiver.locator('#header-stop').isVisible(),true);assert.equal(await receiver.locator('#advanced-options').isVisible(),true);
    await receiver.locator('#mode-message').click();await preserveSession(receiver,`${entry.name}/view switch`);
    await view(receiver,'web');const web=await receiver.evaluate(()=>window.tonesealAgent.getState());assert.equal(web.actions.find(action=>action.id==='stop').selector,'#header-abort');assert.equal(web.actions.find(action=>action.id==='stop').available,true);await view(receiver,'app');
    if(entry.name==='readable-desktop-1280x640'){
      await receiver.locator('#auto-end').click();
      for(const page of p.pages){await wait(page,()=>!window.tonesealAgent.getState().session.active);assert.equal(await page.evaluate(()=>window.tonesealAgent.getState().session.close?.outcome),'confirmed','Composer End chat confirms closure on both peers');}
    }else await stop(p);
    results.push({case:entry.name,viewport:entry.options.viewport,status:'passed'});
    console.log(`PASS ${entry.name}: whole fingerprint + Continue, actual message + receipt + adjacent Copy, header Clear, and composer Stop/End observed without test scrolling.`);
  }
}

async function liveChat(chromium,webkit){
  const p=await pair(chromium,webkit),[a,b]=p.pages;
  for(const page of p.pages){await revealOptions(page);await page.locator('#verify-peer').check();}
  await a.locator('#auto-text').fill('First exact message <é>');await b.locator('#auto-start').click();await a.locator('#auto-start').click();
  for(const page of p.pages)await page.locator('#auto-confirm').waitFor({state:'visible'});
  assert.equal(await a.locator('#auto-fingerprint').textContent(),await b.locator('#auto-fingerprint').textContent());
  for(const page of p.pages){await toggleRoundTrip(page,'verification gate');assert.equal((await calls(page)).confirms,0);await verificationGeometry(page,'verification gate');}
  assert.equal(await b.locator('#chat-history li').count(),0,'No payload before human confirmation');await screenshot(b,'verified-mobile-status');
  await a.locator('#auto-confirm').click();await b.waitForTimeout(100);assert.equal(await b.locator('#chat-history li').count(),0,'One confirmation does not bypass the peer');await b.locator('#auto-confirm').click();
  for(const page of p.pages)await wait(page,()=>window.tonesealAgent.getState().session.connected);
  for(const page of p.pages)assert.equal(await page.locator('#transfer-options').evaluate(node=>node.open),false,'Starting a transfer closes locked options so the conversation remains visible');
  await drain(p);assert.equal(await b.locator('#chat-history li.incoming p').textContent(),'First exact message <é>');
  await a.locator('#auto-text').fill('Unsent draft survives toggles');
  for(const page of p.pages)await preserveSession(page,'connected conversation');
  assert.equal(await a.locator('#auto-text').inputValue(),'Unsent draft survives toggles');
  assert.match(await a.locator('#chat-history li.outgoing .chat-receipt').textContent(),/^Delivered/);
  p.dropNext=true;await Promise.all([send(a,'A replies through a dropped frame'),send(b,'B replies at the same time é')]);await drain(p);
  assert.equal(p.dropped,1);assert.equal(await a.locator('#chat-history li.incoming p').textContent(),'B replies at the same time é');
  assert.deepEqual(await b.locator('#chat-history li.incoming p').allTextContents(),['First exact message <é>','A replies through a dropped frame']);
  for(const page of p.pages){await preserveSession(page,'repaired conversation');assert.equal(await page.locator('#chat-history li.outgoing .chat-receipt').evaluateAll(nodes=>nodes.every(n=>n.textContent.startsWith('Delivered'))),true);}
  assert.equal(p.records.some(r=>Buffer.from(r.bytes).includes(Buffer.from('First exact message'))),false);
  p.blocked=true;
  for(let i=0;i<8;i++)await send(a,`View queue ${i}`);
  await a.locator('#auto-text').fill('Keep my ninth queued draft');
  assert.equal(await a.locator('#auto-start').isDisabled(),true);assert.match(await a.locator('#composer-validation').textContent(),/Queue full/);
  await preserveSession(a,'full queue');await reachable(a,'#composer-validation','full queue feedback');
  assert.equal(await a.locator('#auto-text').inputValue(),'Keep my ninth queued draft');
  p.blocked=false;await drain(p);assert.equal(await b.locator('#chat-history li.incoming').count(),10,'All queued items arrive once after view changes');
  assert.equal(await a.locator('#auto-text').inputValue(),'Keep my ninth queued draft');assert.equal(await a.locator('#auto-start').isEnabled(),true);
  await b.evaluate(()=>{const content=document.getElementById('chat-history');content.scrollTop=content.scrollHeight;});
  await send(a,'Follow the next received message');await drain(p);
  assert.equal(await b.locator('#chat-history li.incoming').last().textContent().then(text=>text.includes('Follow the next received message')),true);
  const tail=await box(b,'#chat-history li:last-child'),conversation=await box(b,'#chat-history');
  assert.ok(tail.y+tail.height<=conversation.y+conversation.height+1,'Conversation follows a new message when already at the bottom');
  await b.evaluate(()=>{document.getElementById('chat-history').scrollTop=0;});
  await send(a,'Keep reading earlier messages');await drain(p);
  assert.ok(await b.locator('#chat-history').evaluate(node=>node.scrollTop<10),'Incoming message does not drag a reader away from older messages');
  assert.equal(await b.locator('#chat-latest').isVisible(),true,'A reader can explicitly return to the newest message');
  assert.equal(await b.evaluate(()=>window.tonesealAgent.getState().actions.find(action=>action.selector==='#chat-latest')?.available),true,'The observer exposes the visible Latest action');
  await b.locator('#chat-latest').click();await painted(b,'#chat-history li:last-child p','Latest action');
  await screenshot(a,'connected-desktop-chat');await screenshot(b,'connected-mobile-chat');
  await b.setViewportSize({width:320,height:568});await messageGeometry(b,'latest after normal phone resize');
  for(const viewport of [{width:320,height:568},{width:320,height:360},{width:390,height:430}]){
    await b.locator('#auto-text').focus();await b.setViewportSize(viewport);
    const stopAction=await b.evaluate(()=>window.tonesealAgent.getState().actions.find(action=>action.id==='stop'));
    assert.equal(stopAction.available,true);await reachable(b,stopAction.selector,`active mobile ${viewport.width}×${viewport.height}`);await reachable(b,'#auto-start',`active mobile ${viewport.width}×${viewport.height}`);
    if(viewport.height===568)await screenshot(b,'connected-mobile-320');
  }
  await b.setViewportSize({width:390,height:844});
  await stop(p);results.push({case:'verified-chat-and-view-toggles',status:'passed',droppedFrames:p.dropped});
  console.log('PASS native crypto verified chat: explicit two-peer confirmation, unchanged session/key objects, exact bidirectional messages, dropped DATA repair and retained delivery receipts across views.');
}

async function passwordAndClear(chromium,webkit){
  const p=await pair(chromium,webkit),[a,b]=p.pages;const secret='Dummy-view-secret-é_42!';
  for(const page of p.pages)await page.locator('#mode-password').click();
  // Exercise real keystrokes and touch activation with the password editor
  // still focused. The sender starts before its peer, so receiving/waiting UI
  // cannot conceal a lost draft or a wrongly selected controller role.
  const typed='Dummy_TYPED_password_42!';
  await b.locator('#auto-password').focus();await b.locator('#auto-password').pressSequentially(typed,{delay:15});
  assert.equal(await b.locator('#auto-password').inputValue(),typed);assert.equal(await b.locator('#auto-start').textContent(),'Start sending');
  assert.equal(await b.evaluate(()=>document.activeElement.id),'auto-password');
  await b.locator('#auto-start').tap();await wait(b,()=>window.__air.metrics.txFrames>0);
  assert.equal(await b.evaluate(()=>window.__controller.state.role),'sender');assert.match(await b.locator('#auto-phase').textContent(),/Sender/);
  assert.ok(p.records.some(record=>record.side===1&&record.bytes[2]===1),'Typed password schedules an offer before the receiver starts');
  assert.equal(await b.locator('#auto-password').inputValue(),'','The captured sending password is cleared from its editor');
  assert.equal(await b.locator('#received-panel').isVisible(),false,'A sending password has no empty WAITING inbox');
  await screenshot(b,'typed-password-sender');
  await a.locator('#auto-start').click();await wait(a,typed=>document.getElementById('auto-received-secret').value===typed,typed);
  await wait(b,()=>window.__controller.state.phase==='delivered'&&!window.__controller.state.active);
  assert.equal(await a.locator('#auto-received-secret').getAttribute('type'),'password');assert.equal((await calls(a)).clipboardWrites,0);
  for(const selector of ['#auto-received-secret','#auto-copy','#auto-clear'])await painted(a,selector,'typed password receipt');
  await a.locator('#auto-copy').click();assert.equal(await a.evaluate(()=>window.__clipboard),typed);assert.equal(await a.locator('#auto-received-secret').inputValue(),'');
  await stop(p);
  // Reset the finished roles through the normal mode controls before testing
  // clipboard capture in the opposite direction on these same two pages.
  for(const page of p.pages){await page.locator('#mode-message').click();await page.locator('#mode-password').click();}
  const startsBeforePaste=(await calls(a)).starts;
  await a.evaluate(()=>{window.__holdClipboard=true;});await a.locator('#auto-paste').click();await wait(a,()=>typeof window.__releaseClipboard==='function');
  await toggleRoundTrip(a,'pending password paste');assert.equal(await a.locator('#auto-start').isDisabled(),true);assert.equal((await calls(a)).starts,startsBeforePaste);
  await a.evaluate(secret=>{window.__holdClipboard=false;window.__releaseClipboard(secret);},secret);await wait(a,secret=>document.querySelector('#auto-password').value===secret,secret);
  await toggleRoundTrip(a,'password draft');assert.equal(await a.locator('#auto-password').inputValue(),secret);assert.equal(await a.locator('#auto-password').getAttribute('type'),'password');
  for(const page of p.pages){await revealOptions(page);await page.locator('#verify-peer').check();}
  await b.locator('#auto-start').click();await a.locator('#auto-start').click();
  for(const page of p.pages){await page.locator('#auto-confirm').waitFor({state:'visible'});await toggleRoundTrip(page,'password verification');await verificationGeometry(page,'password verification');}
  assert.equal(await b.locator('#auto-received-secret').inputValue(),'');
  await a.locator('#auto-confirm').click();await b.locator('#auto-confirm').click();
  await wait(b,secret=>document.querySelector('#auto-received-secret').value===secret,secret);await wait(a,()=>window.tonesealAgent.getState().session.phase==='delivered');
  await toggleRoundTrip(b,'received password');assert.equal(await b.locator('#auto-received-secret').inputValue(),secret);assert.equal(await b.locator('#auto-received-secret').getAttribute('type'),'password');
  assert.equal((await b.locator('body').innerText()).includes(secret),false);assert.equal((await calls(b)).clipboardWrites,0);assert.equal(await b.locator('#chat-panel').isVisible(),false);
  await reachable(b,'#auto-copy','password Copy');await screenshot(b,'received-mobile-password');await b.locator('#auto-copy').click();
  assert.equal(await b.evaluate(()=>window.__clipboard),secret);assert.equal((await calls(b)).clipboardWrites,1);assert.equal(await b.locator('#auto-received-secret').inputValue(),'');
  await stop(p);
  for(const page of p.pages){await page.locator('#mode-clear').click();assert.equal(await page.locator('#chat-panel').isVisible(),false);}
  const clear='One clear transfer é';await a.locator('#auto-text').fill(clear);await b.locator('#auto-start').click();await a.locator('#auto-start').click();
  await wait(b,clear=>document.querySelector('#auto-received-text').textContent===clear,clear);await wait(a,()=>window.tonesealAgent.getState().session.phase==='delivered');
  for(const page of p.pages){await toggleRoundTrip(page,'clear transfer receipt');assert.equal(await page.locator('#chat-panel').isVisible(),false);assert.equal(await page.evaluate(()=>window.tonesealAgent.getState().session.chat),false);}
  assert.equal(await b.locator('#auto-received-text').textContent(),clear);await stop(p);
  results.push({case:'password-and-clear-view-toggles',status:'passed'});console.log('PASS typed password sender-first role/audio offer, paste/draft/verified receipt across views, masked secret and explicit-only clipboard write; Clear remains one exact acknowledged transfer.');
}

try{
  const {chromium,webkit,devices}=await import(pathToFileURL(playwright));
  const desktop=await chromium.launch({executablePath:chrome,headless:true,args:['--mute-audio']});browsers.push(desktop);
  const safari=await webkit.launch({headless:true});browsers.push(safari);await fs.mkdir(shots,{recursive:true});await fs.rm(path.join(shots,'failure.json'),{force:true});
  if(!args.includes('--flow-only'))await layoutMatrix(desktop,safari,devices);
  if(!args.includes('--layout-only')){await operationalGeometry(desktop,safari,devices);await liveChat(desktop,safari);await passwordAndClear(desktop,safari);}
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(shots,'results.json'),JSON.stringify({status:'passed',tests:results,limits:'Synthetic acoustic transport; desktop/WebKit mobile viewport emulation is not physical iPhone/Android audio or keyboard acceptance.'},null,2)+'\n');
}catch(error){await fs.mkdir(shots,{recursive:true});await fs.writeFile(path.join(shots,'failure.json'),JSON.stringify({error:error.stack,errors,completed:results},null,2)+'\n');throw error;}
finally{for(const context of contexts)await context.close();for(const browser of browsers)await browser.close();await new Promise(resolve=>server.close(resolve));}
