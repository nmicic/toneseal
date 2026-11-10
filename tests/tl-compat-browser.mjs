// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
// Real dependency worker, archived renderers and packet receiver; no audio IO.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?path.resolve(args[args.indexOf(name)+1]):fallback;
const assets=option('--assets',path.join(root,'dist'));
const playwright=option('--playwright',process.env.PLAYWRIGHT_MODULE||path.join(root,'node_modules/playwright/index.mjs'));
const chrome=option('--chrome',process.env.CHROME_PATH);
const prefix='/compat-preview/';
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.woff2':'font/woff2'};
const csp="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const server=http.createServer(async(request,response)=>{
  try{
    const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    if(!pathname.startsWith(prefix))throw Error('Outside preview');
    const filename=path.resolve(assets,pathname.slice(prefix.length)||'index.html');
    if(!filename.startsWith(assets+path.sep))throw Error('Outside assets');
    const content=await fs.readFile(filename);
    response.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Content-Security-Policy':csp,'Cache-Control':'no-store'});response.end(content);
  }catch{response.writeHead(404);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browsers=[];
try{
  const {chromium,webkit,devices}=await import(pathToFileURL(playwright));
  const desktop=await chromium.launch({executablePath:chrome,headless:true}),safari=await webkit.launch({headless:true});browsers.push(desktop,safari);
  for(const entry of [
    {name:'desktop-chromium',browser:desktop,options:{viewport:{width:1280,height:720}}},
    {name:'iphone-webkit',browser:safari,options:devices['iPhone 13']},
    {name:'android-chromium',browser:desktop,options:devices['Pixel 7']},
  ]){
    const context=await entry.browser.newContext(entry.options),errors=[];
    try{
      await context.addInitScript(()=>{window.__microphones=0;navigator.mediaDevices.getUserMedia=async()=>{window.__microphones++;throw Error('No microphone in document checks');};});
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}${prefix}`);
      const result=await page.evaluate(async()=>{
        const {AutoAudioLink}=await import('./auto-audio-link.mjs');
        const {payloadTimeline}=await import('./communication-codec.mjs');
        const {getAudioProfile}=await import('./audio-profiles.mjs');
        const {StreamingDecoder}=await import('./auto-decoder.mjs');
        const {parseDocument,bodySha256,documentSha256}=await import('./tl-document.mjs');
        const {selectEngine}=await import('./policy.mjs');
        const registry=await(await fetch('./engines.json')).json(),engine=selectEngine(registry);
        const decoder=await WebAssembly.compile(await(await fetch('./communication-decoder.wasm')).arrayBuffer());
        const packet=Uint8Array.from({length:128},(_,i)=>(i*71+9)&255),decode=new TextDecoder();
        const header='# jottune-tl 1 1\n# {"title":"Packet example","made_by":"human","model":null}\n# end-jottune-tl\n';
        const changed=header.replace('Packet example','Different title'),rows=[];
        const need=(value,message)=>{if(!value)throw Error(message);};
        const pcmHash=async pcm=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pcm)),x=>x.toString(16).padStart(2,'0')).join('');
        for(const profile of ['nearby','telephone','ultrasonic']){
          const link=new AutoAudioLink({profile});
          const render=(recordText,selected=engine)=>link.renderJob({recordText,engine:selected,mode:'verify'},link.generation);
          try{
            const baseline=await render(payloadTimeline(packet,engine.identity,profile));
            need(baseline.verdict==='valid',baseline.stderr);
            const body=decode.decode(baseline.canonical),hash=await pcmHash(baseline.pcm);
            need(!parseDocument(body).header,'Generated packets keep their legacy musical body');
            for(const sourceHeader of [header,changed,header.replaceAll('\n','\r\n')]){
              const result=await render(sourceHeader+body);
              need(result.verdict==='valid'&&result.verified,result.stderr||'Portable canonical replay failed');
              const text=decode.decode(result.canonical),parsed=parseDocument(text);
              need(parsed.header===sourceHeader&&parsed.body===body,'Full export preserves header and canonical body');
              need(await pcmHash(result.pcm)===hash,'Metadata changed packet audio');
              need(result.recordSha256===await bodySha256(body),'Song identity must exclude metadata');
              need(result.documentSha256===await documentSha256(text),'Full-file checksum must include metadata');
              need(result.documentSha256!==baseline.documentSha256,'Adding metadata must change the document checksum');
            }
            const portable=await render(header+body),edited=await render(changed+body);
            need(portable.recordSha256===edited.recordSha256&&portable.documentSha256!==edited.documentSha256,'Metadata edits must preserve identity but change the document checksum');
            const {playbackRate}=getAudioProfile(profile),physical=new Float32Array(Math.ceil(portable.pcm.length/playbackRate)+14400);
            for(let i=0;i<Math.ceil(portable.pcm.length/playbackRate);i++){
              const position=i*playbackRate,index=Math.floor(position),mix=position-index;
              physical[i]=(portable.pcm[index]*(1-mix)+portable.pcm[Math.min(index+1,portable.pcm.length-1)]*mix)/32768;
            }
            const receiver=await StreamingDecoder.create(decoder,48000,profile),found=[];
            for(let i=0;i<physical.length;i+=2048)found.push(...receiver.push(physical.slice(i,i+2048)));
            need(found.length===1&&found[0].every((value,i)=>value===packet[i])&&found[0].length===packet.length,'Portable packet audio must recover byte-exactly once');
            if(profile==='nearby'){
              const invalid=[...['2 1','1 2','4294967296 1','1 4294967296','0 1','01 1'].map(version=>header.replace('1 1',version)+body),
                header+header+body,body+header,header.replace('# end-jottune-tl\n','')+body,
                header.replace('"title":"Packet example"','"unknown":"value"')+body,
                header.replace('"title":"Packet example"','"title":"A","title":"B"')+body,
                header.replace('null','{broken JSON}')+body,
                header.replace('Packet example','x'.repeat(61))+body,
                '\uFEFF'+header+body,header.replace('Packet example','\uD800')+body,
                '# jottune-tl 1 1\n# '+'x'.repeat(1021)+'\n# end-jottune-tl\n'+body];
              for(const text of invalid){const refused=await render(text);need(refused.verdict==='refused'&&!refused.pcm&&!refused.canonical?.length,'Malformed or unsupported document released audio');}
              const older=registry.engines.find(item=>item.release_id&&!item.withdrawn&&!item.withdrawn_at&&item.identity===engine.identity&&item.id!==engine.id);
              if(older){
                const compatible=await render(header+body,older);need(compatible.verdict==='valid'&&await pcmHash(compatible.pcm)===hash,'Legacy renderer audio changed');
                const refused=await render(header.replace('1 1','2 1')+body,older);need(refused.verdict==='refused'&&!refused.pcm,'Old native renderer cannot bypass the current host compatibility gate');
              }
              rows.push({negativeDocuments:invalid.length,legacyRenderer:older?.id||null});
            }
            rows.push({profile,packetBytes:packet.length,canonicalAudioMs:portable.pcm.length/48,airtimeMs:Math.ceil(portable.pcm.length/playbackRate)/48,exact:true});
          }finally{link.stop();}
        }
        return {rows,microphones:window.__microphones,overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.equal(result.microphones,0);assert.equal(result.overflow,false);assert.deepEqual(errors,[]);
      console.log('PASS '+entry.name+' '+JSON.stringify(result));
    }finally{await context.close();}
  }
}finally{for(const browser of browsers)await browser.close();await new Promise(resolve=>server.close(resolve));}
