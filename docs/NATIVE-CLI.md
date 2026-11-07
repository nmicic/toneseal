# Native C client

The experimental Linux/macOS client implements ToneSeal's encrypted Message,
Password, Clear text and persistent chat protocols. It uses PortAudio for live
microphone/speaker IO and the external JotTune Synth C SDK for sound. The
executable needs no browser, Node.js, network connection or message server.
The [trust model](TRUST-MODEL.md) applies to both clients.

Automated interoperability, synthesized audio and Linux callback checks are
covered below. Physical CLI-to-phone/browser acceptance is still pending.
Telephone remains experimental; synthesized PCM does not prove a phone call.

## Build

Requirements: a C11 compiler, make, Python 3.10+, pkg-config, OpenSSL **3.x**
development libraries and PortAudio development libraries. Dependencies are
installed separately; none are vendored. Generated SDK/client products go into
ToneSeal's ignored `build/` directory.

Ubuntu/Debian:

```sh
sudo apt-get install build-essential python3 pkg-config libssl-dev portaudio19-dev
```

macOS with Homebrew and Xcode command-line tools:

```sh
brew install pkgconf openssl@3 portaudio
export PKG_CONFIG_PATH="$(brew --prefix openssl@3)/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
```

From the ToneSeal checkout:

```sh
git clone https://github.com/chimepond/jottune-synth.git ../jottune-synth
git -C ../jottune-synth checkout d2997c99c01f5a1d75af6c2c68454a99d02356d6
python3 scripts/build-cli.py --synth-root ../jottune-synth
build/toneseal --help
```

`JOTTUNE_SYNTH_ROOT` can select another checkout. `CC` selects a compiler.
`--out PATH` chooses the executable location; `--sanitize` instruments ToneSeal
C with ASan/UBSan. The synth builds from its checkout; a browser/Wasm bundle is
unnecessary. An arbitrary newer synth revision has not necessarily passed the
same checks.

## First transfer: CLI to browser

1. On the browser device, select **Message**, **Nearby**, **Compatible/P-256**,
   **Verify peer**, and enable message continuation/chat. Leave the composer
   empty and press **Start receiving**. Use HTTPS outside localhost and allow
   microphone access.
2. On the CLI computer, run `build/toneseal send --verify`. Enter a short dummy
   message at the prompt. The maximum is **96 UTF-8 bytes**.
3. At `verify`, independently compare all eight fingerprint groups on the two
   trusted screens. If they match, Continue in the browser and type `/confirm`
   plus Enter in the CLI.
4. Wait for the CLI's confirmed close and the browser's received message.

To reverse direction, run `build/toneseal receive --verify` and send from the
browser. `send`/`receive` use the web Message chat protocol by default and close
after one item; use `chat` to keep exchanging messages. For a web Message
connection with continuation disabled, add `--single`. Match mode, audio profile,
crypto profile and Message continuation on both peers. Choose one initial sender.
If both start with text, stop and select a receiver on one side.

Simple mode omits `--verify` on both sides. It encrypts but leaves the initial
peer unverified. An encrypted rekey proves continuity with that first peer,
not identity. There is no automatic profile fallback.

## Commands and options

| Command | Behavior |
| --- | --- |
| `send` | Send one item, obtain a receipt, then close Message chat. |
| `receive` | Receive one item, repair lost receipts, then close Message chat. |
| `chat --send` / `chat` | Initiate / receive a persistent bidirectional chat. |
| `devices --json` | List PortAudio IDs and defaults; no capture. |
| `audio-probe --duration 2` | Report capture levels briefly; no recording. |
| `encode` / `decode` | WAV diagnostics, described below. |
| `capabilities` | Machine-readable commands, events, modes and limits. |

```sh
build/toneseal devices
build/toneseal send --mode password --verify
build/toneseal receive --mode password --verify
build/toneseal chat --send --verify
build/toneseal chat --verify
build/toneseal receive --mode clear
printf '%s' 'Hello from the terminal' | build/toneseal send --mode clear
```

| Live option | Meaning |
| --- | --- |
| `--mode message\|password\|clear` | Message default; chat accepts Message only. |
| `--profile nearby\|telephone` | Nearby default; Telephone plays the verified waveform at 75% speed/pitch. |
| `--crypto p256\|x25519` | Compatible P-256 default; explicitly selected Compact X25519. |
| `--verify` | Wait for `/confirm` after a trusted full fingerprint comparison. |
| `--single` | One-shot Message protocol, without continuing chat. |
| `--input FILE\|-` | Sender text from a file/stdin. |
| `--output FILE\|-` | Explicit raw received-byte export; files must be new and are created as 0600. |
| `--input-device ID --output-device ID` | Select devices; IDs can change with hardware. |
| `--timeout SECONDS` | No-new-peer-response deadline: 1–120 seconds, default 60. |
| `--json` | Versioned newline-delimited status/message/delivery events on stdout. |
| `--control-stdin` | Explicit local command pipe, including `/confirm`. |

Files/pipes preserve exact UTF-8 bytes, including NULs, spaces and trailing
newlines. An interactive line's Enter delimiter is excluded. Empty, oversized
and invalid UTF-8 input is refused, without truncation or replacement. Use a
file/pipe for multiline input. Terminal control bytes are escaped on TTY output;
explicit file/pipe exports preserve them.

