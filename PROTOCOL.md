<!-- Copyright (c) 2026 Nenad Micic -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# ToneSeal audio session protocols

This document specifies the experimental browser protocol in `web/session.mjs`.
It is a new protocol using platform cryptographic primitives, not a port of
Unmoor's cryptography and not an externally audited password-transfer system.
The acoustic modem carries opaque packets of at most 128 bytes. Session records
are independent of the modem's error correction and sender labels.

Single-transfer sessions use version 2 for P-256 and version 3 for the explicit
compact X25519 option. Chat uses purpose-separated versions 6 and 7, described
below. The v2 layouts remain unchanged; the compact-profile section specifies
the v3 differences. Both purposes require native browser primitives and never
negotiate or fall back to another profile automatically.

The `audio-text-lab/...` strings below are historical wire-format domain
separators. They are retained for compatibility, not used as repository paths.

The native signed-enrollment showcase is a separate application example. It
transfers small signed public objects using the existing encrypted message
channel; its approval signature does not authenticate the session handshake.

## Trust and pairing

Audio is a broadcast physical medium. A nearby device may record, inject, relay,
or jam it. Logical unicast means only the selected session's peer can decrypt
and authenticate its records; it does not mean other microphones cannot hear.
Initial public records provide no peer authentication on their own.

One device creates an offer. A second device explicitly starts receiving and
returns an answer. Both display the same 128-bit transcript fingerprint, rendered
as eight groups of four hexadecimal characters. In **Verify peer**, the user
compares **every group on the two trusted screens** and confirms on both devices.
In **Simple**, the controller confirms automatically; this establishes encrypted
key possession but leaves the peer **unverified**. It protects against passive
listening, not active substitution of the initial exchange. Transmitting a
fingerprint over the same untrusted audio channel would not replace comparison.
This is a long comparison string, not a short SAS protocol with a commitment
phase. No 128-bit active-attack security claim is made for the comparison itself.

Each local confirmation produces an encrypted READY record. Application data is
permitted only after local confirmation and receipt of the peer's valid READY.
The manual UI additionally requires playing the prepared local confirmation.
The automatic controller transmits the confirmation itself, according to the
selected Simple or Verify peer policy. No persistent peer identity or
trust-on-first-use database exists.

## Public records and key derivation

All multibyte integers are unsigned and big-endian unless explicitly stated.

| Field | Bytes | Value |
| --- | ---: | --- |
| Magic | 1 | `A7` |
| Protocol version | 1 | `02` |
| Record type | 1 | `01` offer or `02` answer |
| Public key | 65 | SEC1 uncompressed P-256 public key, starting `04` |
| Random value | 16 | Fresh platform CSPRNG output |

Public records are exactly 84 bytes. Private ECDH keys are generated with
WebCrypto and are nonextractable. Public keys are imported and validated by
WebCrypto. Reflection of the local public key is refused.

For initial pairing, the canonical transcript is:

```text
T = UTF8("audio-text-lab/session/v2\0") || offer84 || answer84
D = SHA256(T)
session_id = D[0:8]
shared_secret = P256-ECDH(local_private, peer_public)
material = HKDF-SHA256(
  IKM = shared_secret,
  salt = D,
  info = UTF8("audio-text-lab/directional-traffic/v2"),
  output_length = 80 bytes
)
key_A = material[0:32]       # initiator -> responder
prefix_A = material[32:40]
key_B = material[40:72]      # responder -> initiator
prefix_B = material[72:80]
fingerprint = SHA256(UTF8("audio-text-lab/fingerprint/v2\0") || T)[0:16]
```

AES keys are imported as nonextractable AES-256-GCM keys. Temporary ECDH and HKDF
byte buffers are overwritten after derivation. JavaScript garbage collection
does not provide guaranteed memory zeroization, and nonextractable keys do not
protect a compromised page or browser from invoking cryptographic operations.

## Compact X25519 profile (v3)

Version 3 identifies exactly X25519 with HKDF-SHA256 and AES-256-GCM. It is
explicitly selected; version 2 and its existing P-256 derivation are unchanged.
The public-key field is a canonical 32-byte little-endian X25519 public value:
bit 255 is clear and the value is less than 2^255-19. This is an application wire
encoding restriction; native X25519 remains the RFC 7748 primitive. Reflection
is rejected, and a native-derived all-zero shared secret is rejected.

