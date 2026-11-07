/* Copyright (c) 2026 Nenad Micic */
/* SPDX-License-Identifier: Apache-2.0 */

/** Present the existing transfer controls as an app, without owning their state. */
export function createAppView({ document, onChange = () => {} } = {}) {
  if (!document?.body) throw new TypeError('App view requires a document');
  const window = document.defaultView;
  const body = document.body;
  const transfer = document.getElementById('transfer-panel');
  if (!transfer) throw new Error('App view requires #transfer-panel');
  const find = (id) => document.getElementById(id);
  const options = find('transfer-options');
  const details = find('status-details');
  const inputMeta = find('compose-panel')?.querySelector('.input-meta');
  const nodes = ['progress-panel', 'chat-panel', 'received-panel', 'compose-panel', 'transfer-options', 'status-details', 'peer-idle-countdown', 'verification-panel', 'app-options', 'auto-paste']
    .map((id) => find(id)).filter(Boolean);
  if (inputMeta) nodes.push(inputMeta);
  const originals = nodes.map((node) => {
    const marker = document.createComment(`app-view:${node.id}`);
    node.before(marker);
    return { node, marker };
  });
  const shell = document.createElement('div');
  shell.id = 'app-view-shell';
  shell.hidden = true;
  const slots = {};
  for (const name of ['status', 'content', 'composer']) {
    const slot = document.createElement('div');
    slot.id = `app-view-${name}`;
    slot.className = 'app-view-slot';
    shell.append(slot);
    slots[name] = slot;
  }
  transfer.prepend(shell);

  let state = { preferredView: 'app', effectiveView: 'web', advanced: false, mode: 'message', active: false, needsConfirmation: false, hasReceived: false };
  let applied = false;
  let destroyed = false;
  let optionMode = null;
  let optionOpen = false;
  let detailsOpen = false;
  let lastReceived = false;
  let frame = 0;
  const appScroll = { content: 0, history: 0, follow: true };
  let webScroll = { x: 0, y: 0 };
  const editing = (node) => node?.matches?.('textarea, input:not([type=checkbox]):not([type=button]), [contenteditable=true]');
  const viewport = () => {
    frame = 0;
    if (destroyed || !applied) return;
    const height = Math.round(window?.visualViewport?.height || window?.innerHeight || 800);
    body.style.setProperty('--app-viewport-height', `${height}px`);
    body.dataset.appCompact = String(height < 700);
    body.dataset.appKeyboard = String(Boolean(editing(document.activeElement) && height < (window?.innerHeight || height) - 120));
  };
  const queueViewport = () => {
    if (frame || destroyed) return;
    frame = window?.requestAnimationFrame(viewport) || 0;
    if (!window?.requestAnimationFrame) viewport();
  };
  const preserveFocus = (operation) => {
    const focused = document.activeElement;
    const selection = editing(focused) && typeof focused.selectionStart === 'number'
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    operation();
    // Moving a focused node can blur it in WebKit. Restore only an existing focus;
    // never focus the editor merely because a view or a transfer mode changed.
    if (focused && focused !== body && focused.isConnected && document.activeElement !== focused) {
      focused.focus?.({ preventScroll: true });
      if (selection) focused.setSelectionRange?.(...selection);
    }
  };
  const setOptions = (open) => {
    optionOpen = Boolean(open);
    if (options) options.open = applied ? optionOpen : true;
    find('app-options')?.setAttribute('aria-expanded', String(optionOpen));
  };
  const optionToggle = () => {
    if (!applied || !options) return;
    if (options.open !== optionOpen) {
      optionOpen = options.open;
      find('app-options')?.setAttribute('aria-expanded', String(optionOpen));
      onChange(getState());
    }
  };
  const setDetails = (open) => {
    const returnFocus = !open && applied && details?.contains(document.activeElement);
    detailsOpen = Boolean(open);
    if (details) details.open = applied ? detailsOpen : true;
    find('app-status-details')?.setAttribute('aria-expanded', String(detailsOpen));
    if (returnFocus) find('app-status-details')?.focus({ preventScroll: true });
  };
  const detailsToggle = () => {
    if (!applied || !details) return;
    if (details.open !== detailsOpen) {
      detailsOpen = details.open;
      find('app-status-details')?.setAttribute('aria-expanded', String(detailsOpen));
      onChange(getState());
    }
  };
  const placeVerification = (required) => {
    const verification = find('verification-panel');
    if (!verification || !applied) return;
    const target = required ? find('status-essential') : details;
    if (target && verification.parentElement !== target) {
      preserveFocus(() => {
        if (required) target.append(verification);
        else target.insertBefore(verification, target.querySelector('summary')?.nextSibling || null);
      });
    }
  };
  const moveToApp = () => preserveFocus(() => {
    webScroll = { x: window?.scrollX || 0, y: window?.scrollY || 0 };
    applied = true;
    for (const id of ['progress-panel']) if (find(id)) slots.status.append(find(id));
    for (const id of ['status-details', 'transfer-options', 'chat-panel', 'received-panel']) if (find(id)) slots.content.append(find(id));
    if (find('compose-panel')) slots.composer.append(find('compose-panel'));
    if (find('peer-idle-countdown') && details) details.append(find('peer-idle-countdown'));
    const actions = find('compose-panel')?.querySelector('.start-row');
    if (find('app-options') && actions) actions.insertBefore(find('app-options'), find('auto-start'));
    if (find('auto-paste') && actions) actions.insertBefore(find('auto-paste'), find('app-options'));
    if (inputMeta && options) options.append(inputMeta);
    shell.hidden = false;
    body.dataset.experience = 'app';
    setOptions(optionOpen);
    setDetails(detailsOpen);
    placeVerification(state.needsConfirmation);
    viewport();
    window?.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    slots.content.scrollTop = appScroll.content;
    if (find('chat-history')) find('chat-history').scrollTop = appScroll.follow ? find('chat-history').scrollHeight : appScroll.history;
  });
  const restoreWeb = () => preserveFocus(() => {
    appScroll.content = slots.content.scrollTop;
    appScroll.history = find('chat-history')?.scrollTop || 0;
    const history = find('chat-history');
    appScroll.follow = !history || history.scrollHeight - history.scrollTop - history.clientHeight < 16;
    applied = false;
    for (const { node, marker } of originals) marker.after(node);
    shell.hidden = true;
    body.dataset.experience = 'web';
    body.style.removeProperty('--app-viewport-height');
    delete body.dataset.appKeyboard;
    delete body.dataset.appCompact;
    if (options) options.open = true;
    if (details) details.open = true;
    window?.scrollTo({ left: state.advanced ? 0 : webScroll.x, top: state.advanced ? 0 : webScroll.y, behavior: 'instant' });
  });
  function getState() {
    return { ...state, optionsOpen: Boolean(options?.open), statusDetailsOpen: Boolean(details?.open) };
  }
  function refresh({ view = 'app', advanced = false, mode = 'message', chatVisible = false, hasReceived = false, needsConfirmation = false, active = false, connecting = false } = {}) {
    if (destroyed) return getState();
    const wasConfirming = state.needsConfirmation;
    const wasActive = state.active;
    const modeChanged = mode !== optionMode;
    if (modeChanged) {
      optionMode = mode;
      optionOpen = mode === 'password';
      detailsOpen = mode === 'password' && !active;
      lastReceived = false;
    }
    const effectiveView = view === 'web' || advanced ? 'web' : 'app';
    state = { preferredView: view === 'web' ? 'web' : 'app', effectiveView, advanced: Boolean(advanced), mode, active: Boolean(active), connecting: Boolean(connecting), needsConfirmation: Boolean(needsConfirmation), hasReceived: Boolean(hasReceived) };
    body.dataset.experienceMode = mode;
    body.dataset.appConfirmation = String(Boolean(needsConfirmation));
    body.dataset.appActive = String(Boolean(active));
    body.dataset.appConnecting = String(Boolean(connecting));
    body.dataset.appChat = String(Boolean(chatVisible));
    if (effectiveView === 'app' && !applied) moveToApp();
    else if (effectiveView === 'web' && applied) restoreWeb();
    else if (!applied) body.dataset.experience = 'web';
    if (applied && modeChanged) {
      setOptions(optionOpen);
      setDetails(detailsOpen);
    }
    if (applied) placeVerification(needsConfirmation);
    if (active && !wasActive) {
      setOptions(false);
      setDetails(false);
      if (applied) slots.content.scrollTop = 0;
    }
    if (hasReceived && !lastReceived && mode === 'password') {
      setOptions(false);
      if (applied) slots.content.scrollTop = 0;
    }
    if ((needsConfirmation && !wasConfirming) || (hasReceived && !lastReceived && !chatVisible)) setDetails(false);
    lastReceived = Boolean(hasReceived);
    if (applied && modeChanged) slots.content.scrollTop = 0;
    return getState();
  }
  options?.addEventListener('toggle', optionToggle);
  details?.addEventListener('toggle', detailsToggle);
  window?.addEventListener('resize', queueViewport);
  window?.visualViewport?.addEventListener('resize', queueViewport);
  document.addEventListener('focusin', queueViewport);
  document.addEventListener('focusout', queueViewport);
  return {
    refresh,
    getState,
    destroy() {
      if (destroyed) return;
      options?.removeEventListener('toggle', optionToggle);
      details?.removeEventListener('toggle', detailsToggle);
      window?.removeEventListener('resize', queueViewport);
      window?.visualViewport?.removeEventListener('resize', queueViewport);
      document.removeEventListener('focusin', queueViewport);
      document.removeEventListener('focusout', queueViewport);
      if (frame) window?.cancelAnimationFrame(frame);
      if (applied) restoreWeb();
      for (const { marker } of originals) marker.remove();
      shell.remove();
      for (const key of ['experience', 'experienceMode', 'appConfirmation', 'appActive', 'appConnecting', 'appChat', 'appKeyboard', 'appCompact']) delete body.dataset[key];
      destroyed = true;
    },
  };
}
