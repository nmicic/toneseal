# Transfer testing and protocol review

The main correctness requirement is byte-exact application delivery, with no
duplicate display and no delivery claim without a matching receipt. The main
performance measures are time to delivery, total waveform airtime, retry count,
and application bytes per second. Expected failures are useful test results:
two senders or mismatched modes must stop within their bounds, without claiming
success.

## Run and inspect

```sh
npm run test:e2e
```

This builds the app, runs packaging and protocol checks, runs the simulations
and waveform tests, checks the actual browser transport, and creates
`out/e2e-report.html`. Open that file locally and choose a scenario to inspect
the shared timeline. The report has no external scripts or network requests.

For a faster iteration after building:

```sh
npm run test:simulation
npm run test:acoustic
npm run test:throughput
npm run test:report
```

Machine-readable results are written to `out/simulated-transfer.json`,
`out/acoustic-impairments.json`, and `out/session-throughput.json`. These generated
files are ignored by Git. Tests use dummy content and do not record real
passwords, session keys, or microphone input.

## What each layer establishes

The native C client has a separate suite:

```sh
JOTTUNE_SYNTH_ROOT=../jottune-synth npm run test:cli
JOTTUNE_SYNTH_ROOT=../jottune-synth npm run test:cli -- --sanitize
```

It compares real OpenSSL and browser Web Crypto, then runs the production C
controller against the production browser controller on one shared audio
timeline. C time is explicitly injected; JavaScript timers and real crypto
completions are coordinated before advancing virtual time. Scenarios include
both roles, all three modes, chat, delayed starts, selective loss, duplicates,
queue limits, simultaneous senders and confirmed/unconfirmed close. Fixed
framing fixtures, counter exhaustion, replay-window edges, malformed WAVs,
noisy/stereo PCM and real terminal IO have separate checks. Counter inspection
is confined to a test executable, with no production counter/nonce overrides.

On Linux, `TONESEAL_TEST_ALSA_NULL=1` opts into real PortAudio callback/lifecycle
checks using a process-local ALSA null configuration. No system audio settings
are changed. After building `dist/`, `npm run test:cli:pcm` additionally compares
native/browser synth waveforms and routes complete protocol transfers through
the real synths and opposite receivers. These are synthetic sound tests, not
physical speaker/microphone or telephone acceptance. See
[native instructions](NATIVE-CLI.md).

`tests/simulated-transfer.mjs` runs the actual automatic controller, session
cryptography, and framing on one virtual clock. Device A and B share a half
duplex medium. Frames have their real encoded durations; the model accounts for
preparation, capture startup, response waits, playback, the echo guard, and
collisions. Web Crypto still performs the real operations. Virtual time advances
after pending crypto completes, so expensive wall-clock scheduling cannot
accidentally become a protocol timeout.

Scenarios cover ordinary transfers, delayed starts, missing protocol flights,
lost acknowledgments, duplicate reception, burst outages, competing senders,
mismatched modes, Stop, and timeouts. A successful scenario must preserve the
exact payload and display it once. A failure scenario must release its audio
resources and avoid a false delivery claim. Timeline logs include both devices
and the medium, rather than separate traces that obscure overlapping speech.

`tests/acoustic-impairments.mjs` uses the real synth, canonical replay, and native
streaming decoder. It renders maximum-size cleartext and encrypted fixtures and
short ACKs into shared PCM timelines. Fixed seeds reproduce white noise,
attenuation, varying amplitude, silent gaps, removed samples, and overlapping
speakers at 48 kHz and 44.1 kHz. Every accepted packet must exactly equal one of
the source packets. Destructive cases must recover from their later clean
retransmission; noise alone must not produce a packet.

The acoustic encrypted fixture uses fixed **test-only** AES-GCM material to make
its waveform reproducible. Real key exchange, nonce allocation, authentication,
and bidirectional receipts are exercised by the session and controller suites.

`tests/session-throughput.mjs` runs genuine pairing, encrypted rekey, and ten
alternating messages within one session. A second case queues four messages in
each direction, drops DATA and ACKs, and repairs the exact retained ciphertexts.
Both receipt bitmaps must drain their respective outboxes, with every message
delivered once. It reports real crypto wall time separately from modeled
waveform airtime.

