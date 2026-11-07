// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Live adaptation of JotTune Synth's instrument-view.mjs Scope/Spectrum/Peaks.
// Reuse its unchanged cursor FFT from media.mjs. This display owns no audio,
// permissions or recording; only a bounded PCM window and a six-second raster.
import {createCursorSpectrum} from './media.mjs';

const SIZE = 2048, SCOPE_SIZE = 512, STEP_MS = 100, HISTORY_COLUMNS = 60, HISTORY_ROWS = 64;
const VIEWS = ['tones','scope','spectrum','peaks'];
const LABELS = {tones:'Tones',scope:'Scope',spectrum:'Spectrum',peaks:'Peaks'};
const INK = '#a9c0cc', GRID = '#304650', PAPER = '#101a20';
const COLORS = {microphone:'#87d7b3',playback:'#eea896'};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const hzLabel = value => value >= 1000 ? `${(value / 1000).toFixed(value % 1000 ? 2 : 0)}k` : String(value);
const dbLabel = value => value > 0 ? `${Math.max(-120,20*Math.log10(value)).toFixed(1)} dBFS` : '−∞ dBFS';
const setText = (node, value) => {if (node.textContent !== value) node.textContent = value;};

/** readFrame() returns ephemeral {sampleRate, profile, playing, input, output}.
 * Input/output are independent Float32 PCM windows; consume, never retain them.
 * getState() exposes presentation metadata only. refresh() never opens audio.
 */