The share contains that public value plus 16 random bytes (48 bytes total).
Public records are `A7 03 01/02 || share48`, exactly 51 bytes. Encrypted rekey
records carry that same share and are 80 bytes. Encrypted headers use version
`03`, retain their 15-byte layout, and remain authenticated associated data.

The derivation above substitutes X25519 for P-256 ECDH and uses the domain strings
`audio-text-lab/session/v3\0`, `audio-text-lab/directional-traffic/v3`, and
`audio-text-lab/fingerprint/v3\0`. The complete public records, including their
version and roles, enter the initial transcript. Rekey binds the previous epoch
ID and fresh shares under the version-specific domain. Directional AES keys,
nonce construction, tag length, fingerprint length, counters, confirmation,
receipt bitmaps, replay handling, and rekey state transitions remain unchanged.

A session's profile is immutable. Both peers must select it before Start. An
unsupported native implementation fails explicitly; there is no algorithm
negotiation, cross-version acceptance, fallback, or vendored crypto primitive.

## Encrypted records

| Field | Bytes | Value |
| --- | ---: | --- |
| Magic, version, record type | 3 | `A7 02 03` |
| Session ID | 8 | Derived identifier for the current key epoch |
| Wire counter | 4 | Sequence-space bit plus 31-bit sequence |
| Ciphertext | 1–97 | Encrypted kind byte followed by body |
| Authentication tag | 16 | AES-GCM tag |

The full 15-byte header is AES-GCM associated data. The 12-byte nonce is the
direction's derived 8-byte prefix concatenated with the full 4-byte wire counter.
Each direction has two independent sequence spaces:

- Bit 31 clear: application records. Low 31 bits increment from 1.
- Bit 31 set: control records. Low 31 bits independently increment from 1.

The space bit is part of both the authenticated header and nonce. A decoded kind
in the wrong sequence space is rejected. Counters are reserved before asynchronous
encryption and never wrap or reuse a nonce. Exhaustion refuses further encryption.
Each space has a separate 64-record receive/replay window.

| Kind | Space | Body |
| --- | --- | --- |
| `00` READY | Control | Empty |
| `01` message | Application | 1–96 bytes of strict UTF-8 |
| `02` password | Application | 1–96 bytes of strict UTF-8 |
| `03` rekey offer | Control | 65-byte fresh public key + 16-byte random value |
| `04` rekey answer | Control | 65-byte fresh public key + 16-byte random value |
| `05` rekey request | Control | Empty |
| `06` delivery receipt | Control | Highest application sequence, 4 bytes + bitmap, 8 bytes |

Malformed UTF-8 and unpaired JavaScript surrogates are rejected rather than
silently modifying a password. There is no Unicode normalization or trimming.
Unknown kinds, versions, oversized records, wrong session IDs, authentication
failures, and invalid control bodies are refused without replacing a live session.
Unauthenticated input never advances replay state or prunes delivery state.

## Loss recovery and delivery receipts

Encryption and acoustic error correction do not establish delivery. A sender
retains each encrypted application record until an authenticated receipt names
its application sequence. Retained state contains ciphertext, not plaintext.
The outbox holds at most eight packets. A ninth send is refused rather than
evicting an undelivered packet.

The receipt body is exactly 12 bytes:

```text
bytes 0..3: highest application sequence accepted by this receiver
bytes 4..11: bitmap, least-significant bit first within each byte
bit i acknowledges application sequence (highest - i), for i = 0..63
```

Bit zero must be set. Bits that name zero or negative sequences are invalid.
The highest sequence must not exceed the sender's allocated application tip.
The entire receipt is validated before any retained record is removed. Only
explicit set bits remove entries: a gap is **not** acknowledged merely because a
higher sequence arrived. Reordered receipts may add evidence but cannot retract
previously accepted evidence. Receipts themselves are never acknowledged.

On a new application record, the receiver returns the plaintext once and prepares
an encrypted receipt with its current bitmap. If that receipt is lost, the sender
can resend its original ciphertext. An authenticated duplicate is not delivered
again; it produces a **new** encrypted receipt with the latest bitmap and a fresh
control sequence. Reusing an old receipt indefinitely could leave it outside the
sender's control replay window.

The sender also limits its application sequence span: a new record must remain
within 63 sequence positions of the oldest unacknowledged record. Thus a missing
packet cannot age out of the receiver's 64-record application window while newer
packets are acknowledged. Separating application and control counters ensures
receipt traffic cannot consume this repair window or deadlock acknowledgements.

