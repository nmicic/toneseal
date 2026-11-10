# Automatic transfer

The default page handles listening, playback, decoding, key exchange, fresh
session-key negotiation, retransmission, and delivery receipts. You do not need
to press Prepare, Play, Listen, or Stop & decode for each packet.

## Start a Message conversation

1. Open the same current app URL on both devices and select **Message**. Leave
   **Audio connection** at **Nearby · faster** for devices in the same room;
   both devices must use the same connection option.
2. On the sending device, write a short message. Leave the receiving device's
   input empty. The page labels the role automatically.
3. Press **Start receiving** on the empty device and **Start sending** on the
   sending device, then allow microphone access. Either device can start first;
   the sender retries while waiting for the receiver.
4. Leave the pages visible and unlocked while the devices exchange sound.
5. The message appears on the receiving device. The sender's conversation entry
   is marked delivered after an encrypted receipt. Keep the connection open and
   use Send to continue from either device.

Only one device should have text entered for the initial Start. **Receive instead** clears a draft
and selects the receiving role. Inputs start empty and clear after sending or
changing modes, so the previous message does not make the next run a sender.
**Send example** fills and starts a fresh message containing the current time;
press it only on the sending device. Nothing is prefilled automatically.

If both devices have text, both try to send. If either hears the other's initial
packet, it reports that both devices are sending. Simultaneous playback may
prevent either device from hearing that packet. Stop both, choose Receive
instead on the receiving device, and start again. If both inputs are empty,
both devices wait to receive.

Every encrypted message is limited to 96 UTF-8 bytes. Several bytes may be
needed for one Unicode character. A fresh Start creates a new session; Message
then reuses it for chat. Pairing is not saved between runs. To use the original
one-message flow, turn off continuation in Advanced on both devices.

## Audio connection

**Nearby · faster** is the default audio connection. **Telephone · slow
(experimental)** is an explicit option for relaying sound through a call.
Select it on **both** devices before Start. The setting applies to Message,
Password, and Clear text. There is no automatic negotiation or fallback;
if the selections differ, stop both devices, choose the same option, and start
again.

Telephone uses 0.75 playback speed: the tone range becomes 450–2812.5 Hz and
symbols last 26.667 ms. Packet airtime increases by 33.3%; a maximum 128-byte
wire packet takes about 5.55 seconds instead of 4.16 seconds. Encryption and
the modem's packet format are unchanged. Retry waits account for the longer
packets, while turnaround pauses and echo guards remain physical elapsed time. Single
transfers are limited to three minutes, and chat connections to ten minutes.

**Near-ultrasonic · very slow (experimental)** uses 18.4–19.975 kHz tone centers
and 40 ms symbols. A maximum packet takes 8.32 seconds. Select it on both nearby
devices, keep them still, and test a dummy Clear text example first. It may be
inaudible, but speakers, microphone filters and loud-room clipping can prevent
reception. It is not a telephone-call profile or proof of peer identity. The
live Tones/Spectrum views show its actual high-frequency range. The default
idle timeout remains one minute; Advanced offers two minutes for extra repair
time after lost turns. Stop before changing the selection; there is no fallback.

For a first call test, use a laptop beside a speakerphone at each end of the
call. Each laptop uses its own microphone and speaker; the web app does not
capture another app's call audio on the phone. Keep the two ends far enough
apart that the laptops cannot hear one another directly. Start with dummy
Clear text messages before testing encrypted messages or dummy passwords.

The Telephone profile recovered all 36 test packets through each of the local
clean, telephone-bandpass, G.711 μ-law, and GSM full-rate simulations. This does
not establish actual call compatibility: AMR, handset processing, clock drift,
and other real-call effects remain untested. See [Telephone relay](TELEPHONE.md)
for the measured profile comparison and step-by-step call setup.

## Advanced key exchange

Select the **Advanced** tab, choose **Compact · X25519** on both devices, then
return to Message or Password before Start. Its shorter
public keys save 3.6 seconds of setup waveform airtime Nearby or 4.8 seconds with
Telephone. Compatible P-256 stays the default. Compact requires native browser
support, checked on the page and on both peers before a run; it never switches
to another algorithm automatically. Both retain AES-256-GCM and its full
authentication tag. See [key sizes](CRYPTO-PROFILES.md).

## Simple or Verify peer