export function createAudioVisuals(container, {
  readFrame = () => null, getActive = () => false, getProfile = () => 'nearby', onChange = () => {},
} = {}) {
  const document = container.ownerDocument, window = document.defaultView;
  const make = (tag, id, text, className) => {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const inner = make('div', null, null, 'audio-visual-inner');
  const toolbar = make('div', null, null, 'audio-visual-toolbar');
  const compactLabel = make('span','audio-visual-compact','Audio idle','audio-visual-compact');
  const controls = make('div', null, null, 'audio-visual-views');
  controls.setAttribute('role','group');controls.setAttribute('aria-label','Audio view');
  const buttons = VIEWS.map(view => {
    const button = make('button',`audio-view-${view}`,LABELS[view]);
    button.type = 'button';button.dataset.view = view;
    button.setAttribute('aria-pressed',String(view === 'tones'));
    button.setAttribute('aria-controls','audio-visual-plot');
    if (view === 'tones') button.title = 'Tone history · frequency over recent time';
    controls.append(button);return button;
  });
  const collapse = make('button','audio-visual-collapse','▾');
  collapse.type = 'button';collapse.setAttribute('aria-controls','audio-visual-plot');
  const readings = make('div', null, null, 'audio-visual-readings');
  const status = make('span','audio-visual-status','Audio idle');
  status.setAttribute('role','status');
  const range = make('span','audio-visual-range','600–3750 Hz');
  readings.append(status,range);
  const plot = make('div','audio-visual-plot',null,'audio-visual-plot');
  const canvas = make('canvas','audio-visual-canvas');
  canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Live tone history; no audio is running');
  canvas.textContent = 'Live audio view. Numeric microphone levels are also available in Link diagnostics.';
  const unavailable = make('div','audio-visual-unavailable','Audio views are unavailable in this browser. Transfers still work.','audio-visual-unavailable');
  const peakPanel = make('div','audio-visual-peaks',null,'audio-visual-peaks');
  const peakNodes = ['microphone','playback'].map(source => {
    const row = make('div',null,null,'audio-visual-peak');
    const label = make('label',null,source === 'microphone' ? 'Microphone' : 'Playback');
    const meter = make('meter',`audio-peak-${source}`);meter.min=0;meter.max=1;meter.value=0;label.htmlFor=meter.id;
    const value = make('output',`audio-peak-${source}-value`,'−∞ dBFS');
    row.append(label,meter,value);peakPanel.append(row);return {meter,value};
  });
  plot.append(canvas,peakPanel,unavailable);toolbar.append(compactLabel,controls,collapse);inner.append(toolbar,readings,plot);
  container.replaceChildren(inner);container.classList.add('audio-visual-dock');
  document.body.classList.add('has-audio-visuals');

  const history = document.createElement('canvas');
  let context = null, historyContext = null;
  // Some privacy configurations throw instead of returning null. Canvas is
  // optional: failure must never escape into the app's transfer controller.
  try {
    context=canvas.getContext('2d');history.width=HISTORY_COLUMNS;history.height=HISTORY_ROWS;
    historyContext=history.getContext('2d');
  } catch {context=null;historyContext=null;}
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let view = 'tones', userCollapsed = false, keyboardCompact = false, active = false, source = null;
  let profile = 'nearby', motion = 'idle', destroyed = false, raf = null, lastTick = 0;
  let width = 0, height = 0, pixelRatio = 1, pcm = null, analyzer = null, sampleRate = 0, column = null;
  let historyAt = null, held = false, hasDrawn = false, fault = !context || !historyContext, lastMetadata = '';
  const band = () => profile === 'telephone' ? {min:450,max:2812.5} : {min:600,max:3750};
  const collapsed = () => userCollapsed || keyboardCompact;
  const getState = () => ({view,collapsed:collapsed(),active,source,motion,profile});
  const notify = () => {
    const metadata = JSON.stringify(getState());
    if (metadata === lastMetadata) return;
    lastMetadata = metadata;
    try {onChange(getState());} catch {}
  };
  function cancel() {if (raf !== null) window.cancelAnimationFrame(raf);raf = null;}
  function disableVisuals() {
    fault=true;cancel();context=null;historyContext=null;
    // Resetting dimensions also drops the backing stores without relying on
    // the failed drawing API. Never let cleanup throw or retry a failed canvas.
    try{canvas.width=0;canvas.height=0;}catch{}
    try{history.width=0;history.height=0;}catch{}
    release();source=null;motion='idle';updateLabels();
  }
  function paint(action) {
    if(fault || !context || !historyContext)return;
    try{action();}catch{disableVisuals();}
  }
  function wipeHistory() {
    if (column) column.data.fill(0);
    historyAt = null;
    paint(()=>historyContext.clearRect(0,0,HISTORY_COLUMNS,HISTORY_ROWS));
  }
  function release() {
    pcm?.fill(0);pcm = null;analyzer = null;sampleRate = 0;
    wipeHistory();column = null;held = false;hasDrawn = false;
    for (const item of peakNodes) {item.meter.value=0;item.meter.setAttribute('aria-valuetext','−∞ dBFS');setText(item.value,'−∞ dBFS');}
  }
  function axes() {
    if (!context) return;
    context.setTransform(pixelRatio,0,0,pixelRatio,0,0);
    context.fillStyle = PAPER;context.fillRect(0,0,width,height);
    context.strokeStyle = GRID;context.lineWidth = 1;
    context.beginPath();
    for (const fraction of [.25,.5,.75]) {context.moveTo(0,fraction*height);context.lineTo(width,fraction*height);}
    context.stroke();context.font='10px ui-monospace, monospace';context.fillStyle=INK;
  }
  function idlePlot(message = 'Start a transfer to see live sound') {
    paint(()=>{
      axes();context.textAlign='center';context.fillText(message,width/2,height/2+3);context.textAlign='left';
    });
  }
  function updateLabels() {
    const limits = band();
    container.dataset.view=view;container.dataset.collapsed=String(collapsed());container.dataset.active=String(active);
    canvas.dataset.view=view;canvas.dataset.profile=profile;canvas.dataset.source=source || 'none';canvas.dataset.motion=motion;
    canvas.dataset.minHz=String(limits.min);canvas.dataset.maxHz=String(limits.max);
    const sourceLabel = source === 'playback' ? 'Playback' : source === 'microphone' ? 'Microphone' : null;
    let label = fault ? 'Visuals unavailable · transfer continues' : !active ? 'Audio idle' : sourceLabel || 'Audio starting';
    if (motion === 'held') label += ' · held for reduced motion';
    setText(status,label);
    setText(compactLabel,fault ? 'Audio views unavailable' : !active ? 'Audio idle' : 'Audio active · views hidden');
    const frequencyRange = `${limits.min}–${limits.max} Hz`;
    setText(range,view === 'scope' ? '512-sample waveform' : view === 'peaks' ? 'Sample peaks · dBFS' : frequencyRange);
    canvas.setAttribute('aria-label',view === 'tones'
      ? `${label}. Tone history from ${limits.min} to ${limits.max} Hz, oldest at left, newest at right. Clears when the source changes.`
      : view === 'spectrum' ? `${label}. Spectrum from ${limits.min} to ${limits.max} Hz, −90 to 0 dBFS.`
      : `${label}. 512-sample waveform; display gain does not change audio.`);
    canvas.hidden=fault || view === 'peaks';peakPanel.hidden=fault || view !== 'peaks';unavailable.hidden=!fault;
    plot.hidden=collapsed();readings.hidden=collapsed();controls.hidden=collapsed();compactLabel.hidden=!collapsed();
    collapse.setAttribute('aria-expanded',String(!collapsed()));
    collapse.setAttribute('aria-label',collapsed()?'Expand audio views':'Collapse audio views');
    collapse.title=collapsed()?'Expand audio views':'Collapse audio views';setText(collapse,collapsed()?'▴':'▾');
    for (const button of buttons) button.setAttribute('aria-pressed',String(button.dataset.view===view));
    notify();
  }
  function resize() {
    if (destroyed) return;
    const rect=plot.getBoundingClientRect();
    const nextWidth=Math.max(1,Math.round(rect.width || inner.clientWidth || 280)),nextHeight=Math.max(1,Math.round(rect.height || 64));
    const nextRatio=Math.min(2,window.devicePixelRatio || 1);
    if (width!==nextWidth || height!==nextHeight || pixelRatio!==nextRatio) {
      width=nextWidth;height=nextHeight;pixelRatio=nextRatio;
      paint(()=>{canvas.width=Math.round(width*pixelRatio);canvas.height=Math.round(height*pixelRatio);});
      held=false;hasDrawn=false;idlePlot(active?'Waiting for live audio':'Start a transfer to see live sound');
    }
    document.documentElement.style.setProperty('--audio-visual-height',`${Math.ceil(container.getBoundingClientRect().height)}px`);
  }
  function layout() {
    if (destroyed) return;
    const focused=document.activeElement;
    const editing=Boolean(focused && (focused.matches('textarea,input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=range])') || focused.isContentEditable));
    const viewport=window.visualViewport;
    const keyboard=editing && (window.innerWidth <= 600 || (viewport && viewport.height < window.innerHeight-120));
    if (keyboardCompact!==keyboard) {keyboardCompact=keyboard;release();cancel();source=null;motion='idle';}
    const bottom=viewport && editing ? Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop) : 0;
    container.style.bottom=`${Math.round(bottom)}px`;
    updateLabels();resize();refresh();
  }
  function convert(samples, rate) {
    if (!pcm || sampleRate!==rate) {
      pcm?.fill(0);pcm=new Int16Array(SIZE);sampleRate=rate;
      analyzer=null;held=false;hasDrawn=false;wipeHistory();
    }
    for (let i=0;i<SIZE;i++) pcm[i]=Math.round(clamp(Number.isFinite(samples[i])?samples[i]:0,-1,32767/32768)*32768);
  }
  function spectrum() {
    analyzer ||= createCursorSpectrum({pcm,channels:1,sampleRate});
    return analyzer((SIZE/2)/sampleRate);
  }
  function drawScope() {
    axes();if (!context) return;
    const start=(SIZE-SCOPE_SIZE)/2,end=start+SCOPE_SIZE;
    let peak=0;for(let i=start;i<end;i++)peak=Math.max(peak,Math.abs(pcm[i])/32768);
    const gain=peak ? Math.min(16,Math.max(1,.75/peak)) : 1;
    context.strokeStyle=COLORS[source];context.lineWidth=1.5;context.beginPath();
    for(let i=start;i<end;i++) {
      const x=(i-start)/(SCOPE_SIZE-1)*width,y=height/2-pcm[i]/32768*gain*(height/2-15);
      if(i===start)context.moveTo(x,y);else context.lineTo(x,y);
    }
    context.stroke();context.fillStyle=INK;context.fillText(`${(SCOPE_SIZE/sampleRate*1000).toFixed(1)} ms · ×${gain.toFixed(gain===Math.floor(gain)?0:1)} display`,8,height-5);
  }
  function drawSpectrum(analysis) {
    axes();if (!context) return;
    const limits=band(),left=35,right=width-8,top=5,bottom=height-16;
    context.fillText('0',4,12);context.fillText('−90',4,bottom);
    context.strokeStyle=COLORS[source];context.lineWidth=1.5;context.beginPath();let first=true;
    for(let bin=Math.ceil(limits.min/analysis.binHz);bin<=Math.floor(limits.max/analysis.binHz);bin++) {
      const x=left+(bin*analysis.binHz-limits.min)/(limits.max-limits.min)*(right-left);
      const y=top+clamp(-analysis.dbfs[bin],0,90)/90*(bottom-top);
      if(first){context.moveTo(x,y);first=false;}else context.lineTo(x,y);
    }
    context.stroke();context.fillText(`${hzLabel(limits.min)} Hz`,left,height-3);
    context.textAlign='right';context.fillText(`${hzLabel(limits.max)} Hz`,right,height-3);context.textAlign='left';
  }
  function drawTones(analysis, now) {
    if (!context || !historyContext) return;
    const limits=band();
    const steps=historyAt===null?1:clamp(Math.floor((now-historyAt)/STEP_MS),0,HISTORY_COLUMNS);
    const nextTime=historyAt===null || steps===HISTORY_COLUMNS?now:historyAt+steps*STEP_MS;
    if(steps===HISTORY_COLUMNS)wipeHistory();
    if(steps>0){historyContext.drawImage(history,-steps,0);historyContext.clearRect(HISTORY_COLUMNS-steps,0,steps,HISTORY_ROWS);}
    column ||= historyContext.createImageData(1,HISTORY_ROWS);
    const color=source==='playback'?[238,168,150]:[135,215,179];
    for(let row=0;row<HISTORY_ROWS;row++) {
      const high=limits.max-row/HISTORY_ROWS*(limits.max-limits.min),low=limits.max-(row+1)/HISTORY_ROWS*(limits.max-limits.min);
      let db=-120;
      const first=Math.max(1,Math.floor(low/analysis.binHz)),last=Math.min(analysis.dbfs.length-1,Math.ceil(high/analysis.binHz));
      for(let bin=first;bin<=last;bin++)db=Math.max(db,analysis.dbfs[bin]);
      const light=clamp((db+90)/78,0,1),offset=row*4;
      column.data[offset]=Math.round(16+(color[0]-16)*light);
      column.data[offset+1]=Math.round(26+(color[1]-26)*light);
      column.data[offset+2]=Math.round(32+(color[2]-32)*light);column.data[offset+3]=255;
    }
    historyContext.putImageData(column,HISTORY_COLUMNS-1,0);historyAt=nextTime;
    axes();const left=45,top=4,plotHeight=height-20;
    context.imageSmoothingEnabled=false;context.drawImage(history,left,top,width-left-5,plotHeight);
    context.fillStyle=INK;context.fillText(hzLabel(limits.max),4,12);context.fillText(hzLabel(limits.min),4,top+plotHeight);
    context.fillText('−6 s',left,height-3);context.textAlign='right';context.fillText('now',width-5,height-3);context.textAlign='left';
  }
  function drawPeaks(frame) {
    for(const [index,samples] of [frame.input,frame.output].entries()) {
      let peak=0;for(const value of samples)if(Number.isFinite(value))peak=Math.max(peak,Math.abs(value));
      const label=dbLabel(peak);peakNodes[index].meter.value=clamp(peak,0,1);
      peakNodes[index].meter.setAttribute('aria-valuetext',label);setText(peakNodes[index].value,label);
    }
  }
  function draw(now) {
    const frame=readFrame();
    if (!frame || ![44100,48000].includes(frame.sampleRate) || !(frame.input instanceof Float32Array) || !(frame.output instanceof Float32Array)
        || frame.input.length!==SIZE || frame.output.length!==SIZE) {
      if (hasDrawn) {release();idlePlot('Waiting for live audio');}
      source=null;motion='idle';updateLabels();return;
    }
    const nextSource=frame.playing?'playback':'microphone';
    if (source!==nextSource) {source=nextSource;wipeHistory();held=false;}
    if(fault)return;
    if (view==='peaks') {drawPeaks(frame);motion='live';hasDrawn=true;}
    else if (!reducedMotion?.matches || !held) {
      convert(source==='playback'?frame.output:frame.input,frame.sampleRate);
      if(fault)return;
      if(view==='scope')drawScope();else {const analysis=spectrum();if(view==='spectrum')drawSpectrum(analysis);else drawTones(analysis,now);}
      held=Boolean(reducedMotion?.matches);hasDrawn=true;motion=held?'held':'live';
    }
    updateLabels();
  }
  function tick(now) {
    raf=null;
    if (destroyed || fault || document.hidden || collapsed() || !active) return;
    if(now-lastTick>=STEP_MS) {
      lastTick=now;
      try{draw(now);}catch{disableVisuals();return;}
    }
    if(!fault)raf=window.requestAnimationFrame(tick);
  }
  function refresh() {
    if (destroyed) return;
    const nextProfile=getProfile()==='telephone'?'telephone':'nearby';
    if (profile!==nextProfile) {profile=nextProfile;release();source=null;idlePlot();}
    active=!document.hidden && Boolean(getActive());
    if(!active || collapsed() || fault) {
      cancel();release();source=null;motion='idle';idlePlot();updateLabels();resize();return;
    }
    updateLabels();
    if(raf===null){lastTick=0;raf=window.requestAnimationFrame(tick);}
  }
  function clear() {
    cancel();release();active=false;source=null;motion='idle';idlePlot();updateLabels();
  }
  function choose(next) {
    if(!VIEWS.includes(next))return;
    view=next;release();source=null;motion='idle';lastTick=0;updateLabels();resize();refresh();
  }
  for(const button of buttons)button.addEventListener('click',()=>choose(button.dataset.view));
  controls.addEventListener('keydown',event=>{
    const index=buttons.indexOf(document.activeElement);if(index<0)return;
    const next=event.key==='ArrowRight'?(index+1)%buttons.length:event.key==='ArrowLeft'?(index+buttons.length-1)%buttons.length:event.key==='Home'?0:event.key==='End'?buttons.length-1:-1;
    if(next<0)return;event.preventDefault();choose(VIEWS[next]);buttons[next].focus();
  });
  collapse.addEventListener('click',()=>{
    const wasCollapsed=collapsed();
    // Safari does not always focus a tapped button. An explicit Expand should
    // dismiss the text keyboard instead of immediately compacting again.
    if(keyboardCompact)document.activeElement?.blur?.();
    userCollapsed=!wasCollapsed;keyboardCompact=false;release();cancel();source=null;motion='idle';layout();
  });
  const visibility=()=>{if(document.hidden)clear();else refresh();};
  const focus=()=>window.requestAnimationFrame(layout);
  const motionChanged=()=>{held=false;lastTick=0;refresh();};
  document.addEventListener('visibilitychange',visibility);
  document.addEventListener('focusin',focus);document.addEventListener('focusout',focus);
  window.addEventListener('resize',layout);window.addEventListener('pagehide',clear);
  window.visualViewport?.addEventListener('resize',layout);window.visualViewport?.addEventListener('scroll',layout);
  reducedMotion?.addEventListener?.('change',motionChanged);
  const observer=window.ResizeObserver?new window.ResizeObserver(resize):null;observer?.observe(inner);
  updateLabels();resize();refresh();
  return {refresh,clear,getState,destroy(){
    if(destroyed)return;clear();destroyed=true;observer?.disconnect();
    document.removeEventListener('visibilitychange',visibility);document.removeEventListener('focusin',focus);document.removeEventListener('focusout',focus);
    window.removeEventListener('resize',layout);window.removeEventListener('pagehide',clear);
    window.visualViewport?.removeEventListener('resize',layout);window.visualViewport?.removeEventListener('scroll',layout);
    reducedMotion?.removeEventListener?.('change',motionChanged);
    container.replaceChildren();container.classList.remove('audio-visual-dock');
    document.body.classList.remove('has-audio-visuals');document.documentElement.style.removeProperty('--audio-visual-height');
  }};
}