`pending()` returns retained packets in ascending sequence order. `retryPending()`
returns a copy of the oldest retained ciphertext, without reencryption. This is
lowest-missing-first selective retransmission. A lost packet and a lost receipt
are both repaired by this same operation. The library never represents playback
completion as delivery; the UI's delivered status requires a valid receipt.
A receipt means the peer session accepted the decrypted record, not that the
user saw, copied, pasted, or successfully used its contents.

This prototype delivers independent messages as they arrive, potentially out of
order. It does not implement Unmoor's ordered byte-stream delivery. Reliability
is limited to the live session: disconnect, expiry, reload, or reset discards
unacknowledged ciphertext along with session keys. No delivery guarantee survives
that explicit loss of state. Permanent jamming or a peer that never responds
cannot be repaired by a retransmission algorithm.

## Authenticated rekey

The original initiator drives fresh key exchanges. The responder can send an
encrypted rekey request to ask it to start. Locally initiating rekey is refused
while the outbox contains unacknowledged application records.

1. Initiator sends a fresh public key/random share as a rekey offer under the old keys.
2. Responder sends its fresh share as a rekey answer under the old keys.
3. Initiator derives candidate keys and sends READY under those new keys.
4. Responder verifies that READY, returns READY under the new keys, and switches.
5. Initiator verifies the response and switches.

The rekey transcript replaces initial pairing's transcript with:

```text
T = UTF8("audio-text-lab/session/v2\0")
    || previous_session_id8 || initiator_share81 || responder_share81
```

Derivation otherwise follows the same HKDF and fingerprint rules. The old
authenticated channel binds the exchange to the same connected peer. It inherits
the initial verification policy: Simple remains unverified, while Verify peer
preserves the earlier human comparison. Human confirmation is not repeated. Each epoch uses fresh ECDH material,
directional keys, nonce prefixes, and session ID. Old application traffic is
rejected after switching. This classical exchange is not post-quantum encryption.

Handshake responses are cached as exact ciphertext, with a bounded cache of
twelve input/response pairs. In particular, an already-switched responder can
repeat its final READY when the initiator's READY is retransmitted after a lost
final response. `rekey()` called during rekey returns the retained current flight;
it does not allocate another key exchange. This lets the UI resume a key refresh
even if an intervening receipt replaced the generic last outbound packet.

A peer may still have an unacknowledged outgoing record unknown to the requester.
It refuses the incoming rekey request/offer until that record is acknowledged.
During the pre-answer request/offer phases, the requester continues to accept and
acknowledge old-epoch application records, including retransmissions. The peer
uses Retry oldest, receives its receipt, and the requester uses Resume key refresh
to repeat the saved rekey flight. Once candidate keys exist, application traffic
is paused until the exchange completes. Stalled sessions can be reset explicitly.

## Acoustic turns and API

Both interfaces use half-duplex turns: one device listens while the other plays.
In the manual lab, the receiver prepares an answer or receipt and the user plays
it while the original sender listens. The automatic interface handles these turns
after Start, including continuous reception and bounded retransmissions. Neither
opens a microphone on page load or runs while the page is hidden. Preparing an
ACK alone does not deliver it; it must cross the return audio path.

| API | Result |
| --- | --- |
| `offer()` | Public offer packet |
| `receive(packet)` | Typed result; may include `outbound` response |
| `confirm()` | Encrypted local READY after the caller’s selected trust policy; automatic confirmation alone is not peer verification |
| `send('message' or 'password', text)` | Retained encrypted application packet |
| `retry()` | Copy of latest outbound packet |
| `pending()` | Copies of `{counter, packet}` for retained application records |
| `retryPending()` | Copy of oldest unacknowledged application packet |
| `rekey()` | Start rekey, request it, or repeat the current rekey flight |
| `reset()` | Drop session, retained packets, and pending cryptographic work |

An application receive result includes `counter`, `outbound`, and `receipt: true`.
An authenticated duplicate returns type `duplicate`, no plaintext, and a fresh
receipt. A received receipt returns `{type: 'ack', acknowledged, pendingCount}`.
`info.pendingCount` counts retained packets; `info.lastDelivery` reports the
most recently sent application's sequence, session ID, and pending/delivered
status. Public cryptographic operations are serialized. Reset invalidates
asynchronous operations so their completions cannot restore discarded state.

## Relationship to Unmoor

