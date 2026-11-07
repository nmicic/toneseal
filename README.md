# ToneSeal

Experimental short messages and secrets, carried by sound. ToneSeal provides a
browser app with encrypted Message and Password modes, an explicit Clear text
mode, and a signed-enrollment showcase. Message can stay connected for replies.

Sound is rendered by [JotTune Synth](https://github.com/chimepond/jottune-synth).
ToneSeal implements its own packet encoding, audio receiver, session protocol,
receipts and recovery. It does not use an external data-over-sound library.
The [JotTune Synth demo](https://chimepond.github.io/jottune-synth/) is separate.

This is an experimental project, not an independently audited secret-transfer
system. Use dummy secrets while testing. Simple mode encrypts the connection
but leaves the initial peer unverified; compare the complete fingerprint on
both trusted screens with Verify peer before exchanging a real secret.

## Run locally

Requirements: Python 3.10+, Zig for the WebAssembly receiver, and a prepared JotTune
Synth browser bundle. Node.js 22+ and a C99 compiler are needed for the checks
and the native receiver. No npm packages are required by the browser app.

Clone or prepare JotTune Synth separately using its own build instructions,
then point ToneSeal at that checkout:

```sh
python3 scripts/build-web.py --synth-root ../jottune-synth
npm run serve
```

`JOTTUNE_SYNTH_ROOT` can select a different checkout location. `--assets PATH`
accepts an already prepared synth `web/` bundle instead. The builder checks
renderer digests and retains the dependency's license and toolchain notices.
It does not download or rebuild the synth.

Open `http://127.0.0.1:8787/`. The resulting `dist/` is a standalone static app.
It can be served on localhost on an isolated computer, or over HTTPS for other
devices. A `file://` URL is not supported. See [self-hosting](docs/SELF-HOSTING.md)
for browser policies and the external renderer boundary.

## Start on both devices

1. Open the same release on both devices and select the same mode and profiles.
2. Write the first message on one device; leave the receiving device empty.
3. Press Start receiving on the receiver and Start sending on the sender.
   Allow microphone access and keep both pages visible and unlocked.
4. If Verify peer is selected, compare every fingerprint group on both screens
   and Continue on both. The app then pairs, refreshes keys and transfers data.
5. Wait for Delivered. Message continues as a two-way chat; Password and Clear
   text send one item per connection. A received password stays masked and is
   copied only when the receiver explicitly presses Copy.

App view keeps status, chat or received item, composer and live audio together.
The Web view button exposes longer explanations and section navigation using
the same controls and session. Advanced contains key exchange settings,
diagnostics, browser automation and the signed-enrollment showcase.

Later chat messages reuse the encrypted session. Each direction allows up to
eight unacknowledged messages; a full queue pauses Send and preserves the draft.
End chat drains admitted messages and closes through an authenticated handshake.
Stop now releases local audio and keys immediately; pending delivery can remain
unconfirmed. Hiding the page stops the session and clears its transcript.

Choose Nearby on both devices for same-room testing. Telephone is a slower,
experimental profile for testing an audio relay through a call. Call processing
can prevent delivery; the app does not automatically negotiate profiles.

The default Compatible key exchange is P-256. Compact uses X25519 when the
browser supports it. Both sides must select the same profile. AES-256-GCM,
HKDF-SHA256 and the full authentication tag remain fixed. This is classical,
not post-quantum, cryptography.

## Implementation

- A byte selects a redundant four-tone pattern through a GF(16) (4,2) mapping.
- Nearby sends one pattern every 20 ms over 600–3750 Hz. Telephone lowers the band
  and extends its duration. The modulation is coded multitone FSK.
- The sender renders a local four-voice timeline through JotTune Synth and checks
  its canonical replay. Timelines are not transferred to the receiver.
- The portable C receiver uses an integer 960-point Fourier transform, per-band
  normalization and joint scoring of the 256 valid patterns.
- Interleaved RS(15,11), repeated protected headers and CRC checks repair or reject
  damaged packets. Encrypted session records, bitmap receipts, replay checks and
  bounded retries are separate layers.

See [the wire protocol](PROTOCOL.md), [automatic operation](docs/AUTOMATIC-TRANSFER.md),
[key sizes](docs/CRYPTO-PROFILES.md), [trust model](docs/TRUST-MODEL.md),
[telephone experiments](docs/TELEPHONE.md) and [showcase](docs/SHOWCASE.md).
The renderer is an external dependency; its source is not vendored here.
Local font assets retain their [licenses and provenance](web/fonts/README.md).

## CLI and native status

The retained file CLI encodes clear-text messages to WAV and decodes recordings
through the C receiver. It does not implement ToneSeal encrypted sessions or
live microphone/speaker operation. See [CLI instructions](LEGACY.md).

```sh
python3 build.py
node cli.mjs encode --text 'Hello' --out out/example --harness ../jottune-synth/build/s12e10p1v1/harness
node cli.mjs decode --wav out/example/message.wav
```

The output directory must be new and its parent must exist. Full encrypted
Linux/macOS clients and native mobile apps are future work.

## Checks

Native receiver builds target macOS and Linux. The core tests need no synth
checkout, browser installation, hosting account or network service. They include independent framing fixtures and a C receiver build:

```sh
npm test
```

For browser checks, install the pinned development dependency and its browsers:

```sh
npm ci
npx playwright install chromium webkit
npm run build
npm run test:app
npm run test:mobile
npm run test:automation
```

`CHROME_PATH` selects an installed Chromium-compatible browser. `PLAYWRIGHT_MODULE`
or `--playwright PATH` selects an existing Playwright installation. With neither
overridden, tests use this project's dependency and its bundled Chromium.

`npm run test:e2e` also runs protocol simulations, synthesized-audio impairment
checks, session-throughput measurements and the report generator. Open
`out/e2e-report.html` for the shared timeline. Browser and acoustic tests need a
prepared renderer; physical speaker/microphone and phone-call acceptance remain
separate. See [testing](docs/TESTING.md) and [browser automation](docs/AUTOMATION.md).

## Development

ToneSeal is developed with **AI assistance**. Maintainers are responsible for
reviewing changes, validating behavior and deciding what is released.

## License

ToneSeal source is licensed under Apache-2.0; see [LICENSE](LICENSE). Renderer
and font dependencies retain their original license and notice files.