**Simple** is fully automatic. Both devices show a fingerprint, but the app does
not wait for you to compare it. Traffic is encrypted, protecting its contents
from passive listeners. The peer is **not verified**: an active impostor can
intercept or substitute the initial key exchange. Automatic rekeying establishes
continuity with the connected peer; it does not independently establish that
peer's identity. Do not interpret an encrypted delivery receipt as a human
identity check.

Enable **Verify peer** on both devices when you want to check who is connected.
After Start, the app pauses at the fingerprints. Compare every group on the two
screens and press **Continue** on each device only if all groups match. The
remaining key confirmation, encrypted rekey, message, and receipt exchanges are
automatic. If the groups differ, press Stop on both devices.

The two devices should use the same option. A device with Verify peer selected
will wait for its own confirmation even if the other device uses Simple.

## Passwords

1. Select **Password** on both devices. Choose Verify peer for a real secret.
2. On the sending device, paste or enter the password. If you use **Paste from
   clipboard**, wait until reading finishes and the page says **SENDING DEVICE**.
3. On the receiving device, leave the field empty and press **Start receiving**.
4. On the sending device, press **Start sending**. Keep both pages visible.
5. If Verify peer is enabled, compare the fingerprints and press **Continue**
   on both devices. Otherwise, the exchange proceeds automatically.

Start is unavailable while a clipboard read is pending. If a password was
cleared when you left the page or pressed Stop, enter it again before sending.
The app remembers that this device intended to send, without retaining the
password. Choose **Receive instead** to explicitly switch that device to
receiving.

The receiver displays a masked password. Tap **Copy** explicitly. Wait until
the sender shows **Delivery confirmed** before switching the receiver to the
destination app and pasting; leaving the page stops its audio and may interrupt
a receipt that is still being sent. Receiving a password does not overwrite the clipboard
automatically. The sender's password field clears after Start; the received
field clears after copying, after 60 seconds, or when its page is hidden.
The operating system may keep or synchronize the clipboard independently.

## Cleartext

1. Select **Clear text** on both devices.
2. Leave the receiver's field empty and press **Start receiving**.
3. Enter text on the sender and press **Start sending**, or use **Send example**.
4. The receiver checks the message checksum, displays the text, and returns an
   acknowledgment tied to this transfer and its content.
5. The sender sends a final confirmation so the receiver can close its audio,
   then shows **Delivery confirmed**.

If the message or acknowledgment is lost, the sender retries the same packet.
The receiver acknowledges duplicates without displaying the message again. If
the final confirmation is lost, the receiver stops after its bounded listening
period and still reports the message as received.

This mode has no pairing or encryption. Its checksum and acknowledgment detect
transmission errors and confirm receipt, but do not authenticate a device or
prevent forged replies. The automatic cleartext limit is now 96 UTF-8 bytes to
leave room for the transfer ID and checksum. Both devices must use the updated
automatic page; the original cleartext experiment has a different wire format.

## Progress, retries, and stopping

The phase label reports finding a peer, verification when selected, session
confirmation, encrypted key refresh, sending, or receipt confirmation. No
message is transmitted until the selected verification policy is satisfied.

If a packet or receipt is missed, the sender repeats the same retained packet.
The receiver sends another receipt for a repeated message without displaying
that message twice. Audio is half duplex: a device ignores its own playback and
waits briefly before listening for the next response.

Each single-transfer run is bounded to three minutes. Its receiver listens for up to
one minute after receiving a message so it can resend a lost receipt; **Stop**
or selecting another mode ends that waiting period immediately. Wait for the
sender's delivery confirmation before starting the next transfer. A hidden
page, a lost microphone, or an audio interruption stops the run. Chat remains
connected for at most ten minutes and then requires a fresh Start. Return to both
pages and press Start again, re-entering a cleared password when sending.
Keep the devices close, use a comfortable volume, and test with dummy content
first. A successful synthetic audio test does not establish physical iPhone or
Android performance.

The application's **Playback level** is fixed at 100%, separately from the phone
or laptop's own volume. The app cannot set the device's system volume or
guarantee which physical speaker it uses.