The repair design follows the existing project's separation of cryptographic
frames from application delivery state:

- Unmoor `src/sync.h` describes its retained sender backlog, receiver contiguous
  frontier, 64-byte-block presence bitmap, and running stream chain.
- `src/sync_repair_plan.c`, `sync_repair_plan_choose`, selects the lowest missing
  ranges for retransmission.
- `src/sync.c`, `sync_handle_ack_instance`, rejects acknowledgement beyond the
  sent tip and verifies the stream chain before pruning retained history.

Unmoor needs its running chain and offsets for an ordered, exact byte stream.
This app carries independently authenticated short records, so its receipt
bitmap acknowledges whole message sequences. It retains the same essential
principles: authenticated delivery evidence, explicit holes, bounded retention
with backpressure, and retransmission instead of silently dropping admitted data.

## Validation and limits

`node --test tests/session.mjs` checks confirmation gates, byte-exact Unicode,
tampering, wrong peers, reflection, malformed authenticated records, replay,
out-of-order delivery, exact retransmission, lost receipts, selective bitmap
pruning, outbox limits, sequence-window limits, more than 64 control messages
during a data gap, rekey loss recovery, both directions of rekey/receipt races,
counter exhaustion, operation serialization, and reset during key generation.

These tests validate implementation behavior, not a security proof or external
audit. The hosting origin, delivered JavaScript, browser, operating system,
clipboard history/synchronization, and both endpoint screens remain trusted.
Changing a hidden URL is not an access-control or cryptographic mechanism.

## Automatic orchestration

`web/auto-transfer.mjs` uses the v2/v3 records for single encrypted transfers. Start with nonempty input
selects the initial sender; empty input selects a receiver. Each Start opens
one bounded microphone stream and one gesture-resumed AudioContext. No media
starts on page load. The default Simple policy automatically calls `confirm()`;
Verify peer waits for a local human comparison. The controller reports that
human decision separately from the protocol’s local/peer key-confirmation flags.

The sender sends its initial READY first, and the receiver answers when its
local policy is satisfied. This asymmetric order avoids simultaneous confirmation
playback. Both policies then perform an encrypted fresh ECDH rekey automatically
before the application record is sent. Rekey checks continuity, not the identity
of an initially unverified peer.

Only the sender retries proactively, retaining the current exact flight. The
receiver automatically returns the corresponding answer, confirmation, rekey
response, or fresh delivery bitmap. Nearby retries wait 8 seconds plus up to
1 second of jitter after playback; Telephone multiplies those waits by 4/3.
Both have at most eight attempts per flight and a three
minute overall limit. The receiving device remains available for up to 60 seconds
after delivery to repair a lost receipt. If a sender decodes another valid
initial offer while discovering, it stops with a role-conflict message. Devices
transmitting at the same time may hear neither offer; only one device should
have a message entered.

### Automatic cleartext receipts

`web/clear-session.mjs` implements a separate bounded stop-and-wait exchange:
DATA, ACK, then FIN. Each record starts with magic `a8`, version `01`, and kind
`01` (DATA), `02` (ACK), or `03` (FIN). The next 12 bytes are a random transfer
ID; the following 16 bytes are the first 16 bytes of SHA-256 over the UTF-8
domain `audio-text-lab/clear/v1\0`, transfer ID, and exact message bytes. DATA
appends 1–96 valid UTF-8 bytes, for at most 127 record bytes. ACK and FIN contain
only the 31-byte header. These records are distinct from encrypted `a7` records
and the original raw-text `00` mode retained in the manual experiment.

The receiver validates the full DATA checksum and UTF-8 before displaying it,
then returns an ACK with the same ID and checksum. The sender retains and retries
the exact DATA until a matching ACK arrives; it then sends FIN and reports
delivery confirmed by an **unauthenticated** checksum receipt. Local FIN playback
failure cannot undo a receipt already received. The receiver displays DATA once,
re-ACKs identical retries, ignores unrelated DATA after accepting one message,
and stops on matching FIN. A lost FIN leaves the receiver listening for at most
60 seconds or the remainder of the three-minute run, whichever ends first. It
then stops with a successful received result, without claiming that FIN arrived.
No finite final exchange guarantees that both parties know the other has stopped.

