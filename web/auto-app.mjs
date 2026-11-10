// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {AutoTransfer} from './auto-transfer.mjs';
import {ChatTransfer} from './chat-transfer.mjs';
import {MAX_CLEAR_TEXT_BYTES} from './clear-session.mjs';
import {getAudioProfile} from './audio-profiles.mjs';
import {getCryptoProfile, checkCryptoProfile} from './crypto-profiles.mjs';
import {installAutomationObserver, observeActions} from './automation-observer.mjs';
import {createAudioVisuals} from './audio-visuals.mjs';
import {createSectionNavigation} from './section-nav.mjs';
import {createAppView} from './app-view.mjs';
import {installPlaybackHints} from './audio-environment.mjs';
import {transferLifetimeMs} from './transfer-limits.mjs';
installPlaybackHints();
const el = id => document.getElementById(id);
// Link telemetry updates several times per second. Keep unchanged button text
// nodes stable so touch press/release events retain the same target.
const text = (id, value) => { if (el(id).textContent !== value) el(id).textContent = value; };
const encode = new TextEncoder();
let mode = 'message', state = {phase:'idle', active:false, fingerprint:'', role:null, status:''};
let advanced = false;
let received = null, secretTimer = null, startedAt = 0, elapsedTimer = null, generation = 0;
let pendingPaste = null, passwordSendIntent = false, passwordNotice = '';
let compactSupport = 'checking', compactError = '';
let chatRun = false, pendingEnqueue = false, chatNotice = '';
const history = [], delivered = new Set();
let followingChat = true, chatHeight = 0, chatWidth = 0, renderingHistory = false;
const awaitingReceipts = () => Math.max(state.pendingCount || 0,history.filter(row=>row.direction==='outgoing' && row.status==='Pending').length);
let runNumber = 0, lastTxAt = null, lastRxAt = null, lastTurnAt = null, lastReceiptAt = null;
let previousMetrics = {}, previousTurns = 0;
let notifyAgent = () => {};
let audioVisuals = null;
let sectionNavigation = null;
let appView = null, experience = new URLSearchParams(location.search).get('view') === 'web' ? 'web' : 'app';
const usingAppView = () => experience === 'app' && !advanced;
const passwordCleared = 'Password cleared. Paste or enter it again to send, or choose Receive instead.';
const phaseLabels = {
  idle:'Ready when you are', starting:'Opening the audio link', discovering:'Finding the other device',
  verify:'Compare both screens', confirming:'Confirming the session', rekeying:'Refreshing encrypted keys',
  sending:'Sending your message', receiving:'Receiving through sound', delivered:'Delivery confirmed',
  received:'Message received', chat:'Encrypted chat connected', closing:'Ending chat', closed:'Chat ended', error:'Transfer stopped', stopped:'Stopped',
};
const callbacks = {
  onChange(next) {
    const previousPhase = state.phase;
    const now = performance.now(), metrics = next.metrics || {};
    if (metrics.txFrames > (previousMetrics.txFrames || 0)) lastTxAt = now;
    if (metrics.rxFrames > (previousMetrics.rxFrames || 0)) lastRxAt = now;
    if ((next.chatStats?.turns || 0) > previousTurns) lastTurnAt = now;
    previousMetrics = metrics; previousTurns = next.chatStats?.turns || 0;
    state = next;
    if (!state.active) {
      clearInterval(elapsedTimer); elapsedTimer = null;
      for (const row of history) if (row.direction === 'outgoing' && row.status === 'Pending') row.status = 'Unconfirmed';
      renderHistory();
    }
    render();
    if (state.phase !== previousPhase) {
      if (state.phase === 'error') revealNextStep('start-hint');
      else if (state.phase === 'verify') revealNextStep('transfer-next');
    }
  },
  onDelivery({counter}) {
    lastReceiptAt = performance.now();
    delivered.add(counter);
    if (delivered.size > 256) delivered.delete(delivered.values().next().value);
    const row = history.find(row => row.direction === 'outgoing' && row.counter === counter);
    if (row) { row.status = 'Delivered'; row.deliveryMs = performance.now() - row.queuedAt; renderHistory(); }
    render();
  },
  onMessage(message) {
    if (chatRun) appendHistory('incoming', message.text, message.counter, 'Received');
    clearReceived(); received = {type:message.type, text:message.text};
    if (message.type === 'password') {
      el('auto-received-secret').value = message.text;
      secretTimer = setTimeout(clearReceived, 60000);
    } else el('auto-received-text').textContent = message.text;
    render();
    if (!chatRun) revealNextStep('transfer-next');
  },
};
let controller = new AutoTransfer(callbacks);
// Reveal a new required action once, without moving the page on telemetry,
// ordinary chat arrivals, or repeated renders. Fixed header/dock stay clear.
function revealNextStep(id) {
  requestAnimationFrame(() => {
    // App layout reserves room for required actions. Do not move its viewport
    // or internal panels when the transfer advances.
    if (usingAppView()) return;
    const node = el(id);
    if (advanced || document.hidden || !node || node.hidden) return;
    const rect = node.getBoundingClientRect();
    const top = el('site-header').getBoundingClientRect().bottom + 12;
    const bottom = Math.min(innerHeight,el('audio-visuals').getBoundingClientRect().top) - 12;
    if (rect.top < top || rect.bottom > bottom) node.scrollIntoView({block:'nearest',behavior:'auto'});
  });
}
function appendHistory(direction, text, counter, status) {
  const row = {direction, text, counter, status, queuedAt:performance.now(), time:new Date().toLocaleTimeString()};
  history.push(row);
  if (history.length > 200) history.shift();
  renderHistory(); return row;
}
function renderHistory() {
  // Replacing rows can emit a scroll event before the next layout frame. That
  // programmatic movement must not turn a following reader into an older reader.
  renderingHistory = true;
  el('chat-history').replaceChildren(...history.map(row => {
    const item = document.createElement('li'); item.className = `chat-entry ${row.direction}`;
    item.dataset.messageId = `${runNumber}:${row.direction}:${row.counter}`;
    item.dataset.direction = row.direction; item.dataset.counter = String(row.counter);
    item.dataset.delivery = row.status.toLowerCase();
    const label = document.createElement('span'); label.className = 'chat-meta';
    const fullLabel = document.createElement('span'); fullLabel.className = 'chat-meta-full'; fullLabel.textContent = `${row.direction === 'outgoing' ? 'You' : 'Peer'} · ${row.time}`;
    const direction = document.createElement('span'); direction.className = 'app-only chat-direction'; direction.textContent = row.direction === 'outgoing' ? 'You' : 'Peer';
    label.append(fullLabel,direction); label.title = fullLabel.textContent;
    const content = document.createElement('p'); content.textContent = row.text;
    const receipt = document.createElement('span'); receipt.className = 'chat-receipt'; receipt.textContent = row.status + (row.deliveryMs === undefined ? '' : ` · ${(row.deliveryMs / 1000).toFixed(1)}s`);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'text-button chat-copy'; copy.textContent = 'Copy';
    copy.id = `copy-${runNumber}-${row.direction}-${row.counter}`;
    copy.setAttribute('aria-label', `Copy message ${row.counter} from ${row.direction === 'outgoing' ? 'you' : 'peer'}`);
    copy.onclick = () => {
      if (!navigator.clipboard?.writeText) { note('Clipboard access needs HTTPS or a supported browser.'); return; }
      navigator.clipboard.writeText(row.text).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy denied'; });
    };
    const body = document.createElement('div'); body.className = 'chat-body'; body.append(label,content,receipt);
    item.append(body,copy); return item;
  }));
  el('chat-empty').hidden = history.length > 0;
  requestAnimationFrame(() => {
    if (followingChat && usingAppView()) el('chat-history').scrollTop = el('chat-history').scrollHeight;
    renderingHistory = false;
    updateChatPosition();
  });
}
function updateChatPosition() {
  const list = el('chat-history');
  const hidden = !usingAppView() || !history.length || list.scrollHeight - list.scrollTop - list.clientHeight < 16;
  if (el('chat-latest').hidden !== hidden) { el('chat-latest').hidden = hidden; notifyAgent(); }
}
function clearHistory() { history.length = 0; delivered.clear(); followingChat = true; renderHistory(); }
async function enqueueChat() {
  if (!chatRun || !state.connected || !state.canSend || pendingEnqueue) return;
  const text = el('auto-text').value, token = generation;
  if (!text || encode.encode(text).length > 96) return;
  pendingEnqueue = true; chatNotice = ''; render();
  try {
    const {counter} = await controller.enqueue(text);
    if (token !== generation) return;
    appendHistory('outgoing', text, counter, delivered.has(counter) ? 'Delivered' : 'Pending');
    if (el('auto-text').value === text) el('auto-text').value = '';
  } catch (error) { if (token === generation) chatNotice = error.message || 'Message could not be queued. Your draft is still here.'; }
  finally { if (token === generation) { pendingEnqueue = false; render(); } }
}
function renderMetrics() {
  const m = state.metrics || {}, c = state.chatStats || {};
  const awake = {idle:'Not requested',pending:'Requesting',held:'Active',unsupported:'Unavailable',denied:'Not granted',released:'Released by device'};
  el('metric-awake').textContent = awake[state.active ? m.screenWakeLock : 'idle'] || 'Not requested';
  el('metric-tx').textContent = `${m.txFrames || 0} / ${m.txBytes || 0}`;
  el('metric-rx').textContent = `${m.rxFrames || 0} / ${m.rxBytes || 0}`;
  el('metric-crc').textContent = String(m.crcRejectedCandidates || 0);
  el('metric-corrected').textContent = String(m.correctedNibbles || 0);
  el('metric-decoder').textContent = String(m.decoderErrors || 0);
  el('metric-retries').textContent = String(c.retries || 0);
  el('metric-rejected').textContent = String(c.rejectedFrames || 0);
  el('metric-turns').textContent = String(c.turns || 0);
  el('metric-pending').textContent = `${awaitingReceipts()} / 8`;
  el('input-level').value = state.active ? Math.min(1,m.inputPeak || 0) : 0;
  el('metric-level').textContent = !state.active ? 'Microphone stopped' : m.inputRms > 0 ? `${Math.round(20 * Math.log10(m.inputRms))} dBFS${m.inputPeak >= 0.99 ? ' · clipping' : ''}` : 'No input';
}
function clearReceived() {
  clearTimeout(secretTimer); secretTimer = null; received = null;
  el('auto-received-text').textContent = ''; el('auto-received-secret').value = ''; render();
}
function note(message) { text('auto-status',message); text('start-hint',message); notifyAgent(); }
function clearPassword() {
  // Remember only the intended role, never the cleared password itself.
  if (el('auto-password').value) passwordSendIntent = true;
  el('auto-password').value = '';
  passwordNotice = '';
}
function agentSnapshot() {
  const now = performance.now(), age = at => at === null ? null : Math.max(0,Math.round(now-at));
  const connected = Boolean(chatRun && state.active && state.connected);
  const close = state.active && chatRun ? controller.state.close : state.close;
  const metricNames = ['txFrames','txBytes','rxFrames','rxBytes','crcRejectedCandidates','correctedNibbles','decoderErrors','invalidHeaderCandidates','invalidPayloadCandidates','inputRms','inputPeak','inputClippedSamples'];
  const next = state.active ? state.closing ? 'wait_for_close_or_stop_now' : state.phase === 'verify' && !state.peerVerified ? 'compare_fingerprint_independently'
    : connected ? state.canSend ? 'compose_or_wait_for_peer' : 'wait_for_receipts' : 'wait_or_stop'
    : state.phase === 'error' ? 'inspect_error_then_restart_both' : state.phase === 'closed' ? 'inspect_close_result_or_start_new_session' : 'choose_initial_sender_and_start';
  return {
    scope:'automatic-transfer-page',view:advanced?'advanced':mode,
    session:{run:runNumber,mode,chat:chatRun,phase:state.phase,active:Boolean(state.active),connected,
      closing:Boolean(state.closing),close:close?{...close}:null,
      role:state.role || null,status:el('auto-status').textContent,audioStatus:state.active ? state.audioStatus || null : null,
      error:state.phase === 'error' ? {code:'transfer_failed',message:state.status} : null,
      audioProfile:el('audio-profile').value,cryptoProfile:mode === 'clear'?null:el('crypto-profile').value,
      elapsedMs:state.active?Math.max(0,Date.now()-startedAt):null,
      peerIdle:state.active ? controller.state.peerIdle || null : null,
      messageIdle:state.active && chatRun ? controller.state.messageIdle || null : null,
      remainingMs:state.active?Math.max(0,controller.state.lifetimeMs-(Date.now()-startedAt)):null},
    trust:{encryptedModeSelected:mode!=='clear',comparisonRequired:el('verify-peer').checked && mode!=='clear',
      confirmedLocally:Boolean(state.active && state.peerVerified),
      fingerprint:state.active && mode!=='clear' ? state.fingerprint || null : null,
      note:'Connected and receipt counters do not authenticate peer identity. Confirm only using an independent trusted comparison.'},
    capabilities:{secureContext:globalThis.isSecureContext,nativeCrypto:Boolean(globalThis.crypto?.subtle),
      microphoneApi:Boolean(navigator.mediaDevices?.getUserMedia),clipboardRead:Boolean(navigator.clipboard?.readText),
      clipboardWrite:Boolean(navigator.clipboard?.writeText),compactCrypto:compactSupport,playbackLevel:1,
      screenWakeLockApi:Boolean(navigator.wakeLock?.request)},
    power:{screenWakeLock:state.active ? state.metrics?.screenWakeLock || 'idle' : 'idle'},
    queue:{pending:awaitingReceipts(),encryptedPending:state.pendingCount||0,capacity:8,canEnqueue:Boolean(connected && !state.closing && state.canSend && !pendingEnqueue)},
    limits:{messageUtf8Bytes:mode==='clear'?MAX_CLEAR_TEXT_BYTES:96,retainedMessages:200,
      peerIdleTimeoutMs:Number(el('peer-idle-timeout').value),
      chatLifetimeMs:transferLifetimeMs(600000,Number(el('peer-idle-timeout').value)),
      singleTransferLifetimeMs:transferLifetimeMs(180000,Number(el('peer-idle-timeout').value)),backgroundEndsSession:true},
    activity:{lastTransmitAgeMs:age(lastTxAt),lastDecodedFrameAgeMs:age(lastRxAt),lastCompletedTurnAgeMs:age(lastTurnAt),lastReceiptAgeMs:age(lastReceiptAt)},
    visuals:audioVisuals?.getState() || null,
    presentation:appView?.getState() || null,
    navigation:sectionNavigation?.getState() || null,
    metrics:Object.fromEntries(metricNames.map(name=>[name,!state.active && ['inputRms','inputPeak'].includes(name)?0:state.metrics?.[name]??0])),
    chatMetrics:{...(state.chatStats||{})},
    messages:history.map(row=>({id:`${runNumber}:${row.direction}:${row.counter}`,direction:row.direction,
      counter:row.counter,delivery:row.status.toLowerCase(),deliveryMs:row.deliveryMs===undefined?null:Math.round(row.deliveryMs)})),
    nextAction:next,
    actions:observeActions(document,{
      start:!globalThis.isSecureContext?'Open over HTTPS or localhost.':el('input-hint').textContent,
      endChat:state.closing?'Close is already in progress. Wait or use Stop now.':'End chat is available after encrypted chat connects.',
      draft:state.closing?'Chat is closing. The unsent draft is retained; new sends are paused.':connected?'Return to Message to write a reply.':state.active?'Wait until chat connects.':'Choose Message or Clear text.',
      passwordDraft:'Stop the current transfer or wait for clipboard reading.',
      cryptoProfile:'End the session before changing key exchange.',audioProfile:'End the session before changing audio connection.',
      verifyPeer:'Choose verification before starting the session.',chatEnabled:'End the session before changing chat mode.',
      peerIdleTimeout:'End the session before changing the idle timeout.',
      clearConversation:!history.length?'No conversation to clear.':'Wait for pending receipts or end chat before clearing.',showcase:'End the session before opening a different tool.',
      manual:'End the session before navigating to manual tools.',legacy:'End the session before navigating to the original experiment.',
      guideJson:'Navigation is disabled to preserve the session. Read the inline guide or fetch the linked JSON without leaving this page.'},
      {stop:usingAppView()?'auto-stop':connected && !state.closing?'header-abort':'header-stop',endChat:usingAppView()?'auto-end':connected && !state.closing?'header-stop':'auto-end'}),
  };
}
function renderAgentView() {
  text('agent-inspect',el('agent-state').hidden?'Show local state JSON':'Hide local state JSON');
  if (!el('agent-state').hidden) el('agent-state').textContent = JSON.stringify(window.tonesealAgent?.getState() || agentSnapshot(),null,2);
  el('agent-session-note').textContent = state.active
    ? `The session is still active. Settings are locked; ${mode === 'message' ? 'Message' : mode === 'password' ? 'Password' : 'Clear text'} returns to the transfer. ${state.closing ? 'Stop now' : chatRun && state.connected ? 'End chat' : 'Stop'} remains in the header.`
    : 'Read the guide here, then choose a transfer tab above. Opening this guide does not start the microphone.';
}
function renderPeerIdle() {
  const current = state.active ? controller.state : null;
  const messageIdle = chatRun && current?.connected && !current.closing ? current.messageIdle : null;
  const idle = messageIdle || current?.peerIdle;
  const milliseconds = Number(el('peer-idle-timeout').value);
  const duration = milliseconds < 60000 ? `${milliseconds/1000} seconds` : milliseconds === 3600000 ? '1 hour' : `${milliseconds/60000} minute${milliseconds === 60000 ? '' : 's'}`;
  const seconds = idle?.remainingMs == null ? null : Math.max(0,Math.ceil(idle.remainingMs/1000));
  text('peer-idle-countdown',messageIdle?.waitingForReceipts
    ? 'Idle countdown pauses while messages await delivery receipts.'
    : seconds === null ? `Idle timeout: ${duration} without a peer response or new chat message.`
    : messageIdle ? `Without a new message, chat closes in ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}.`
    : `Without another peer response, audio stops in ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}.`);
}
function renderSectionNavigation() {
  if (usingAppView()) { sectionNavigation?.update([]); return; }
  const item = (id,target,label,focus,ariaLabel) => ({id,target,label,focus,ariaLabel});
  const items = advanced ? [
    item('settings','settings-panel','Settings','advanced-title'),
    item('guide','agent-panel','Guide','agent-title'),
    item('showcase','showcase-panel','Showcase','showcase-title'),
    item('tools','tools-panel','Tools','diagnostics-title'),
  ] : [
    item('compose','compose-panel',mode === 'password' ? 'Password' : 'Message','compose-title'),
    ...(!el('verification-options').hidden ? [item('verify','verification-options','Verify',null,'Jump to peer verification settings')] : []),
    item('status','progress-panel','Status','auto-phase'),
    ...(!el('verification-panel').hidden ? [item('fingerprint','verification-panel',el('auto-confirm').hidden ? 'Fingerprint' : 'Continue',null,'View the fingerprint and confirmation controls; this link does not confirm the peer')] : []),
    ...(!el('chat-panel').hidden ? [item('chat','chat-panel','Chat','chat-title')] : []),
    ...(!el('received-panel').hidden ? [item('received','received-panel','Received','received-title')] : []),
  ];
  items.push(item('about','about-toneseal','About','about-title'));
  sectionNavigation?.update(items);
}
function updateElapsed() {
  if (!state.active) return;
  const elapsed = Math.max(0,Math.floor((Date.now()-startedAt)/1000));
  const remaining = Math.max(0,Math.ceil(controller.state.lifetimeMs/1000)-elapsed);
  const duration = seconds => `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  const close = state.closing ? controller.state.close : null;
  el('elapsed').textContent = close?.remainingMs != null
    ? `Closing · ${duration(Math.ceil(close.remainingMs/1000))} left`
    : `Elapsed ${duration(elapsed)} · ${duration(remaining)} left`;
  el('session-expiry').hidden = remaining > 60;
  el('session-expiry').textContent = remaining <= 60 ? `Session ends in ${remaining}s. Finish the exchange and wait for delivery receipts; start a fresh session on both devices to continue.` : '';
  renderPeerIdle();
  renderAgentView();
}
function render() {
  const app = usingAppView();
  el('experience-toggle').hidden = advanced;
  text('experience-toggle',experience === 'app' ? 'Web view' : 'App view');
  el('experience-toggle').setAttribute('aria-label',`Switch to ${experience === 'app' ? 'Web' : 'App'} view`);
  text('site-location',advanced ? 'Advanced settings' : mode === 'password' ? 'Encrypted password' : mode === 'clear' ? 'Unencrypted clear text' : 'Encrypted message');
  el('site-location').dataset.protection = advanced ? 'settings' : mode === 'clear' ? 'clear' : 'encrypted';
  el('transfer-panel').hidden = advanced;
  el('advanced-options').hidden = !advanced;
  el('transfer-panel').setAttribute('aria-labelledby', `mode-${mode}`);
  el('mode-showcase').disabled = state.active || Boolean(pendingPaste);
  const connected = chatRun && state.active && state.connected;
  const closing = Boolean(state.closing);
  const chatSelected = mode === 'message' && el('chat-enabled').checked;
  el('page-title').textContent = advanced ? 'Settings and tools.' : mode === 'password' ? 'Send a password.' : mode === 'clear' ? 'Send clear text.' : 'Write. Connect. Talk.';
  el('flow-intro').textContent = advanced ? 'Inspect settings, explore the showcase, or find the browser agent guide. The current session stays open while you read.'
    : closing ? 'Ending the conversation. Queued messages finish first; new messages are paused. Keep both pages open for the close handshake, or use Stop now for an immediate local stop.'
    : connected ? 'Both devices can send. Write a reply on either device and press Send message. The audio link takes turns automatically.'
    : state.active ? 'Connecting the two devices. Keep both pages visible and unlocked. Press Stop to finish on this device.'
    : 'Write on one device. Leave the other blank, then start both. ' + (chatSelected ? 'Message stays connected for replies.' : 'This mode sends one item per session.');
  el('clear-warning').hidden = mode !== 'clear';
  el('mode-lifecycle').textContent = app ? chatSelected ? 'Stays connected for replies.' : mode === 'password' ? 'One password per connection. The receiver chooses Copy.' : 'One message per connection.'
    : chatSelected ? 'Encrypted chat · after the first delivery, both devices can send without pairing again.'
    : `${mode === 'clear' ? 'Unencrypted' : 'Encrypted'} single transfer · the sender stops after its receipt; the receiver listens briefly to repair lost receipts, then stops. You can stop it sooner.`;
  el('elapsed').hidden = !state.active;
  if (!state.active) el('session-expiry').hidden = true;
  const value = mode === 'password' ? el('auto-password').value : el('auto-text').value;
  const bytes = encode.encode(value).length, limit = mode === 'clear' ? MAX_CLEAR_TEXT_BYTES : 96;
  const sending = state.active ? state.role === 'sender' : bytes > 0 || (mode === 'password' && passwordSendIntent);
  const needsPassword = mode === 'password' && passwordSendIntent && !bytes && !state.active;
  const passwordHint = mode === 'password' && !state.active ? passwordNotice || (needsPassword ? passwordCleared : '') : '';
  const verified = state.peerVerified === true;
  const cryptoProfile = getCryptoProfile(el('crypto-profile').value);
  const cryptoUnavailable = mode !== 'clear' && cryptoProfile.id === 'x25519' && compactSupport !== 'supported';
  el('auto-role').textContent = closing ? 'ENDING CHAT' : connected ? 'BOTH DEVICES CAN SEND' : sending ? 'SENDING DEVICE' : 'RECEIVING DEVICE';
  el('auto-text').hidden = mode === 'password'; el('auto-password').hidden = mode !== 'password';
  el('auto-text').placeholder = connected ? 'Write a reply…' : app ? 'Write a message…' : 'Leave blank to receive. Write here only to send.';
  el('auto-text').disabled = state.active && (!connected || closing); el('auto-password').disabled = state.active || Boolean(pendingPaste);
  el('compose-title').textContent = app ? mode === 'password' ? 'Password' : connected ? 'Reply' : 'Message' : mode === 'password' ? 'Transfer a password' : closing ? 'Ending the conversation' : connected ? 'Write a reply' : 'What would you like to send?';
  el('auto-label').htmlFor = mode === 'password' ? 'auto-password' : 'auto-text';
  el('auto-label').replaceChildren(document.createTextNode(mode === 'password' ? 'Your password ' : 'Your message '));
  const optional = document.createElement('span'); optional.textContent = closing ? 'this draft is not queued; closing sends only previously queued messages' : connected ? 'either device can send now' : 'leave blank on the receiving device'; el('auto-label').append(optional);
  el('byte-count').textContent = `${bytes} / ${limit} UTF-8 bytes`;
  el('input-hint').textContent = connected ? pendingEnqueue ? 'Adding your message…' : bytes > limit ? `Too long. Use ${limit} UTF-8 bytes or fewer.` : !state.canSend ? 'Queue full. Your draft stays here until receipts free a slot.' : 'Send a short reply. The devices take turns automatically using this session.' : pendingPaste ? 'Reading clipboard… Wait for the password before starting.' : bytes > limit ? `Too long. Shorten the content to ${limit} UTF-8 bytes or fewer.` : state.active ? state.phase === 'received' ? 'Message received. You can choose another mode for the next transfer.' : 'Transfer in progress. Press Stop to change the input or mode.' : passwordHint || (sending ? 'Leave the other device blank and press Start receiving there.' : 'Leave this blank. Write only on the sender.');
  if (closing) el('input-hint').textContent = 'Closing: new sends are paused while queued messages and close acknowledgements finish. Stop now releases audio immediately; pending delivery may be unconfirmed.';
  else if (connected && chatNotice) el('input-hint').textContent = chatNotice;
  el('auto-start').disabled = closing || (connected ? !state.canSend || !bytes || pendingEnqueue : state.active) || Boolean(pendingPaste) || needsPassword || cryptoUnavailable || bytes > limit || !globalThis.isSecureContext || !globalThis.crypto?.subtle;
  text('auto-start', closing ? 'Closing…' : connected ? app ? 'Send' : 'Send message' : state.active ? 'Connecting…' : sending ? 'Start sending' : 'Start receiving');
  el('auto-start').setAttribute('aria-label',connected && !closing ? 'Send message' : el('auto-start').textContent);
  el('auto-stop').hidden = !state.active && !pendingPaste;
  text('auto-stop', chatRun && (state.connected || closing) ? 'Stop now' : 'Stop');
  el('auto-end').hidden = !connected;
  el('auto-end').disabled = closing;
  el('header-stop').hidden = el('auto-stop').hidden;
  el('header-abort').hidden = !connected || closing;
  el('site-caption').hidden = !el('auto-stop').hidden;
  text('header-stop', closing ? 'Stop now' : connected ? 'End chat' : 'Stop');
  el('chat-enabled').disabled = state.active || Boolean(pendingPaste);
  el('peer-idle-timeout').disabled = state.active || Boolean(pendingPaste);
  el('chat-panel').hidden = mode !== 'message' || !(chatRun || el('chat-enabled').checked || history.length);
  text('chat-title',app ? 'Chat' : 'Conversation');
  el('chat-state').textContent = closing ? 'CLOSING' : connected ? 'CONNECTED' : state.active ? 'CONNECTING' : history.length ? 'ENDED' : 'READY';
  el('chat-clear').disabled = !history.length || Boolean(awaitingReceipts()) || pendingEnqueue;
  el('chat-queue').hidden = !chatRun || !state.active || (app && !awaitingReceipts() && !closing);
  el('chat-jump').hidden = mode !== 'message' || !history.length;
  const needsComparison = state.active && state.phase === 'verify';
  const hasReceivedItem = received && !(mode === 'message' && chatRun);
  el('transfer-next').hidden = !needsComparison && !hasReceivedItem;
  el('transfer-next').href = needsComparison ? '#verification-panel' : '#received-panel';
  text('transfer-next',needsComparison ? 'Compare fingerprints and continue ↓' : received?.type === 'password' ? 'Copy received password ↓' : 'View received message ↓');
  el('chat-reply').hidden = !connected || closing;
  const pendingReceipts = awaitingReceipts();
  el('chat-queue').textContent = closing ? pendingReceipts
    ? `${pendingReceipts} ${pendingReceipts === 1 ? 'message still awaits its delivery receipt' : 'messages still await delivery receipts'}. Then the close handshake finishes.`
    : 'Queued messages have delivery receipts. Finishing the close handshake.'
    : `${pendingReceipts} / 8 messages waiting for receipts`;
  document.querySelector('.received-card').hidden = (mode === 'message' && (chatRun || history.length > 0 || (app && chatSelected && !received)))
    || (app && mode === 'password' && !received);
  renderMetrics();
  el('auto-paste').hidden = mode !== 'password'; el('auto-paste').disabled = state.active || Boolean(pendingPaste);
  text('auto-paste',app ? 'Paste' : 'Paste from clipboard');
  el('auto-paste').setAttribute('aria-label','Paste from clipboard');
  el('receive-instead').hidden = state.active || !sending || Boolean(pendingPaste);
  el('auto-example').hidden = mode === 'password' || state.active;
  el('auto-example').disabled = state.active || bytes > 0 || Boolean(pendingPaste) || cryptoUnavailable || !globalThis.isSecureContext || !globalThis.crypto?.subtle;
  el('example-hint').hidden = mode === 'password' || state.active;
  el('example-hint').textContent = bytes > 0 ? 'Clear your draft before using Send example.' : 'Sender only: send the current time as a test.';
  el('audio-profile').disabled = state.active;
  const audioProfile = getAudioProfile(el('audio-profile').value);
  const telephone = audioProfile.id === 'telephone', ultrasonic = audioProfile.id === 'ultrasonic';
  el('crypto-profile').disabled = state.active;
  el('crypto-profile').querySelector('[value="x25519"]').disabled = compactSupport !== 'supported';
  el('crypto-profile-hint').textContent = (mode === 'clear' ? 'These settings apply to Message and Password. Clear text does not use encryption. ' : '') + (cryptoProfile.id === 'x25519'
      ? `Choose Compact on both devices. Public keys use 32 bytes; pairing packets use 51 bytes. Pairing and rekey save ${(3.6*audioProfile.timingScale).toFixed(1)} seconds of waveform airtime versus Compatible, before retries and processing. No automatic switch.`
      : 'Choose Compatible on both devices. Public keys use 65 bytes; pairing packets use 84 bytes. This preserves the existing P-256 exchange.');
  el('crypto-capability').textContent = compactSupport === 'checking' ? 'Checking compact key exchange support…'
    : compactSupport === 'supported' ? 'Compact key exchange is supported by this browser. The other device must support it too.' : compactError;
  el('audio-profile-hint').textContent = ultrasonic
    ? app ? 'Experimental: choose Near-ultrasonic on both devices. Keep nearby devices still. Hardware may filter these tones.'
      : 'Experimental 18.4–19.975 kHz tones, twice the Nearby duration. Keep devices close and still; high-frequency support varies. For nearby devices, not phone calls. No automatic switch.'
    : app ? telephone
    ? 'Choose Telephone on both devices. Experimental: call audio processing can prevent delivery.'
    : 'Choose Nearby on both devices in the same room.'
    : telephone
    ? 'Choose Telephone on both devices. Slower tones for testing through a call; delivery depends on the call’s audio processing. No automatic switch.'
    : 'Choose Nearby on both devices. Faster tones for devices in the same room. No automatic switch.';
  el('verify-peer').disabled = state.active;
  el('verification-options').hidden = mode === 'clear';
  el('verification-hint').textContent = app ? 'Compare all 8 fingerprint groups, then Continue on both devices.' : 'Pause once to compare fingerprints and press Continue on both devices.';
  // App Status already keeps the current protection and verification state visible.
  el('trust-note').hidden = app;
  el('trust-note').textContent = state.active
    ? verified ? 'Encrypted · peer fingerprint checked here. Automatic rekey preserves that verified connection.' : state.verification === 'required' ? 'Verification required. No message is sent until the fingerprint is confirmed.' : 'Simple mode · encrypted, peer not verified. Key refresh checks continuity, not device identity.'
    : el('verify-peer').checked ? 'Verify peer · compare every group and Continue on both devices before sending.' : 'Simple mode · encrypted, peer not verified. Pairing and key refresh are automatic.';
  const rolePhase = app && state.active && state.role ? state.phase === 'starting'
    ? `${state.role === 'sender' ? 'Sender' : 'Receiver'} · opening audio`
    : state.phase === 'discovering' ? state.role === 'sender' ? 'Sender · finding receiver' : 'Receiver · listening' : '' : '';
  el('auto-phase').textContent = rolePhase || (state.phase === 'closed' && state.close?.outcome === 'unconfirmed' ? 'Chat ended · close unconfirmed'
    : state.phase === 'closed' && state.close?.initiator === 'peer' ? 'Chat ended by peer'
    : state.phase === 'closing' && state.close?.initiator === 'peer' ? 'Peer is ending chat'
    : phaseLabels[state.phase] || 'Transferring through sound');
  const visibleStatus = app && state.phase === 'verify' ? 'No message sent yet.'
    : app && connected && !closing ? (state.status || '').replace(/^Chat connected\. /,'') : state.status;
  note(pendingPaste ? 'Reading clipboard… Wait for the password before starting.' : passwordHint ? [state.phase === 'delivered' || state.phase === 'error' ? state.status : '', passwordHint].filter(Boolean).join(' ') : visibleStatus || (app ? 'Write on one device; leave the other blank. Start both.' : 'No microphone is open. Start on each device to begin.'));
  el('activity-dot').classList.toggle('active', Boolean(state.active));
  const blockedDraftHint = bytes > limit || pendingPaste || needsPassword || passwordHint || (connected && !closing && !state.canSend)
    ? el('input-hint').textContent : '';
  const validation = blockedDraftHint || (connected && (pendingEnqueue || chatNotice) ? el('input-hint').textContent : '')
    || (cryptoUnavailable ? 'Selected key exchange is unavailable. Choose Compatible in Advanced.' : '')
    || (!globalThis.isSecureContext || !globalThis.crypto?.subtle ? 'Open over HTTPS or localhost to use microphone and encryption.' : '');
  text('composer-validation',validation);
  el('composer-validation').hidden = !validation;
  el('auto-start').setAttribute('aria-describedby',app ? 'composer-validation app-operating-note' : 'start-hint');
  text('app-operating-note',mode === 'clear' ? 'Unencrypted · one transfer per Start.' : verified ? 'Encrypted · fingerprint checked here.' : el('verify-peer').checked ? 'Encrypted · compare fingerprints before sending.' : 'Encrypted · peer not verified.');
  text('start-hint',state.phase === 'error' && state.status ? [state.status,blockedDraftHint].filter(Boolean).join(' ') : blockedDraftHint || ((state.active || ['error','received','delivered','closed','stopped'].includes(state.phase)) && state.status
    ? state.status + (state.active && telephone ? ' Keep the call connected.' : '')
    : sending ? 'Press Start receiving on the other device.' : mode === 'password' ? 'Enter or paste the password only on the sending device.' : 'Write or send an example only on the other device.'));
  renderPeerIdle();
  el('verification-panel').hidden = mode === 'clear' || !state.active || !state.fingerprint;
  el('fingerprint-note').hidden = el('verification-panel').hidden;
  el('auto-fingerprint').textContent = state.active ? state.fingerprint || '' : '';
  const needConfirmation = state.active && state.verification === 'required' && !verified && Boolean(state.fingerprint);
  el('auto-confirm').hidden = !needConfirmation;
  el('auto-confirm').disabled = !needConfirmation;
  el('fingerprint-instruction').textContent = needConfirmation ? app ? 'Compare all 8 groups, then Continue on both.' : 'Compare all eight groups on both screens. Continue only if every group matches.' : verified ? app ? 'Current fingerprint · verified connection.' : 'You confirmed the original pairing. The current session fingerprint is shown below; encrypted key refresh maintains continuity.' : app ? 'Optional fingerprint · peer not verified.' : 'Optional comparison. Simple mode does not wait for a fingerprint check before sending.';
  el('fingerprint-note').textContent = verified ? 'Peer verification comes from your comparison, not from the automated audio exchange.' : 'A fingerprint sent over the same audio channel does not independently authenticate the peer.';
  el('audio-note').textContent = state.active ? [state.audioStatus, state.phase === 'received' ? 'Your message is here. Listening briefly to resend receipts if needed; you can choose another mode or press Stop.' : `Microphone active. The app automatically takes turns listening and sending. ${chatRun && (connected || closing)?'Stop now':'Stop'} closes the microphone immediately.`].filter(Boolean).join(' ') : 'Microphone stopped. Keep both screens visible during the next transfer.';
  el('received-empty').hidden = Boolean(received);
  el('auto-received-text').hidden = !received || received.type === 'password';
  el('auto-received-secret').hidden = !received || received.type !== 'password';
  el('secret-label').hidden = !received || received.type !== 'password';
  el('secret-note').hidden = !received || received.type !== 'password';
  el('received-type').textContent = !received ? 'WAITING' : received.type === 'clear' ? 'CLEARTEXT' : received.type === 'password' ? 'ENCRYPTED PASSWORD' : 'ENCRYPTED MESSAGE';
  el('auto-copy').disabled = !received; el('auto-clear').disabled = !received;
  document.querySelectorAll('.mode-tabs [role="tab"]').forEach(button => {
    const selected = advanced ? button.id === 'mode-advanced' : button.dataset.mode === mode;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.disabled = (state.active && (chatRun || state.phase !== 'received') && button.id !== 'mode-advanced' && button.dataset.mode !== mode) || Boolean(pendingPaste);
  });
  for (const link of document.querySelectorAll('#advanced-options a[data-leaves-session]')) {
    link.setAttribute('aria-disabled', String(Boolean(state.active)));
  }
  appView?.refresh({view:experience,advanced,mode,chatVisible:!el('chat-panel').hidden,hasReceived:Boolean(received),needsConfirmation:needConfirmation,active:Boolean(state.active),connecting:Boolean(state.active && !connected),phase:state.phase});
  audioVisuals?.refresh();
  renderSectionNavigation();
  renderAgentView();
  notifyAgent();
  requestAnimationFrame(() => {
    // Status text and receipt labels can reflow the available conversation
    // height without adding a row. Reconcile its tail after that layout too.
    if (followingChat && usingAppView()) el('chat-history').scrollTop = el('chat-history').scrollHeight;
    updateChatPosition();
  });
}
function renderTabChange() {
  render();
  // Every destination starts below the persistent header, rather than keeping
  // the previous view's scroll depth. Header height also tracks mobile rotation.
  if (!usingAppView()) el(advanced ? 'advanced-options' : 'transfer-panel').scrollIntoView({block:'start'});
}
function startTransfer() {
  if (chatRun && state.active && state.connected) { enqueueChat(); return; }
  if (state.active || pendingPaste) return;
  if (mode !== 'clear' && el('crypto-profile').value === 'x25519' && compactSupport !== 'supported') { render(); return; }
  const text = mode === 'password' ? el('auto-password').value : el('auto-text').value;
  if (mode === 'password') {
    if (text) passwordSendIntent = true;
    else if (passwordSendIntent) { render(); return; }
  }
  if (encode.encode(text).length > (mode === 'clear' ? MAX_CLEAR_TEXT_BYTES : 96)) return;
  generation++; clearReceived(); clearHistory(); pendingEnqueue = false; chatNotice = '';
  runNumber++; lastTxAt = lastRxAt = lastTurnAt = lastReceiptAt = null;
  previousMetrics = {}; previousTurns = 0;
  chatRun = mode === 'message' && el('chat-enabled').checked;
  controller = chatRun ? new ChatTransfer(callbacks) : new AutoTransfer(callbacks);
  if (chatRun && text) appendHistory('outgoing', text, 1, 'Pending');
  startedAt = Date.now();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(updateElapsed,1000);
  // start() opens/resumes audio synchronously within this user gesture. Do not
  // insert a clipboard read, timer or other awaited operation before this call.
  const starting = controller.start({mode, text, verifyPeer:el('verify-peer').checked, volume:1, profile:el('audio-profile').value, cryptoProfile:el('crypto-profile').value, idleTimeoutMs:Number(el('peer-idle-timeout').value)});
  updateElapsed();
  if (mode === 'password') clearPassword();
  else el('auto-text').value = '';
  Promise.resolve(starting).catch(error => { clearInterval(elapsedTimer); elapsedTimer = null; note(error.message || 'Could not start the audio link.'); revealNextStep('start-hint'); });
  render();
}
el('auto-start').onclick = startTransfer;
el('experience-toggle').onclick = () => { experience = experience === 'app' ? 'web' : 'app'; render(); };
function revealPasswordSetting(node) {
  if (!usingAppView() || mode !== 'password') return;
  const content = el('app-view-content');
  const scroller = getComputedStyle(content).overflowY === 'auto' ? content : document.querySelector('body > main');
  // An explicit disclosure click reveals that section in its own scroll area.
  scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}
el('app-options').onclick = () => {
  el('transfer-options').open = !el('transfer-options').open;
  if (el('transfer-options').open) {
    if (mode === 'password') revealPasswordSetting(el('transfer-options'));
    else el('app-view-content').scrollTop = 0;
  }
};
el('app-status-details').onclick = () => {
  el('status-details').open = !el('status-details').open;
  if (el('status-details').open) revealPasswordSetting(el('status-details'));
};
el('chat-latest').onclick = () => {
  followingChat = true;
  el('chat-history').scrollTop = el('chat-history').scrollHeight;
  updateChatPosition(); notifyAgent();
};
el('chat-history').addEventListener('scroll',() => {
  const list = el('chat-history');
  // A resize can move the visible bottom before ResizeObserver runs. Preserve
  // the previous follow choice until that geometry change is handled below.
  if (!renderingHistory && usingAppView() && list.clientHeight === chatHeight && list.clientWidth === chatWidth) {
    followingChat = list.scrollHeight - list.scrollTop - list.clientHeight < 16;
  }
  updateChatPosition(); notifyAgent();
},{passive:true});
if (globalThis.ResizeObserver) new ResizeObserver(() => {
  const list = el('chat-history');
  if (!usingAppView() || !list.clientHeight) return;
  chatHeight = list.clientHeight; chatWidth = list.clientWidth;
  if (followingChat) list.scrollTop = list.scrollHeight;
  updateChatPosition();
}).observe(el('chat-history'));
el('auto-example').onclick = () => {
  if (state.active || pendingPaste || mode === 'password' || el('auto-text').value) return;
  el('auto-text').value = `The current time is ${new Date().toISOString()}.`;
  startTransfer();
};
el('auto-confirm').onclick = () => { Promise.resolve(controller.confirm()).catch(error => note(error.message)); };
function endChat() {
  if (!chatRun || !state.active || !state.connected || state.closing) return;
  const token = generation;
  Promise.resolve(controller.close()).catch(error=>{if(token===generation)note(error.message || 'Could not close the chat. Use Stop now to release audio.');});
}
el('auto-end').onclick = endChat;
el('auto-stop').onclick = () => { generation++; pendingPaste = null; pendingEnqueue = false; clearPassword(); controller.stop(); render(); };
el('header-stop').onclick = () => { if(chatRun && state.connected && !state.closing)endChat();else el('auto-stop').click(); };
el('header-abort').onclick = () => el('auto-stop').click();
el('auto-clear').onclick = clearReceived;
el('chat-clear').onclick = () => { if (!awaitingReceipts() && !pendingEnqueue) { clearHistory(); clearReceived(); render(); } };
el('auto-copy').onclick = () => {
  if (!received) return;
  if (!navigator.clipboard?.writeText) { note('Clipboard access needs HTTPS or localhost and a supported browser.'); return; }
  const message = received;
  navigator.clipboard.writeText(message.text).then(() => {
    if (received === message && message.type === 'password') clearReceived();
    note('Copied. Paste on this device when ready. Your system clipboard may retain or sync the copy.');
  }, () => note('Clipboard access was denied. Allow clipboard access and tap Copy again.'));
};
el('auto-paste').onclick = () => {
  if (state.active || pendingPaste || mode !== 'password') return;
  passwordSendIntent = true;
  if (!navigator.clipboard?.readText) {
    passwordNotice = 'Use your device’s Paste command in the password field, or choose Receive instead.';
    render(); el('auto-password').focus(); return;
  }
  const request = {generation}; pendingPaste = request; passwordNotice = ''; render();
  const current = () => pendingPaste === request && request.generation === generation && !state.active && mode === 'password' && !document.hidden;
  const denied = () => {
    if (!current()) return;
    pendingPaste = null;
    passwordNotice = 'Clipboard reading was denied. Paste in the password field to send, or choose Receive instead.';
    render(); el('auto-password').focus();
  };
  try {
    Promise.resolve(navigator.clipboard.readText()).then(text => {
      if (!current()) return;
      pendingPaste = null; el('auto-password').value = text;
      passwordNotice = text ? '' : 'The clipboard is empty. Paste or enter a password to send, or choose Receive instead.';
      render();
    }, denied);
  } catch { denied(); }
};
el('receive-instead').onclick = () => {
  if (state.active || pendingPaste) return;
  el('auto-text').value = ''; el('auto-password').value = '';
  passwordSendIntent = false; passwordNotice = ''; render();
};
function passwordChanged() {
  if (el('auto-password').value) passwordSendIntent = true;
  passwordNotice = '';
  render();
}
for (const id of ['auto-text','verify-peer','audio-profile','crypto-profile','chat-enabled','peer-idle-timeout']) el(id).oninput = render;
el('peer-idle-timeout').onchange = render;
el('audio-profile').onchange = render;
el('crypto-profile').onchange = render;
el('mode-advanced').onclick = () => {
  if (pendingPaste || advanced) return;
  if (!state.active) {
    clearPassword();
    if (received?.type === 'password') clearReceived();
  }
  advanced = true;
  renderTabChange();
};
el('mode-showcase').onclick = () => {
  if (state.active || pendingPaste) return;
  window.location.assign(new URL('./pki-demo.html',window.location.href));
};
el('auto-text').onchange = render;
el('auto-text').oninput = () => { chatNotice = ''; render(); };
el('auto-password').oninput = passwordChanged;
el('auto-password').onchange = passwordChanged;
document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => {
  if ((state.active && (chatRun || state.phase !== 'received') && button.dataset.mode !== mode) || pendingPaste) return;
  if (button.dataset.mode === mode) { advanced = false; renderTabChange(); return; }
  advanced = false;
  generation++; pendingPaste = null; pendingEnqueue = false; clearPassword(); el('auto-text').value = ''; controller.stop(); mode = button.dataset.mode; chatRun = false;
  passwordSendIntent = false; passwordNotice = '';
  state = {phase:'idle',active:false,fingerprint:'',role:null,status:'',metrics:state.metrics,chatStats:state.chatStats,close:state.close}; clearReceived(); renderTabChange();
});
for (const link of document.querySelectorAll('#advanced-options a[data-leaves-session]')) link.onclick = event => {
  if (state.active) { event.preventDefault(); note('End this session before opening a different tool.'); }
};
el('mode-advanced').closest('.mode-tabs').onkeydown = event => {
  const tabs = [...document.querySelectorAll('.mode-tabs [role="tab"]')];
  const current = tabs.indexOf(event.target);
  if (current < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  if (!tabs[next].disabled) { tabs[next].focus(); tabs[next].click(); }
};
function hide() { generation++; pendingPaste = null; pendingEnqueue = false; el('auto-text').value = ''; clearPassword(); controller.stop(); audioVisuals?.clear(); clearReceived(); clearHistory(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
window.addEventListener('pagehide', hide);
function emptyDrafts() {
  if (state.active) return;
  // Browsers may restore form values when navigating back. A newly shown page
  // starts as a receiver until the user explicitly enters something to send.
  el('auto-text').value = ''; el('auto-password').value = '';
  passwordSendIntent = false; passwordNotice = '';
  render();
}
window.addEventListener('pageshow', emptyDrafts);
const requestedView = new URLSearchParams(window.location.search);
if (['message','password','clear'].includes(requestedView.get('mode'))) mode = requestedView.get('mode');
if (requestedView.get('advanced') === '1') advanced = true;
notifyAgent = installAutomationObserver(agentSnapshot);
appView = createAppView({document,onChange:() => { renderAgentView(); notifyAgent(); }});
audioVisuals = createAudioVisuals(el('audio-visuals'), {
  readFrame: () => controller.readAudioVisuals(),
  getProfile: () => el('audio-profile').value,
  getActive: () => Boolean(state.active && state.phase !== 'starting'),
  onChange: () => { renderAgentView(); notifyAgent(); },
});
sectionNavigation = createSectionNavigation({
  nav:el('section-nav'),toggle:el('section-toggle'),close:el('section-close'),header:el('site-header'),
  onChange:() => { renderAgentView(); notifyAgent(); },
});
el('agent-inspect').onclick = () => { el('agent-state').hidden = !el('agent-state').hidden; renderAgentView(); notifyAgent(); };
document.addEventListener('toggle',event=>{
  if (event.target.tagName === 'DETAILS') { renderAgentView(); notifyAgent(); }
},true);
emptyDrafts();
render();
// This capability probe opens no media and retains no keys. Unsupported
// browsers keep Compatible available; a selected Compact option never falls
// back silently when Start is pressed.
checkCryptoProfile('x25519').then(() => { compactSupport = 'supported'; render(); }, error => {
  compactSupport = 'unsupported'; compactError = error.message || 'Compact key exchange is unavailable. Choose Compatible on both devices.'; render();
});
if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) { el('auto-start').disabled = true; note('Open the app over HTTPS or localhost to use microphone and encryption.'); }