On iPhone/iPad, use the volume buttons **after starting** the connection, while
the microphone is active. Select the desired system audio output before
starting; choose its speaker if the system offers that choice. If Control Center
hides the page during a session, return and restart both devices. Safari can change volume/routing when capture
begins; the app keeps a capture-compatible `play-and-record` session throughout
the run. Switching it to playback-only can interrupt the microphone. The web
app cannot reliably force the built-in loudspeaker or set iOS system volume.
See the [WebKit capture-volume report](https://bugs.webkit.org/show_bug.cgi?id=236219)
and [Audio Session discussion](https://www.w3.org/2026/10/30-mediawg-minutes.html).

During active capture/transfer/chat, the app requests a **screen wake lock** to
prevent automatic screen timeout on supported browsers, including Android.
Link diagnostics shows Screen awake: Active, Not granted, Unavailable or
Released by device. A denied/released lock does not abort the transfer; keep the
screen on manually or adjust the device timeout for the test. Power-saving
settings may deny it. Stop, timeout, error, page hiding and navigation release
the lock along with audio resources. It is not background operation: pressing
the lock button or switching away can still stop the session. See the
[Screen Wake Lock API](https://www.w3.org/TR/screen-wake-lock/).

The manual experiment is retained at `manual.html`, with its full
[Device 1 / Device 2 timeline](FIRST-TRANSFER.md). The original cleartext synth
experiment remains at `communication.html`.

## Browser audio behavior

Start opens one microphone stream and resumes one AudioContext directly from
the user interaction. The context remains open for subsequent automatic
playback. This follows the [Web Audio activation model](https://www.w3.org/TR/webaudio/#AudioContext)
and [Chrome's autoplay guidance](https://developer.chrome.com/blog/web-audio-autoplay).

The audio session remains `play-and-record` while the microphone is active;
switching it to a playback-only session can end capture tracks under the
[Audio Session specification](https://www.w3.org/TR/audio-session/#microphone-mediastreamtrack).
Neither API guarantees background execution or immunity to operating-system
interruptions.

## Continuing a Message conversation

Message uses chat continuation by default. Keep the four navigation tabs; chat
is the ongoing Message connection, rather than a separate fifth destination.
Password and Clear text retain their single-transfer flows.

1. On the receiving device, leave Message empty and press Start receiving.
2. On the initiating device, write the first message and press Start sending.
3. Allow microphone access on both. If Verify peer is enabled, compare the full
   fingerprint and Continue on both devices when requested.
4. After pairing and encrypted key refresh, both devices can queue messages.
   The first message and subsequent messages show delivery only after a matching
   encrypted bitmap receipt. Both people may type and send; the audio link takes
   turns for them.
5. If eight messages on this device await receipts, keep the draft until room
   opens. End chat on either device pauses new sends, drains queued messages
   and closes both peers through authenticated control turns. Stop now releases
   local audio immediately. Keep both pages visible until closing finishes;
   hiding the page stops immediately and clears history. The complete session,
   including closing, is limited to ten minutes.

The original sender controls the alternating audio turns even when the other
person sends most of the messages. An idle conversation emits occasional short
turn packets so the other device can send; idle polling backs off to reduce
sound. No new public keys are sent for each message. A fresh connection performs
new pairing and rekey.

Advanced provides the continuation setting for compatibility with the original
single-message experiment. Choose the same setting and key exchange on both
devices before Start. Chat and single-transfer Message use different wire/key
contexts, so they cannot silently mix. Two devices with initial drafts still
report a sender conflict; begin with one initial sender and one empty receiver.

Link diagnostics distinguish decoder CRC-rejected candidates from protocol
rejections and delivery retries. CRC failures do not provide a count of lost
messages: a weak or overlapping sound may never produce a candidate packet.
Numeric telemetry carries no message contents or keys. The application's playback
level is 100%; the operating system's volume setting still controls the speaker.

## Closing a chat

End chat is a graceful operation after pairing. Existing queued messages keep
using the normal bitmap receipts and exact retries. Neither peer accepts new
messages once it has entered closing. An unsent draft stays local. The original
initiator retains the speaking clock even when the other device requests close.

After both directions are drained, COMMIT, ACK and FINAL use authenticated
numbered turns. Normal completion releases audio on both devices. A lost ACK
can be repaired; a lost FINAL leaves the responder listening for a bounded
repair interval. Its status reports when final confirmation was not heard.
Closing never changes a message to Delivered without its application receipt.

Stop now is always available while connected or closing. It immediately stops
local audio and releases keys without waiting for a peer. During initial setup
the button is Stop because no authenticated close is possible yet. The
read-only agent interface exposes the close stage, evidence, outcome and
remaining deadline separately from message receipts. Both devices need the
current release: close-capable chat versions 6/7 intentionally reject older
chat versions 4/5, with no silent downgrade.