This applies Unmoor's retained-data and matching-receipt principle to one
outstanding message; there are no additional packet positions needing a bitmap.
Physical framing still supplies Reed–Solomon repair and CRC-16 error detection.
The checksum provides no authentication: an active participant can forge receipts
or replace DATA and its checksum. Random IDs prevent old ACK/FIN records from
completing a different transfer. A fresh receiver has no freshness challenge or
remembered history, so it can accept a replayed old DATA as its first message.
Cleartext mode provides neither confidentiality nor replay protection against
an active participant.

The transport keeps capture compatible with playback, suppresses its own audio
and a 350 ms echo interval, and uses two staggered bounded native decoders to
recover packets continuously across decoder resets. A 500 ms controller
turnaround delay separates responses. Stop, page hiding, lost microphone
access, or an interrupted AudioContext closes media and discards the run.
Physical device timing and room performance still require acceptance testing.

The automatic transport reuses one renderer Worker for the current run. It
caches only installed, digest-checked engine assets and one compiled Wasm
module; every packet still passes the original canonical verification. Stop
terminates the Worker and discards its cache.

### Audio profiles

`web/audio-profiles.mjs` defines three explicitly selected physical profiles.
Nearby retains canonical playback: 600–3750 Hz, 20 ms symbols, and at most
4.16 seconds per frame. Telephone plays that verified PCM at 0.75 speed:
450–2812.5 Hz, 26.667 ms symbols, and at most 5.547 seconds per frame.
The streaming receiver reverses this time scaling before the unchanged native
decoder. Its windows, onset positions, and duplicate suppression use the
canonical 48 kHz clock. The capture queue, echo guard, turnaround, and three
minute run limit continue to use physical time.

Near-ultrasonic (`ultrasonic`, experimental) maps the same 64 tone indices to
18400 + 25 × index Hz: carrier centers 18.4–19.975 kHz. Symbols last 40 ms,
with 36 ms on-time, 80 ms leading/trailing guards and at most 8.32 seconds per
frame. JotTune Synth renders and verifies this separate mono 48 kHz timeline;
playback stays at speed 1. This is a frequency remapping, not slowed Nearby PCM.

Capture mixes with an 18.1 kHz cosine and applies a symmetric 97-tap, 3 kHz
low-pass filter before time compression. Shared Q30 coefficients and bounded
integer histories are generated by `scripts/ultrasonic-tables.py`. The C and
browser front ends agree at 44.1/48 kHz; canonical time runs at half the physical
capture duration, restoring 600–3750 Hz symbols for the unchanged native decoder.
Filtering attenuates out-of-band music and mixing images before they can fold
into its tone bins. Retry and turn deadlines scale by two; the operator-selected
peer-idle deadline stays physical elapsed time. A long loss burst can therefore
exceed the default minute; two minutes gives repair more time without extending
the three-/ten-minute session lifetimes. Hardware clipping and device filtering
are outside this synthetic receiver guarantee.

Both devices must choose the same profile before Start. Profile selection is
locked during a run; there is no automatic negotiation or fallback. No wire
records, cryptographic domain strings, verification gates, or integrity checks
change with the profile. The Telephone label denotes an experimental codec
compatibility option, not a guarantee of passage through any telephone network.
Near-ultrasonic is for nearby stationary devices, can be audible to some users,
and is not qualified on physical devices or calls. The primary interface and
C CLI expose it; the enrollment showcase retains Nearby/Telephone selection.

### Showcase artifact transfer

`web/artifact-transfer.mjs` layers bounded public envelopes over ordinary
encrypted `message` records without introducing a new cryptographic suite or
record kind. Only `enrollment` and `approval` objects are accepted. Both peers
use Verify peer. One session and its mandatory rekey carry the whole object.

The application messages are strict ASCII strings of at most 96 bytes:

```text
TS1M|id|kind|size|count|digest     manifest
TS1D|id|index|data               numbered fragment
TS1F|id|kind|digest              complete-object receipt
```

`id` is 16 random bytes encoded as 22 unpadded base64url characters. `size` is
four lowercase hexadecimal digits and `count`/`index` are two. `digest` is the
complete SHA-256 hash encoded as 43 unpadded base64url characters. Each fragment
carries at most 48 binary bytes in canonical base64url. The object is limited
to 2,048 bytes; count must equal ceil(size/48), indices must be sequential, and
the final fragment must have exactly the remaining length.

One fragment awaits its encrypted bitmap receipt at a time. Retries preserve
the original ciphertext. A duplicate physical packet receives another receipt
without appending bytes again. Invalid metadata, mixed objects, wrong kind,
sequence errors, and a final digest mismatch fail closed and release no object.
The final fragment is acknowledged only after whole-object digest validation.