Browser checks exercise the DOM, Web Crypto, clipboard races, roles, examples,
cleartext ACK/FIN, password cleanup, actual worker rendering, and continuous
native decoding. Run Chrome and Brave audio suites sequentially. These checks
found a real packaging issue when a newer synth worker began importing a spatial
helper; the builder now includes that dependency, and packaging regressions are
part of `npm test`.

`npm run test:app` checks the default compact App view and switching to Web view
at desktop, phone and landscape sizes. It checks the same DOM controls survive
switching, draft/session/key retention, explicit fingerprint confirmation,
bidirectional native-crypto chat with a dropped DATA frame, scrolling history,
masked password receipt and manual Copy, clipboard races, and acknowledged
one-shot clear text. Keyboard checks simulate viewport/visualViewport changes.
Operational geometry checks use real verified sessions and inspect clipping
ancestors and hit targets without scrolling: the complete fingerprint and
Continue must be visible together, as must the latest message, adjacent Copy,
receipt and composer actions on ordinary portrait and desktop viewports.
Password setup also checks initially open Ready details, settings without nested
scrolling, a composer aligned with Message and Clear text, and short/keyboard
layouts with a single outer scroller and reachable controls.
Screenshots go to `out/app-view-browser/`; this uses a synthetic acoustic room,
not physical microphones or phones.

`npm run test:mobile` checks all four tabs in detailed Web view with touch input using Playwright
WebKit at iPhone sizes (including 320 px and landscape) and Chromium with Pixel
and Galaxy emulation. It checks touch target sizes, overflow, sticky navigation,
form text sizes, draft and password handling, settings retention, the showcase
return link, keyboard navigation, and that navigation opens no microphone.
It also visits the manual lab and original experiment, verifies the shared
header and Back link remain visible while scrolling, and follows each transfer
mode link under a nested preview URL. Every mode starts with an empty input.
Screenshots and viewport results go to `out/mobile-navigation/`. These are
browser emulation checks, not tests on physical iOS or Android devices.
The suite uses the pinned Playwright development dependency (or an existing
installation selected with `--playwright` / `PLAYWRIGHT_MODULE`). Install its
WebKit browser with `npx playwright install webkit`. No browser or dependency
is vendored into this repository.

## Findings and design direction

The default seeded suite currently passes 88 shared-timeline scenarios. Its
baseline preparation assumptions are 180 ms for the first frame and 70 ms for
later uncached frames; startup is 150 ms, decoder latency 45 ms, propagation
2 ms, and the echo guard 350 ms. Production controller retry and turnaround
timers are used directly, including the selected profile's retry scaling.

| Scenario | Payload | Modeled time to sender confirmation | Frames |
| --- | ---: | ---: | ---: |
| Healthy encrypted message | 43 bytes | 30.710 s | 10 |
| Maximum encrypted message | 96 bytes | 32.210 s | 10 |
| Healthy cleartext | 34 bytes | 7.714 s | 3 |
| Maximum cleartext | 96 bytes | 9.354 s | 3 |
| Encrypted, receiver starts 5 s late | 43 bytes | 42.201 s | 11 |
| Encrypted, three ACKs lost | 43 bytes | 64.979 s | 16 |
| Telephone, maximum encrypted message | 96 bytes | 40.850 s | 10 |
| Telephone, maximum cleartext | 96 bytes | 11.714 s | 3 |
| Compact X25519, maximum encrypted message | 96 bytes | 28.610 s | 10 |
| Compact X25519 + Telephone, maximum encrypted message | 96 bytes | 36.050 s | 10 |
| Showcase enrollment, Compact + Nearby + human verification | 358 bytes | 96.768 s | 28 |
| Showcase approval, Compact + Telephone + human verification | 612 bytes | 168.591 s | 38 |

Showcase scenarios use actual fragment lengths and production timers on the
same half-duplex clock. They cover lost fragment receipts, a lost completion
record, and a lost final completion ACK. These model times use dummy public
bytes of the default signed-record sizes and include the explicit confirmation
delays described above. They are not physical acoustic acceptance results.
`retryCount` counts byte-identical repeated frames, so additional legitimate
fragments and newly generated cumulative ACKs are not counted as retransmissions.

