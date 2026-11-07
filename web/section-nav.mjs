// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Section navigation is local presentation only. A Continue shortcut reveals
// the verification panel; it never confirms a fingerprint or opens audio.
export function createSectionNavigation({nav, toggle, close, header, onChange = () => {}}) {
  const document = nav.ownerDocument, window = document.defaultView;
  const container = nav.querySelector('#section-links');
  const compactQuery = window.matchMedia('(max-width: 1179px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const label = document.createElement('span');label.className='section-toggle-label';
  const chevron = document.createElement('span');chevron.textContent='▾';chevron.setAttribute('aria-hidden','true');
  toggle.replaceChildren(label,chevron);toggle.setAttribute('aria-controls',nav.id);
  const records = new Map();
  let entries = [], open = false, activeTarget = null, requested = null;
  let queued = null, jumpTimer = null, destroyed = false, previousState = '';
  document.body.classList.add('has-section-navigation');
  const getState = () => ({activeTarget,open,compact:compactQuery.matches});
  function notify() {
    const value=JSON.stringify(getState());
    if(value===previousState)return;
    previousState=value;try{onChange(getState());}catch{}
  }
  function visible(target) {
    if(!target || target.closest('[hidden]'))return false;
    // A section inside a closed disclosure is still a valid destination:
    // clicking its shortcut opens the disclosure before scrolling.
    for(let node=target;node && node!==document.body;node=node.parentElement) {
      if(window.getComputedStyle(node).display==='none')return false;
    }
    return true;
  }
  function setCurrent(target) {
    activeTarget=target;
    for(const entry of entries) {
      if(entry.target===target)entry.link.setAttribute('aria-current','location');
      else entry.link.removeAttribute('aria-current');
    }
    const current=entries.find(entry=>entry.target===target);
    const text=current?.label || 'Sections';
    if(label.textContent!==text)label.textContent=text;
    toggle.title=current ? `Page sections · ${current.ariaLabel || text}` : 'Page sections';
    toggle.setAttribute('aria-label',current ? `Page sections, current: ${current.ariaLabel || text}` : 'Page sections');
    notify();
  }
  function setOpen(value, returnFocus = false) {
    const wasOpen=open;
    open=Boolean(compactQuery.matches && value && entries.length);
    nav.hidden=!entries.length || (compactQuery.matches && !open);
    toggle.hidden=!compactQuery.matches || !entries.length;
    close.hidden=!compactQuery.matches;
    toggle.setAttribute('aria-expanded',String(open));
    nav.dataset.compact=String(compactQuery.matches);
    if(open && !wasOpen) {
      // Reopening starts from the current section, not the last scroll offset
      // left by another mode or a shorter viewport. Scroll this menu only.
      nav.scrollTop=0;
      const current=entries.find(entry=>entry.target===activeTarget)?.link;
      if(current) {
        const bounds=nav.getBoundingClientRect();
        const heading=nav.querySelector('.section-nav-heading')?.getBoundingClientRect();
        const item=current.getBoundingClientRect();
        const top=(heading?.bottom ?? bounds.top)+3,bottom=bounds.bottom-8;
        if(item.bottom>bottom)nav.scrollTop+=item.bottom-bottom;
        else if(item.top<top)nav.scrollTop+=item.top-top;
      }
    }
    if(returnFocus && !toggle.hidden)toggle.focus({preventScroll:true});
    notify();
  }
  function cancelRequested() {
    requested=null;window.clearTimeout(jumpTimer);jumpTimer=null;
  }
  function updateCurrent() {
    queued=null;if(destroyed || requested)return;
    const edge=header.getBoundingClientRect().bottom+24;
    let current=null;
    for(const entry of entries) {
      const target=document.getElementById(entry.target);
      if(!visible(target))continue;
      current ??= entry.target;
      if(target.getBoundingClientRect().top<=edge)current=entry.target;
    }
    setCurrent(current);
  }
  function scheduleCurrent() {
    if(!destroyed && queued===null)queued=window.requestAnimationFrame(updateCurrent);
  }
  function measureHeader() {
    document.documentElement.style.setProperty('--site-header-height',`${Math.ceil(header.getBoundingClientRect().height)}px`);
    scheduleCurrent();
  }
  function jump(entry) {
    const target=document.getElementById(entry.target);
    if(!visible(target))return;
    for(let node=target;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;
    cancelRequested();requested=entry.target;setCurrent(entry.target);setOpen(false);
    let focus=entry.focus ? document.getElementById(entry.focus) : null;
    if(!focus || !target.contains(focus) || focus.matches('input,textarea,select,button,a,[contenteditable]')) {
      focus=target.querySelector('h1,h2,h3,h4,[role="heading"],summary') || target;
    }
    if(!focus.hasAttribute('tabindex') && focus.tagName!=='SUMMARY')focus.setAttribute('tabindex','-1');
    focus.focus({preventScroll:true});
    target.scrollIntoView({block:'start',behavior:reducedMotion.matches?'auto':'smooth'});
    // Retain the selected location during movement, including short targets
    // near the bottom that cannot align precisely with the top of the window.
    jumpTimer=window.setTimeout(()=>{requested=null;jumpTimer=null;},1500);
  }
  function update(items) {
    if(destroyed)return;
    const next=[],seen=new Set();
    for(const item of items) {
      if(!item || !/^[a-z0-9_-]+$/i.test(item.id) || seen.has(item.id) || typeof item.label!=='string' || typeof item.target!=='string')continue;
      const target=document.getElementById(item.target);if(!visible(target))continue;
      seen.add(item.id);
      let entry=records.get(item.id);
      if(!entry) {
        const link=document.createElement('a');link.id=`section-${item.id}`;
        entry={link};records.set(item.id,entry);
        link.addEventListener('click',event=>{
          if(event.button!==0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)return;
          event.preventDefault();jump(entry);
        });
      }
      Object.assign(entry,item);
      entry.link.setAttribute('href',`#${item.target}`);
      entry.link.setAttribute('aria-controls',item.target);
      entry.link.setAttribute('aria-label',item.ariaLabel || item.label);
      entry.link.title=item.ariaLabel || item.label;
      if(entry.link.textContent!==item.label)entry.link.textContent=item.label;
      next.push(entry);
    }
    const focused=document.activeElement;
    const removesFocus=[...records.entries()].some(([id,entry])=>!seen.has(id) && entry.link===focused);
    for(const [id,entry] of records)if(!seen.has(id)){entry.link.remove();records.delete(id);}
    next.forEach((entry,index)=>{
      if(container.children[index]!==entry.link)container.insertBefore(entry.link,container.children[index] || null);
    });
    entries=next;
    if(requested && !entries.some(entry=>entry.target===requested))cancelRequested();
    if(!entries.some(entry=>entry.target===activeTarget))activeTarget=entries[0]?.target || null;
    setCurrent(activeTarget);setOpen(open);
    if(removesFocus) {
      const nextFocus=compactQuery.matches ? toggle : entries[0]?.link;
      if(nextFocus && !nextFocus.hidden)nextFocus.focus({preventScroll:true});
    }
    scheduleCurrent();
  }
  const toggleClicked=()=>{
    setOpen(!open);
    // Safari may not focus a tapped button. Move off the editor so its soft
    // keyboard does not compete with the section menu for screen space.
    toggle.focus({preventScroll:true});
  };
  const closeClicked=()=>setOpen(false,true);
  const keydown=event=>{
    if(event.key==='Escape' && open){event.preventDefault();setOpen(false,true);return;}
    if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)){cancelRequested();scheduleCurrent();}
  };
  const pointerdown=event=>{
    if(!nav.contains(event.target) && !toggle.contains(event.target)){cancelRequested();if(open)setOpen(false);}
  };
  const focusin=event=>{
    if(open && !nav.contains(event.target) && !toggle.contains(event.target))setOpen(false);
  };
  const manualScroll=()=>{cancelRequested();scheduleCurrent();};
  const resize=()=>{
    const focused=document.activeElement;
    const focusWillHide=compactQuery.matches && !open && nav.contains(focused);
    const toggleWillHide=!compactQuery.matches && (focused===toggle || focused===close);
    setOpen(open,focusWillHide);
    if(toggleWillHide)(entries.find(entry=>entry.target===activeTarget)?.link || entries[0]?.link)?.focus({preventScroll:true});
    measureHeader();
  };
  toggle.addEventListener('click',toggleClicked);close.addEventListener('click',closeClicked);
  document.addEventListener('keydown',keydown);document.addEventListener('pointerdown',pointerdown);document.addEventListener('focusin',focusin);
  window.addEventListener('scroll',scheduleCurrent,{passive:true});window.addEventListener('resize',resize);
  window.addEventListener('wheel',manualScroll,{passive:true});window.addEventListener('touchstart',manualScroll,{passive:true});
  compactQuery.addEventListener('change',resize);
  const observer=window.ResizeObserver?new window.ResizeObserver(measureHeader):null;observer?.observe(header);
  setCurrent(null);setOpen(false);measureHeader();
  return {update,getState,destroy(){
    if(destroyed)return;destroyed=true;cancelRequested();
    if(queued!==null)window.cancelAnimationFrame(queued);
    observer?.disconnect();
    toggle.removeEventListener('click',toggleClicked);close.removeEventListener('click',closeClicked);
    document.removeEventListener('keydown',keydown);document.removeEventListener('pointerdown',pointerdown);document.removeEventListener('focusin',focusin);
    window.removeEventListener('scroll',scheduleCurrent);window.removeEventListener('resize',resize);
    window.removeEventListener('wheel',manualScroll);window.removeEventListener('touchstart',manualScroll);compactQuery.removeEventListener('change',resize);
    container.replaceChildren();records.clear();entries=[];open=false;activeTarget=null;nav.hidden=true;toggle.hidden=true;
    document.body.classList.remove('has-section-navigation');
  }};
}