The receiver then sends its own authenticated `TS1F` message. The sender reports
success only after matching that completion record to the object it sent; an
ordinary Message receiver's ACKs alone cannot imply artifact assembly. TS1F
also covers a lost final-fragment ACK. The sender acknowledges TS1F and closes.
If that final ACK is lost, the receiver retains its successful received result
and stops after bounded retries/linger. No finite last-message exchange makes
termination common knowledge.

Showcase runs allow at most ten minutes for larger objects; ordinary transfers
retain their three-minute default. Stop clears pending fragments and closes
audio. The native signing example then independently validates the signed
object and explicit authority pin. A transport completion is not certificate
validation, authority trust, or account authorization.

## Persistent encrypted chat (v6 and v7)

Message chat uses `AudioSession({purpose:'chat'})`. P-256 is wire version 6;
X25519 is version 7. Public-share lengths and native primitives match the
corresponding v2/v3 suites. The version also changes the session transcript,
HKDF context, and fingerprint context. A normal one-shot or artifact peer cannot
silently join a chat session: public records with the other purpose/version are
refused. There is no automatic downgrade. The Advanced continuation setting must
match on both peers.

Chat carries only Message application records. Password records and ordinary
standalone ACK records are rejected before advancing receive state or pruning
an outbox. A valid chat DATA frame retains the 96-byte text limit and 32-byte
record overhead; it is displayed once and does not trigger an immediate reply.
Its receipt travels with the next chat turn. This prevents a DATA acknowledgment
from interrupting the remainder of the peer's turn.

The encrypted control kind `07` is a chat turn. It uses the independent control
sequence space and the full AES-GCM authentication tag. Its body is 19 bytes,
so the complete session packet is 51 bytes:

| Body offset | Bytes | Meaning |
| --- | ---: | --- |
| 0 | 1 | Turn format version, exactly `02` |
| 1 | 1 | `00` poll from initiator; `01` response from responder |
| 2 | 4 | Big-endian turn number, 1 through `0x7fffffff` |
| 6 | 1 | Bit 0: pending DATA or admitted encryption reservation; bits 1–3: close stage enum (0 open, 1 drain, 2 commit, 3 ack, 4 final); other bits zero |
| 7 | 4 | Highest accepted incoming application sequence |
| 11 | 8 | The existing 64-bit application receipt bitmap |

A turn permits an all-zero receipt before any application DATA has arrived.
Otherwise its bitmap uses the same validation rules as the ordinary ACK: no
future or impossible sequence, bit zero set, and only explicitly set bits prune
retained packets. Validation is complete before pruning. The receiver verifies
the poll/response role. Authenticated duplicate turn packets are cached in a
bounded four-entry map, allowing repair of a lost response without relaxing
replay rules for other control types. Rekey and reset discard this turn cache.
The controller additionally rejects stale or skipped turn numbers; cached old
controls cannot grant a new speaking turn.

### Turn scheduling and delivery

`ChatTransfer` uses the existing public bootstrap, optional bilateral fingerprint
confirmation, and encrypted rekey. One device starts with the initial message;
the other starts with an empty input. These roles remain the poll initiator and
responder for the conversation, independent of who queues later messages. Two
initial senders receive the existing bounded role-conflict error.

After rekey, the initiator sends at most one DATA frame, then poll 1. The
responder sends at most one DATA frame, then response 1. Each side selects its
oldest pending DATA first. A response grants the initiator permission to advance
to the next numbered poll. The responder transmits only after receiving the
current poll. This is frame-relative half-duplex scheduling; it does not require
synchronized wall clocks.

The production turnaround delay is 500 ms, in addition to the transport's
350 ms echo guard after playback. The control immediately following local DATA
adds no further controller delay. The initiator starts its 18-second response
deadline after its complete poll playback/echo guard finishes; Telephone scales
that deadline by its slower profile factor. Only the initiator retries a missed
turn, up to the existing eight-attempt limit. A duplicate current poll makes the
responder repeat its retained response. DATA and repeated turn-control bytes
remain byte-identical. A retained turn consequently contains its original
bitmap; the next fresh numbered turn advertises updated receipt state.

