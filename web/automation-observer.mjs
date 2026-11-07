// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
// Read-only observations of the same UI an operator can use. No control API,
// plaintext, clipboard access, network transport, or key material lives here.
export const AGENT_SCHEMA_VERSION = 1;
const controls = [
  ['message','mode-message','click','Choose encrypted Message / chat'],
  ['password','mode-password','click','Choose a single encrypted password transfer'],
  ['clear','mode-clear','click','Choose an unencrypted single transfer'],
  ['advanced','mode-advanced','click','Open settings and the agent guide'],
  ['experience','experience-toggle','click','Switch between compact App view and detailed Web view without ending the session'],
  ['transferOptions','app-options','click','Show or hide verification and audio connection options in App view'],
  ['connectionDetails','app-status-details','click','Show or hide connection diagnostics and the optional session fingerprint'],
  ['sections','section-toggle','click','Open or close the compact page-section menu'],
  ['closeSections','section-close','click','Close the page-section menu'],
  ['draft','auto-text','fill','Write a message; leave empty to receive initially'],
  ['passwordDraft','auto-password','fill','Enter the password on the sender only'],
  ['start','auto-start','click','Start a transfer, or enqueue a connected chat reply'],
  ['endChat','auto-end','click','Drain queued messages and request authenticated closure on both devices'],
  ['stop','auto-stop','click','Immediately stop local audio and release keys; peer closure may remain unconfirmed'],
  ['confirm','auto-confirm','click','Confirm only after an independent fingerprint comparison'],
  ['receiveInstead','receive-instead','click','Discard the draft and choose the initial receiving role'],
  ['audioProfile','audio-profile','select','Choose the same audio profile on both devices'],
  ['verifyPeer','verify-peer','check','Require comparison before the first message'],
  ['cryptoProfile','crypto-profile','select','Choose the same key exchange on both devices'],
  ['chatEnabled','chat-enabled','check','Choose persistent chat or one-message mode on both devices'],
  ['peerIdleTimeout','peer-idle-timeout','select','Choose how long to wait without valid peer progress before stopping local audio'],
  ['transferNext','transfer-next','click','Jump to fingerprint confirmation or the received item'],
  ['example','auto-example','click','Immediately start sending a timestamped example'],
  ['paste','auto-paste','click','Read this device’s clipboard into the password field'],
  ['copyReceived','auto-copy','click','Write the received item to this device’s clipboard'],
  ['clearReceived','auto-clear','click','Clear the received item'],
  ['clearConversation','chat-clear','click','Clear local conversation after pending receipts settle'],
  ['conversation','chat-jump','click','Scroll to the conversation'],
  ['latestMessage','chat-latest','click','Return to the newest message after reading earlier chat'],
  ['reply','chat-reply','click','Scroll to the reply composer'],
  ['diagnostics','link-diagnostics-toggle','click','Expand or collapse link diagnostics'],
  ['transferHelp','transfer-help-toggle','click','Expand or collapse the transfer instructions'],
  ['trustHelp','trust-help-toggle','click','Expand or collapse the trust explanation'],
  ['modemHelp','modem-guide-toggle','click','Expand or collapse About ToneSeal: how bytes become sound'],
  ['audioTones','audio-view-tones','click','Show recent tone frequencies in the live audio dock'],
  ['audioScope','audio-view-scope','click','Show the live audio waveform'],
  ['audioSpectrum','audio-view-spectrum','click','Show the live frequency spectrum'],
  ['audioPeaks','audio-view-peaks','click','Show separate microphone and playback peak levels'],
  ['audioVisualCollapse','audio-visual-collapse','click','Collapse or expand the live audio dock'],
  ['agentGuide','agent-guide-toggle','click','Expand or collapse the agent operation guide'],
  ['inspectState','agent-inspect','click','Show or hide the local metadata snapshot'],
  ['manual','manual-tool','click','Leave this page for manual pairing'],
  ['legacy','clear-tool','click','Leave this page for the original cleartext experiment'],
  ['guideJson','agent-guide-json','click','Open the machine-readable guide; read via fetch during an active session'],
  ['showcase','mode-showcase','click','Leave this page for the public-artifact showcase'],
];
const visible = node => {
  if (!node?.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return false;
  for (let parent=node.parentElement;parent;parent=parent.parentElement) {
    if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(node)) return false;
  }
  return true;
};
export function observeActions(document, reasons = {}, bindings = {}) {
  const copyActions = [...document.querySelectorAll('#chat-history button[id]')].map(node=>[node.id,node.id,'click','Copy this message to this device’s clipboard']);
  const sectionActions = [...document.querySelectorAll('#section-links a[id]')].map(node=>[node.id,node.id,'click','Navigate to this page section without starting audio, sending or confirming anything']);
  return [...controls,...sectionActions,...copyActions].map(([id,defaultElement,operation,description]) => {
    const element = bindings[id] || defaultElement;
    const node = document.getElementById(element), shown = visible(node), enabled = Boolean(node && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
    return {id,selector:`#${element}`,operation,description,
      label:node?.getAttribute('aria-label') || (node?.labels?.length ? [...node.labels].map(label=>label.textContent.trim()).join(' ') : node?.textContent.trim()) || description,
      visible:shown,enabled,available:shown && enabled,
      unavailableReason:!shown ? element.startsWith('audio-view-') ? 'Expand the live audio dock to choose a view.' : node?.closest('#transfer-options') && !node.closest('#transfer-options').open ? 'Open Options in App view to access this setting.' : node?.closest('#status-details') && !node.closest('#status-details').open ? 'Open Details in App view to inspect the connection.' : 'Open the relevant tab or wait for the required session phase.' : !enabled ? reasons[id] || 'Unavailable in the current session phase; inspect the status and input hint.' : null,
      ...(node?.type === 'checkbox' ? {checked:node.checked} : {}),
      ...(node?.tagName === 'SELECT' ? {value:node.value,options:[...node.options].map(option=>({value:option.value,label:option.text,enabled:!option.disabled}))} : {})};
  });
}

export function installAutomationObserver(readState, target = window) {
  let revision = 0, notificationPending = false;
  const getState = () => ({schemaVersion:AGENT_SCHEMA_VERSION,revision,...readState()});
  Object.defineProperty(target,'tonesealAgent',{value:Object.freeze({schemaVersion:AGENT_SCHEMA_VERSION,getState}),writable:false,configurable:false});
  return () => {
    revision++;
    if (notificationPending) return;
    notificationPending = true;
    queueMicrotask(() => {
      notificationPending = false;
      // The event is a wake-up signal; consumers read a fresh detached snapshot.
      target.dispatchEvent(new CustomEvent('toneseal:state',{detail:{schemaVersion:AGENT_SCHEMA_VERSION,revision}}));
    });
  };
}