The password prompt disables echo and restores it on completion or handled
interruption. No password is accepted as a command-line argument. Received
passwords stay masked for up to 60 seconds; type `/reveal` to display once or
select `--output`. JSON password events contain metadata, never plaintext.
There is no automatic clipboard access, command execution or secret persistence.

Local commands: `/confirm`, `/quit` (drain/end chat), `/stop` (immediate stop),
`/reveal`, and `/send TEXT` (send a literal slash-prefixed line). Peer text never
invokes commands. Ordinary connected-chat lines queue messages. Eight packets
can await receipts; one extra local draft is retained while input pauses for
capacity. Closing drains admitted packets and discards an unadmitted draft.
EOF drains admitted chat input and requests close.

## Audio, timing and outcomes

Audio uses 48 kHz, falling back to 44.1 kHz when necessary. Capture uses one
channel; mono output is duplicated to stereo where supported. Application gain
is **100%**; system volume is unchanged. Permissions, headphones, echo cancellation,
voice isolation and feedback can prevent reception. Keep devices awake and
choose appropriate devices; `audio-probe` helps check microphone input.

The initial sender owns the chat poll clock, without wall-clock synchronization.
Later messages reuse established keys. Bitmap receipts and exact ciphertext
retries repair loss in either direction. Sessions are bounded to three minutes
for one-shot transfers or ten minutes for chat. Timeout, signal and failure
paths release audio and keys. Ctrl+C stops immediately; Ctrl+Z is handled as
a stop rather than suspending capture. The lifetime clock includes system sleep.

Encrypted send completes after an authenticated receipt. Clear text uses matching
checksum DATA/ACK/FIN, without authentication. Receivers listen for a bounded
repair interval after showing an item; retries cannot display it twice. Chat
drains and exchanges authenticated close/ack/final records. A lost final can
leave one peer's closure unconfirmed after all messages have receipts.

| Exit | Meaning |
| --- | --- |
| 0 | Received item, confirmed delivery/close, or successful diagnostic. |
| 1 | Timeout/failed transfer, or no usable item in a decoded WAV. |
| 2 | Usage, file/output, device or diagnostic error. |
| 3 | Chat close remains unconfirmed. |
| 128 + signal | Handled interrupt/termination/suspend request. |

Playback alone is never delivery. A received item and confirmation that the
sender heard its receipt are different observations.

## Automation

`capabilities` and `--help` expose actions in one place. With `--json`, events
have `schemaVersion: 1` and `type`. Status exposes phase, active/connected state,
verification, fingerprint, queue depth, transmitted/received/retried frames,
candidate CRC failures, input level, capture drops and remaining peer-idle time.
CRC candidate failures are diagnostic attempts, not a lost-message count.
Errors use stderr; check the exit code. `devices --json` is a single JSON array.

Use `--control-stdin` for explicit local commands. For `send`, keep text in a
separate `--input FILE` when stdin is the control pipe. `chat --send` can take
an initial line and then commands/chat lines from stdin. Automation must perform
its own trusted fingerprint comparison before writing `/confirm`; displaying
fingerprints does not authenticate automatically.

## WAV diagnostics

```sh
printf '%s' 'A dummy cleartext message' | build/toneseal encode --output example.wav
build/toneseal decode --input example.wav
build/toneseal decode --input example.wav --json
build/toneseal decode --input recording.wav --packets
```

Encoding writes unencrypted DATA, without pairing or a delivery receipt.
Decoding accepts complete PCM16 mono/stereo WAV at 44.1/48 kHz, up to 20 seconds
and 4 MiB, using the first channel. Add matching `--profile telephone` for that
waveform. Encoding supports `--rate 44100|48000`. Opaque encrypted packets can
be inspected with `--packets`; decryption needs their live session. Output files
are never overwritten. The retained [JavaScript file CLI](../LEGACY.md) is separate.

## Checks and implementation

With Node.js 22+ available for tests:

```sh
JOTTUNE_SYNTH_ROOT=../jottune-synth npm run test:cli
JOTTUNE_SYNTH_ROOT=../jottune-synth npm run test:cli -- --sanitize
```

Checks cover OpenSSL/Web Crypto in both roles/profiles, production controllers
on a shared modeled audio timeline, counter/replay-window limits, lost frames,
receipts and close final, simultaneous senders, queue bounds, exact UTF-8,
deterministic replay, WAV parsing, noisy/stereo capture and real terminal IO.
No physical microphone is opened. On Linux, `TONESEAL_TEST_ALSA_NULL=1` additionally
exercises real PortAudio callback capture/playback, timeout and cancellation
using a process-local ALSA null device. It changes no machine audio configuration
and does not prove acoustics.

After building web `dist/`, `npm run test:cli:pcm` compares C/browser timelines
and waveforms and sends complete Password/chat handshakes and data through both
real synths and decoders. Airtime and guards remain modeled. Windows native
builds, physical device/call acceptance, native mobile packaging and the
Advanced enrollment showcase are separate work.

`native/cli/session.c` uses OpenSSL EVP for P-256/X25519, HKDF-SHA256 and
AES-256-GCM. `transfer.c` owns scheduling; `modem.c` owns framing, verified synth
replay, WAV IO and rate conversion; `audio.c` owns the PortAudio callback/ring;
`main.c` owns command/terminal IO. Test drivers are separate executables excluded
from `toneseal`. No fixture keys, nonce resets or test commands enter the client.