Both queues empty causes initiator polling to back off from 1 second to at most
5 seconds between exchanges. New initiator data may shorten an idle wait but
cannot interrupt an already granted responder turn. New responder data waits
for the next poll. Each direction admits at most eight unacknowledged DATA
records, with the existing 64-position application window limit. Full queues
reject enqueue without replacing admitted ciphertext. An incoming bitmap frees
only the corresponding acknowledged entries.

The controller stores counters, bounded ciphertext, and timing statistics, not
a conversation transcript. Its UI callback reports a delivery once per admitted
counter. The UI owns any in-memory transcript. Local Stop, page hiding, or the maximum
ten-minute run releases audio, pending ciphertext, and keys immediately. End chat
uses the authenticated close described below. This chat
controller performs its mandatory initial rekey; it does not perform periodic
rekeys during a conversation. It locks the established epoch when chat connects:
cached setup replies and further READY/rekey records are refused, so replaying
an old handshake cannot provoke a response outside a granted chat turn. A new
connection starts a fresh session.

`tests/chat-transfer.mjs` covers purpose isolation, malformed/wrong-role turns,
forbidden channels, old-turn cache retirement, verification, bidirectional reuse,
loss, duplicates, queue limits, idle wakeup, competing initial senders, Stop and
bounded failure. `tests/chat-simulation.mjs` adds production timers, real frame
lengths, and a shared half-duplex clock with delayed joining, lost data and turn
controls, slow rendering, scheduler clock drift, full simultaneous queues, and
an outage. Maximum-payload Telephone turns are also checked. A deliberately
over-budget processing scenario must stop within its lifetime without inventing
delivery receipts; its delayed processing can cause collisions. These are
modeled transport checks; physical acoustic reliability and
voice-call processing require device tests.

### Authenticated chat close

Versions 6/7 replace close-incapable chat versions 4/5. Version-specific
transcripts, KDF contexts and fingerprints prevent silent cross-version pairing;
both peers need the current release. Single-transfer versions 2/3 are unchanged.
The turn body remains 19 bytes and a close control remains 51 bytes on the wire.

Either peer can request `close()`. New enqueue admissions freeze synchronously,
while already admitted encryption reservations and retained messages continue
through the normal DATA/bitmap mechanism. The pending flag includes those
reservations, so a temporarily empty encrypted outbox cannot commit close too
early. The original initiator keeps the poll clock. Simultaneous requests do
not create two speakers or a new handshake.

| Stage | Initiator | Responder |
| --- | --- | --- |
| Drain | Polls with close intent and ordinary receipts; repairs retained DATA | On observing close, freezes admission, advertises intent and drains its outbox |
| Commit | After a matching drain reply reports no pending work and local pending work is zero, sends COMMIT poll n | Accepts only in the draining state with no local pending work; seals ACK reply n |
| Finish | On matching authenticated ACK n, sends FINAL poll n+1, then releases audio and keys | On matching FINAL, releases audio and keys; no extra response is needed |

COMMIT and FINAL are poll-only; ACK is response-only. These stages cannot carry
a pending bit. Unknown stage encodings, incompatible roles and malformed
receipts fail validation before acknowledgement or replay state mutates. The
controller also checks stage and consecutive turn numbers. Once committed,
new application DATA is rejected before receive-window updates or callbacks.
Retained close controls remain available only for bounded close repair.

The initiator may retry its identical COMMIT at most three times. A repeated
COMMIT makes the responder replay its identical retained ACK without advancing
the turn. After ACK playback the responder enters receive-only linger, bounded
by twice the turn timeout plus ten seconds (46 seconds Nearby, scaled for
Telephone). Duplicates never extend this deadline. A lost FINAL therefore
terminates with an explicit unconfirmed-close result on that responder; silence
is not evidence that the other device received the final flight.

Closing has a 180-second deadline, scaled with the audio profile, and remains
bounded by the original ten-minute session lifetime. Normal closing can finish
much sooner. Missing peer traffic, exhausted COMMIT retries, transport failures,
or lifetime expiry must not fabricate peer confirmation. `stop()` always
releases local audio immediately, including during draining or linger. Before
chat is connected, no authenticated close is possible and Stop remains local.

Public close metadata distinguishes local request, observed peer-closing intent,
ACK received, FINAL received, remaining deadline and the pending count at exit.
The initiator label describes the first locally observed cause; crossed user
requests cannot establish a global ordering. Message Delivered events still
require application receipts. A close outcome never upgrades a Pending message.
No finite lossy exchange proves common knowledge of both endpoints' shutdown;
status reports the evidence received on this device.