The native identity suite checks signed-object binding, explicit full authority
pins, tampering, expiry, wrong requests/authorities, duplicate and concurrent
acceptance, nonextractable private keys, and disposal. Artifact tests additionally
cover complete-object digest validation, malformed/mixed fragments, exact retries,
Stop during partial assembly, async reset races, bounded lifetime, and refusal
to treat ordinary Message ACKs as successful artifact assembly. The two-browser
showcase check uses native crypto with substituted audio and shortened timers.
It also checks the four permanent navigation tabs, Advanced settings and
showcase entry, ordinary draft and crypto-setting retention across navigation,
and the showcase's return link to Advanced without opening the microphone.

Compact cases repeat all ten lost-flight cases, verified transfer, delayed
Start, duplicates, both-sender collisions, and both directions of profile
mismatch. Session tests run the common security/rekey/receipt matrix for both
profiles. `npm run test:crypto-audio` additionally carries an actual compact
pairing, rekey, maximum password, and receipt through rendered PCM and native
decoding in three fixtures. It includes Telephone at 44.1/48 kHz, mild noise,
and a deliberately lost ACK: 32 exact decoded records, three single deliveries.

The Telephone cases also cover delayed Start, human verification, lost rekey
flights and ACKs, duplicate results, a finite outage, simultaneous senders, and
mismatched profiles. Waveform durations scale by 4/3; the controller scales
retry waits while retaining physical echo/turnaround and absolute run limits.

`npm run test:profiles` adds an optional FFmpeg/SoX diagnostic comparing playback
rates 1, 0.75, 2/3, and 0.5 through clean, bandpass, G.711, and GSM-FR paths. The
0.75 profile passed all nine initial fixtures per path and an expanded 36 per
path. Run the expansion with
`node tests/telephone-profiles.mjs --rates 0.75 --patterns 12 --output out/telephone-profiles-extended.json`.
The report includes both JSON files when present. These codec diagnostics do
not qualify an actual call or AMR. Channel losses are reported, while corrupt
accepted packets and clean-path failures fail the diagnostic.

Native streaming checks separately exercise the production Telephone resampler
at 44.1 and 48 kHz, irregular chunks, reset boundaries, repeated packets,
capacity resets, and profile mismatches. Browser checks use actual 0.75 playback
and stretched synthetic microphone input, preserving the canonical PCM check.

The simulation exposed redundant replies when one decoder callback contained
the same packet twice. The controller now coalesces identical packets within
that callback only. The duplicate-input case fell from 75.433 seconds and 21
frames to the healthy 30.710 seconds and 10 frames. A later identical packet
still receives its own ACK, preserving lost-receipt recovery.

Nine deterministic waveform cases accept 13 packets, all byte exact. The
fixtures recover through 20 ms erased intervals and seeded white noise. A
20 ms removal of samples, a larger erasure, or equal simultaneous speakers can
destroy a frame; clean retransmission recovers it. These are fixed examples,
not general noise or erasure limits.

The current encrypted bootstrap and mandatory rekey occupy eight packets:
84, 84, 32, 32, 113, 113, 32, and 32 bytes. Their combined **waveform airtime is
19.84 seconds**, before preparation, turnarounds, or room/device delays. Once a
session exists, a message plus its receipt occupies 3.54 seconds for one payload
byte, 4.28 seconds for 32 bytes, and 6.08 seconds for 96 bytes.

For the benchmark's ten-message sequence, keeping one session uses **62.38
seconds of waveform airtime**, versus **240.94 seconds** when pairing and
rekeying before every message. The 178.56-second difference is a modeled airtime
saving, not a measured phone-to-phone completion time.

The Message tab now continues as encrypted chat by default. The separate
`ChatTransfer` controller retains the established session and audio context,
with eight unacknowledged messages per direction, a 64-position receipt bitmap,
and a ten-minute lifetime. Versions 4/5 isolate chat from ordinary transfers.
Numbered initiator polls and responder turns include the receipt bitmap in a
51-byte control record, preserving the full 96-byte DATA payload. Replayed
setup or rekey traffic cannot trigger an out-of-turn response after chat starts.

`tests/chat-transfer.mjs` checks native cryptography, purpose/version isolation,
turn grammar, bilateral verification, bidirectional message/receipt recovery,
backpressure, idle backoff, stale grants, setup replay, Stop, and bounded expiry.
`tests/chat-simulation.mjs` places actual frames on one shared clock using their
encoded waveform durations, processing delays, echo guards, and continuous
half-duplex listening. It covers loss in each direction, lost turn controls,
duplicate input, delayed start, clock drift, slow preparation, full queues, and
one-way outages. Results and the complete frame timelines are written to
`out/chat-simulation.json`; these are modeled times, not physical-device results.

