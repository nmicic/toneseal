// Copyright (c) 2026 Nenad Micic
// SPDX-License-Identifier: Apache-2.0
import {AudioLink} from './audio-link.mjs';
import {AudioSession, isProtocolPacket} from './session.mjs';
import {textPayload, payloadText} from './communication-codec.mjs';
import {installPlaybackHints} from './audio-environment.mjs';
installPlaybackHints();
const el = id => document.getElementById(id);
const session = new AudioSession();
let mode = 'message', accepting = false, working = false, generation = 0;
let received = null, secretTimer, idleTimer, pendingLabel = '', confirmationPlayed = false;
let processing = false, mustPlayControl = false;
let confirmationPacket = null, confirmationFingerprint = '', nextAction = null;
let packetPlayed = false;
let incoming = Promise.resolve();
const status = text => { el('status').textContent = text; };
const link = new AudioLink({onError(error) { status(error.message); render(); }, onStatus(text) { status(text); render(); }, onPackets(packets) {
  const token = generation;
  incoming = incoming.then(async () => {
    if (token !== generation) return;
    processing = true; render();
    try {
    if (!packets.length) { status('No packet recovered. Try a quieter room, move closer, and replay the prepared packet.'); return; }
    for (const packet of packets) {
      if (token !== generation) return;
      try { await receive(packet, token); } catch (error) { status('Packet refused: ' + error.message); }
    }
    } finally { processing = false; render(); }
  }).catch(error => status(error.message));
  return incoming;
}});
function activity() { clearTimeout(idleTimer); if (session.info.state !== 'idle') idleTimer = setTimeout(() => disconnect('Session expired after five minutes without activity. Pair again.'), 300000); }
function clearReceived() {
  clearTimeout(secretTimer); received = null; el('received-text').textContent = ''; el('received-secret').value = '';
  el('received-kind').textContent = 'THIS SESSION ONLY'; render();
}
function disconnect(message = 'Disconnected. Session keys and received content were dropped.') {
  generation++; working = false; accepting = false; confirmationPlayed = false; mustPlayControl = false; pendingLabel = '';
  confirmationPacket = null;
  confirmationFingerprint = '';
  packetPlayed = false;
  link.clear(); session.reset(); clearTimeout(idleTimer); el('password').value = ''; clearReceived(); status(message); render();
}
function render() {
  const info = session.info, secure = mode !== 'clear', ready = info.state === 'ready' && confirmationPlayed && !mustPlayControl;
  const busy = working || processing || link.busy || link.playing || link.recording;
  el('connection-badge').textContent = !secure ? 'CLEARTEXT' : ready ? 'READY TO SEND'
    : info.localConfirmed && !confirmationPlayed ? 'SEND CONFIRMATION'
    : info.state === 'ready' && mustPlayControl ? pendingLabel === 'Delivery receipt' ? 'SEND RECEIPT' : 'SEND RESPONSE'
    : info.state === 'idle' ? accepting ? 'LISTEN FOR OFFER' : 'NOT PAIRED'
    : info.state === 'verify' ? info.localConfirmed ? 'WAITING FOR PEER' : 'COMPARE SCREENS' : info.state.toUpperCase();
  el('fingerprint-panel').hidden = !secure || !info.fingerprint || info.state === 'rekeying' || (info.state === 'ready' && confirmationPlayed);
  el('fingerprint').textContent = info.fingerprint || '';
  el('confirm-peer').disabled = busy || mustPlayControl || info.localConfirmed || info.state !== 'verify';
  el('confirm-peer').textContent = info.localConfirmed ? 'Confirmed here · exchange confirmations' : 'All groups match · confirm peer';
  el('restore-confirmation').hidden = !secure || !info.localConfirmed || !confirmationPacket || info.state === 'rekeying' || info.fingerprint !== confirmationFingerprint;
  el('restore-confirmation').disabled = busy;
  el('start-pair').disabled = !secure || busy || info.state !== 'idle' || accepting;
  el('answer-pair').disabled = !secure || busy || info.state !== 'idle' || accepting;
  el('role-choices').hidden = !secure || info.state !== 'idle' || accepting;
  el('choose-device1').disabled = el('start-pair').disabled;
  el('choose-device2').disabled = el('answer-pair').disabled;
  el('disconnect').disabled = info.state === 'idle' && !accepting;
  el('rekey').disabled = busy || (info.state !== 'rekeying' && (!ready || Boolean(info.pendingCount)));
  el('rekey').textContent = info.state === 'rekeying' ? 'Resume key refresh' : 'Refresh session keys';
  const value = mode === 'password' ? el('password').value : el('message').value;
  const count = new TextEncoder().encode(value).length, limit = secure ? 96 : 127;
  el('byte-count').textContent = `${count} / ${limit} UTF-8 bytes`;
  el('prepare-message').disabled = busy || (secure && !ready) || !count || count > limit;
  el('prepare-message').textContent = mode === 'clear' ? 'Prepare cleartext message' : mode === 'password' ? 'Prepare encrypted password' : 'Prepare encrypted message';
  let reason;
  if (link.recording) reason = 'Listening: wait for the sound to end, then tap Stop & decode before preparing a message.';
  else if (link.playing) reason = 'Audio is playing. Wait until playback finishes.';
  else if (busy) reason = 'Preparing or decoding audio. Wait for this operation to finish.';
  else if (secure && !ready) reason = !info.fingerprint ? 'Sending is locked: exchange the pairing offer and answer first (timeline steps 1–2). You can type a draft now.'
    : info.state === 'rekeying' ? 'Sending is paused while refreshing keys. Complete the response exchanges or Resume key refresh.'
    : !info.localConfirmed ? 'Sending is locked: compare both fingerprints, tap Confirm here, then play your confirmation (steps 3–4).'
    : !confirmationPlayed ? 'Sending is locked: your confirmation still needs playback. Confirm alone does not send it (steps 3–4).'
    : !info.peerConfirmed ? 'Sending is locked: tap Listen here, receive the other device’s confirmation, then Stop & decode (steps 3–4).'
    : 'Sending is paused: play the prepared receipt or session response first.';
  else if (!count) reason = `${secure ? 'Pairing is complete. ' : ''}Type ${mode === 'password' ? 'or paste a password' : 'a message, for example Hello,'} above to enable Prepare.`;
  else if (count > limit) reason = `The message is too long: ${count} UTF-8 bytes. Shorten it to ${limit} bytes or fewer.`;
  else reason = secure ? 'Ready. Prepare makes encrypted audio; then the other device taps Listen and you tap Play packet.' : 'Ready. Prepare makes cleartext audio; then the other device taps Listen and you tap Play packet. Anyone nearby can read it.';
  el('compose-hint').textContent = reason;
  el('compose-hint').dataset.locked = String(el('prepare-message').disabled);
  el('play').disabled = busy || !link.prepared;
  el('retry').disabled = busy || mode === 'clear' || info.state === 'idle';
  el('retry-pending').disabled = busy || !info.pendingCount;
  el('retry-pending').textContent = info.pendingCount ? `Resend unacknowledged (${info.pendingCount})` : 'Resend unacknowledged';
  el('delivery-status').textContent = info.pendingCount ? `${info.pendingCount} encrypted message(s) awaiting receipt. Listen for the peer’s acknowledgment or resend.` : info.lastDelivery?.status === 'delivered' ? 'Delivery confirmed by an authenticated receipt from the peer.' : 'No encrypted message awaiting acknowledgment.';
  el('listen').disabled = busy;
  el('finish').hidden = !link.recording;
  el('finish').disabled = !link.recording;
  el('message').hidden = mode === 'password'; el('password').hidden = mode !== 'password'; el('paste').hidden = mode !== 'password';
  el('compose-title').textContent = mode === 'password' ? 'Transfer a password' : 'Write your message';
  el('compose-label').textContent = mode === 'password' ? 'PASSWORD TO SEND' : 'MESSAGE TO SEND';
  el('compose-label').htmlFor = mode === 'password' ? 'password' : 'message';
  el('empty-received').hidden = Boolean(received);
  el('received-text').hidden = !received || received.type === 'password';
  el('received-secret').hidden = !received || received.type !== 'password';
  el('received-secret-label').hidden = !received || received.type !== 'password';
  el('secret-note').hidden = !received || received.type !== 'password';
  el('copy-received').disabled = !received; el('clear-received').disabled = !received;
  el('encrypted-timeline').hidden = !secure;
  el('clear-timeline').hidden = secure;
  renderNext(info, ready, busy, count, limit);
  document.querySelectorAll('[data-mode]').forEach(button => { const active = button.dataset.mode === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
}

// Only describe local evidence. Playback does not prove that the peer received it.
function renderNext(info, ready, busy, count, limit) {
  const device = info.role === 'initiator' ? 'Device 1' : info.role === 'responder' || accepting ? 'Device 2' : 'This device';
  const peer = device === 'Device 1' ? 'Device 2' : device === 'Device 2' ? 'Device 1' : 'the other device';
  el('device-role').textContent = mode === 'clear' ? 'CLEARTEXT · NO PAIRING' : device === 'This device' ? 'CHOOSE YOUR DEVICE BELOW' : `THIS IS ${device.toUpperCase()}`;
  let title, instruction, action = null, label;
  if (link.recording) {
    title = `${device}: listening`;
    instruction = `${peer} taps Play packet now. Wait for the sound to finish, then tap Stop & decode here. Listening does not decode until you stop (or the 20-second limit ends).`;
    action = 'finish'; label = 'Sound finished · Stop & decode';
  } else if (link.playing) {
    title = `${device}: playing ${pendingLabel.toLowerCase()}`;
    instruction = `${peer} must be listening. After the sound ends, tap Stop & decode on that device.`;
  } else if (busy) {
    title = `${device}: working`;
    instruction = 'Wait for audio preparation or decoding to finish. The next action will appear here.';
  } else if (info.localConfirmed && !confirmationPlayed && confirmationPacket && (pendingLabel !== 'Peer confirmation' || !link.prepared)) {
    title = `${device}: restore your confirmation`;
    instruction = `Your confirmation has not finished playing. Restore it, have ${peer} tap Listen, then Play packet here. Your peer’s confirmation cannot replace yours.`;
    action = 'restore-confirmation'; label = 'Restore my confirmation';
  } else if (mustPlayControl) {
    title = `${device}: send ${pendingLabel.toLowerCase() || 'the prepared response'}`;
    instruction = `${peer}: tap Listen first. ${device}: ${link.prepared ? 'tap Play packet' : 'restore the packet, then tap Play packet'}. After the sound, ${peer} taps Stop & decode. Preparing this packet did not send it.`;
    action = link.prepared ? 'play' : 'retry'; label = link.prepared ? `Play ${pendingLabel.toLowerCase()}` : 'Restore last packet';
  } else if (mode !== 'clear' && info.state === 'idle') {
    title = accepting ? 'Device 2: listen for the offer' : 'First, choose Device 1 and Device 2';
    instruction = accepting ? 'Tap Listen here. Device 1 then taps Play packet. When the sound ends, tap Stop & decode here.' : 'On Device 1 tap Start pairing. On Device 2 tap Answer pairing. Keep the same roles throughout the timeline below.';
    if (accepting) { action = 'listen'; label = 'Listen for Device 1'; }
  } else if (mode !== 'clear' && info.state === 'offering') {
    title = 'Device 1: receive the answer';
    instruction = 'After Device 2 stops and decodes your offer, it prepares an answer. Tap Listen here first; Device 2 then plays that answer. After the sound, Stop & decode here (step 2).';
    action = 'listen'; label = 'Listen for Device 2';
  } else if (mode !== 'clear' && info.state === 'rekeying') {
    title = `${device}: receive the key-refresh response`;
    instruction = `Tap Listen here, then ${peer} plays its prepared response. Stop & decode after the sound. Use Resume key refresh if a response was lost.`;
    action = 'listen'; label = 'Listen for response';
  } else if (mode !== 'clear' && !info.localConfirmed) {
    title = 'Both devices: compare every fingerprint group';
    instruction = `Both screens must show the same eight groups. If all match, Confirm on each device. That prepares two confirmations: play Device 1’s to Device 2, then Device 2’s to Device 1 (steps 3–4).`;
    action = 'confirm-peer'; label = 'All groups match · confirm here';
  } else if (mode !== 'clear' && !info.peerConfirmed) {
    title = `${device}: receive ${peer}’s confirmation`;
    instruction = `Your confirmation has played. Tap Listen here; ${peer} must Confirm and Play packet. After the sound, Stop & decode here. Sending stays locked until this is received.`;
    action = 'listen'; label = `Listen for ${peer}`;
  } else if (info.pendingCount && (packetPlayed || !link.prepared)) {
    title = `${device}: wait for a delivery receipt`;
    instruction = `${peer} should play its prepared receipt while you listen. If the message was missed, choose Resend unacknowledged.`;
    action = 'listen'; label = 'Listen for receipt';
  } else if (link.prepared && !packetPlayed && ['Encrypted message', 'Encrypted password', 'Encrypted retransmission', 'Cleartext message'].includes(pendingLabel)) {
    title = 'Your message audio is prepared';
    instruction = `${peer}: tap Listen first. Then Play packet here. After the sound ends, the other device taps Stop & decode and checks Received. ${mode === 'clear' ? '' : 'It then plays a delivery receipt back.'}`;
    action = 'play'; label = 'Play prepared message';
  } else {
    title = mode === 'clear' ? 'Device 1: type a cleartext test message' : `${device}: ready to send`;
    instruction = count ? 'Prepare the message here. Then the receiving device taps Listen, you Play packet, and it taps Stop & decode.' : 'Type Hello in Write your message below. Prepare becomes available when the input is not empty. If you are receiving instead, tap Listen.';
    action = count && count <= limit ? 'prepare-message' : mode === 'password' ? 'password' : 'message'; label = count && count <= limit ? 'Prepare message' : mode === 'password' ? 'Enter a password' : 'Write a message';
  }
  el('next-title').textContent = title;
  el('next-instruction').textContent = instruction;
  el('next-fingerprint').hidden = mode === 'clear' || !info.fingerprint || info.localConfirmed || busy || mustPlayControl;
  el('next-fingerprint').textContent = info.fingerprint || '';
  nextAction = action;
  el('next-action').hidden = !action;
  el('next-action').disabled = !action || el(action).disabled;
  el('next-action').textContent = label || 'Next action';
}
async function run(task) {
  if (working || processing) return;
  const token = generation; working = true; render();
  try { await task(token); if (token === generation) activity(); }
  catch (error) { if (token === generation) status(error.message || 'The operation did not finish.'); }
  finally { if (token === generation) { working = false; render(); } }
}
async function preparePacket(packet, label, instruction, token = generation, control = true) {
  if (token !== generation) return;
  pendingLabel = label; mustPlayControl = control; packetPlayed = false;
  const result = await link.prepare(packet);
  if (token !== generation) return;
  el('packet-info').textContent = `${label} · ${packet.length} bytes · ${result.seconds.toFixed(2)} seconds. Replay this packet if reception fails.`;
  status(instruction); render();
}
function displayReceived(type, text) {
  clearReceived(); received = {type, text};
  if (type === 'password') { el('received-secret').value = text; secretTimer = setTimeout(clearReceived, 60000); }
  else el('received-text').textContent = text;
  el('received-kind').textContent = type === 'password' ? 'ENCRYPTED PASSWORD' : type === 'clear' ? 'UNAUTHENTICATED' : 'ENCRYPTED MESSAGE';
  render();
}
async function receive(packet, token) {
  if (mode === 'clear') {
    if (isProtocolPacket(packet)) { status('Encrypted session packet ignored in cleartext mode.'); return; }
    displayReceived('clear', payloadText(packet)); status('Cleartext received. Its sender is not authenticated.'); return;
  }
  if (!isProtocolPacket(packet)) { status('Cleartext ignored. This screen accepts paired encrypted messages.'); return; }
  if (session.info.state === 'idle' && !accepting) { status('Pairing offer ignored. Choose Answer pairing to accept a new peer.'); return; }
  const result = await session.receive(packet);
  if (token !== generation) return;
  activity();
  if (result.type === 'offer') accepting = false;
  if (result.type === 'message' || result.type === 'password') {
    displayReceived(result.type, result.text);
    status(result.type === 'password' ? 'Encrypted password received. Tap Copy, then paste it where you need it.' : 'Encrypted message received from your verified peer.');
  } else if (result.type === 'ack') status('Authenticated receipt received. Delivery status updated.');
  else if (result.type === 'answer') status('Compare every fingerprint group on both screens, then confirm on each device.');
  else if (result.type === 'ready') status(session.info.state === 'ready' ? 'Peer confirmed. Complete your confirmation playback, then send a message.' : 'Peer confirmed. Compare the fingerprint and confirm here too.');
  else if (result.type === 'duplicate') status('Repeated packet ignored; nothing was delivered twice.');
  if (result.outbound) {
    const receipt = result.receipt === true;
    await preparePacket(result.outbound, receipt ? 'Delivery receipt' : result.type === 'offer' ? 'Pairing answer' : 'Session control',
      receipt ? 'Message accepted. Delivery receipt prepared: have the sender Listen, then tap Play packet to acknowledge. Repeats are not delivered twice.' : result.type === 'offer' ? 'Answer prepared. The first device should Listen; tap Play packet here. Then compare both screens.' : 'Session control prepared. The other device should Listen; tap Play packet to continue.', token);
  }
}
el('choose-device1').onclick = () => el('start-pair').click();
el('choose-device2').onclick = () => el('answer-pair').click();
el('start-pair').onclick = () => run(async token => {
  confirmationPlayed = false;
  await preparePacket(await session.offer(), 'Pairing offer', 'Offer prepared. Choose Answer pairing and Listen on the second device, then tap Play packet here.', token);
});
el('answer-pair').onclick = () => { accepting = true; status('Ready for one peer. Tap Listen, then play the pairing offer on the first device.'); render(); };
el('confirm-peer').onclick = () => run(async token => {
  pendingLabel = 'Peer confirmation'; mustPlayControl = true;
  const packet = await session.confirm();
  confirmationPacket = packet.slice();
  confirmationFingerprint = session.info.fingerprint;
  await preparePacket(packet, 'Peer confirmation', 'Confirmation prepared. The other device should Listen; play this packet, then receive its confirmation.', token);
});
el('restore-confirmation').onclick = () => run(async token => {
  if (!confirmationPacket || !session.info.localConfirmed || session.info.state === 'rekeying' || session.info.fingerprint !== confirmationFingerprint) return;
  await preparePacket(confirmationPacket, 'Peer confirmation', 'Your original confirmation is restored. The other device taps Listen, then you Play packet. It stops and decodes after the sound.', token);
});
el('next-action').onclick = () => {
  if (!nextAction) return;
  const target = el(nextAction);
  if (target.disabled) return;
  if (nextAction === 'message' || nextAction === 'password') { target.scrollIntoView({block: 'center', behavior: 'smooth'}); target.focus({preventScroll: true}); }
  else target.click();
};
el('rekey').onclick = () => run(async token => {
  await preparePacket(await session.rekey(), 'Key refresh', 'Fresh key exchange prepared inside the current encrypted session. Have the peer Listen, then play. Follow each response until both show PAIRED.', token);
});
el('disconnect').onclick = () => disconnect();
el('prepare-message').onclick = () => run(async token => {
  const value = mode === 'password' ? el('password').value : el('message').value;
  const packet = mode === 'clear' ? textPayload(value) : await session.send(mode, value);
  if (mode === 'password') el('password').value = '';
  await preparePacket(packet, mode === 'clear' ? 'Cleartext message' : mode === 'password' ? 'Encrypted password' : 'Encrypted message',
    'Packet prepared. Tap Listen on the receiving device, then Play packet here. Check the receiving screen to confirm delivery.', token, false);
});
el('play').onclick = () => run(async token => {
  link.volume = 1;
  await link.play();
  if (token === generation) {
    if (pendingLabel === 'Peer confirmation') confirmationPlayed = true;
    packetPlayed = true;
    mustPlayControl = false;
    status('Playback finished. Have the peer stop and decode, then follow its next instruction.');
  }
});
el('retry').onclick = () => run(async token => {
  await preparePacket(session.retry(), pendingLabel || 'Session packet', 'Packet restored. Have the other device Listen, then tap Play packet.', token, mustPlayControl);
});
el('retry-pending').onclick = () => run(async token => {
  await preparePacket(session.retryPending(), 'Encrypted retransmission', 'Exact encrypted packet restored. Have the peer Listen, play it, then receive the peer’s receipt.', token, false);
});
el('listen').onclick = () => run(() => link.listen());
el('finish').onclick = () => run(() => link.finish());
el('cancel').onclick = () => { generation++; working = false; link.cancel(); status('Audio stopped. You can replay the prepared packet or listen again.'); render(); };
el('clear-received').onclick = clearReceived;
el('copy-received').onclick = () => {
  if (!received) return;
  if (!navigator.clipboard?.writeText) { status('Clipboard access is unavailable. Use HTTPS or localhost in a supported browser.'); return; }
  const item = received;
  navigator.clipboard.writeText(item.text).then(() => { if (received === item && item.type === 'password') clearReceived(); status('Copied. Paste on this device when ready. The system clipboard may retain or sync this content.'); }, () => status('Clipboard access was denied. Allow clipboard access for this page, then tap Copy again.'));
};
el('paste').onclick = () => {
  if (!navigator.clipboard?.readText) { status('Use your keyboard’s Paste command in the password field.'); el('password').focus(); return; }
  const token = generation;
  navigator.clipboard.readText().then(text => { if (token === generation && mode === 'password' && !document.hidden) { el('password').value = text; render(); } }, () => { status('Clipboard read was denied. Tap the password field and use Paste.'); el('password').focus(); });
};
for (const id of ['message', 'password']) el(id).oninput = render;
document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => {
  const next = button.dataset.mode;
  if (next === mode) return;
  if (next === 'clear' || mode === 'clear') disconnect('Mode changed. Start a new pairing for encrypted transfers.');
  else { generation++; working = false; link.clear(); }
  mode = next; el('password').value = ''; clearReceived();
  el('packet-info').textContent = 'Nothing is listening or playing.';
  el('mode-note').textContent = next === 'clear' ? 'Open audio messages. No encryption or sender authentication.' : next === 'password' ? 'Encrypted delivery to a masked field. Copy only when you are ready to paste.' : 'Encrypted device to device. Verify your peer before sending.';
  render();
});
function hide() { generation++; working = false; link.clear(); el('password').value = ''; clearReceived(); el('packet-info').textContent = 'Prepared audio cleared while page is hidden.'; status('Audio paused and password fields cleared. Session keys stay in memory for up to five idle minutes.'); render(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
window.addEventListener('pagehide', () => disconnect());
if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) status('Open this page over HTTPS or localhost to use microphone and encryption.');
render();