`tests/chat-browser.mjs` connects the real Message UI across Chromium and
WebKit using native P-256 or X25519 and a substituted room. It verifies one
bootstrap for repeated replies, simultaneous enqueue, dropped DATA recovery,
eight-message backpressure without losing the ninth draft, explicit Copy,
per-message delivery, telemetry display, and hidden-page cleanup. The existing
`auto-browser.mjs` tests select the one-message setting in Advanced to preserve
coverage of the original Message, Password, and Clear text paths. Run
`npm run test:chat` for the new simulation and browser checks.

Transport tests additionally render a correctly error-coded but CRC-invalid
packet, verify the native CRC rejection counter, then recover a valid packet
byte-exactly. They check metric throttling, final counters, stale decoder epochs,
and fixed playback gain 1. CRC counts rejected candidates across overlapping
windows; no physical loss rate is inferred from them.

During bootstrap, two senders can repeatedly collide because neither hears
while playing. The current UI makes roles explicit and reports a conflict when
it decodes another initial offer. Supporting two initially nonempty devices
requires randomized discovery backoff followed by deterministic initiator
selection. Initial key-exchange roles must then be independent of which side has
application data to send. This needs dedicated collision and convergence tests.

Use local monotonic timestamps for latency measurement. A peer's wall-clock time
is neither synchronized nor trustworthy enough for retry or replay decisions.
If send time becomes part of a message, authenticate it as ordinary metadata;
keep counters and fresh session IDs responsible for replay protection. The
timestamped example is useful for recognizing a new transfer, without making
time a cryptographic dependency.

## Limits

The virtual medium treats an overlapped packet as lost; it does not model a
stronger speaker winning, room impulse response, nonlinear distortion, or
operating-system scheduling. Synthetic waveform tests are reproducible examples,
not a measured noise tolerance boundary or a guarantee for any phone. Real
speaker routing, volume, echoes, background interruptions, and distance still
need physical device tests.

The shared protocol model and waveform impairment cases run separately. The
controller's packet-loss decisions are scripted or seeded; measured decoder
failures are not automatically fed back into that virtual medium.

Cleartext ACKs bind the checksum and random transfer ID but remain unauthenticated.
They can detect accidental corruption and lost delivery, not an active forged
receipt. An initially unverified encrypted pairing also stays unverified after
automatic rekey. Faster or repeated transfer does not change those trust bounds.

## Browser automation

`npm run test:automation` checks the public read-only observer and ordinary
browser actions, including verification, privacy, delivery IDs, queue limits,
activity ages and stopping. `npm run test:room` starts two local browser views
connected through the synth and decoder with synthetic noise. See
[AUTOMATION.md](AUTOMATION.md) for the supported interface and test-room limits.

## Authenticated chat shutdown

`tests/chat-close-simulation.mjs` adds 21 shared-clock scenarios with production
controller timers, real native crypto and encoded waveform airtime. Cases cover
both requesters, simultaneous close, full bidirectional Telephone queues,
admitted encryptions held for 15 seconds, loss of each close stage, repeated
loss, duplicates/drift, slow rendering, outages, force stop and lifetime expiry.
Every completed delivery requires receiver evidence, and all cases require zero
half-duplex collisions. The unchanged 11 conversation scenarios also still pass.

Healthy modeled close takes 14.7–15.7 seconds. Sixteen maximum-size queued
Telephone messages drain and close in about 174.9 seconds. These are modeled
completion times, not physical device measurements. If every close request is
lost, the unaware peer can remain active until its original session lifetime;
the requesting peer's shorter close deadline cannot remotely stop an unreachable
device. A missing FINAL produces a confirmed initiator and an explicitly
unconfirmed responder after bounded linger, without changing message receipts.

Browser tests exercise native crypto and the actual UI in Chrome/WebKit,
including graceful versus immediate stop, queued delivery, unsent drafts,
Advanced access, persistent 44-pixel close/abort controls at 320/390 pixels,
exact close retries and truthful outcomes. The local browser room accepts
`--timing production` for integration tests using production controller deadlines;
its synthetic PCM still accelerates physical airtime and does not model room
acoustics or telephone codecs.
