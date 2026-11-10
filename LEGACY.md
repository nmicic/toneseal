# Clear-text file CLI

For the live encrypted C client, use [the native CLI guide](docs/NATIVE-CLI.md).
This page describes the retained JavaScript diagnostic tool.

For new integrations, use `build/toneseal text to-tl/from-tl/to-wav/from-wav`.
The C CLI supports all three profiles and file/stdin input. This older diagnostic
is **Nearby-only**; it does not implement Telephone or Near-ultrasonic, encrypted
sessions, or TL-to-text recovery.

The original file experiment is retained as a diagnostic tool. It converts text
into a JotTune timeline and WAV, and decodes a recorded WAV with ToneSeal's native
C receiver. It is clear text, unauthenticated and has no pairing or delivery
receipt. It is separate from the encrypted browser app.

## Build and round trip

From this repository, with a C99 compiler, Python 3 and Node.js 22+:

```sh
python3 build.py
mkdir -p out
node cli.mjs encode --text 'Hello' --out out/example --harness ../jottune-synth/build/s12e10p1v1/harness
node cli.mjs decode --wav out/example/message.wav
```

The native synth harness comes from a separately built
[JotTune Synth](https://github.com/chimepond/jottune-synth) checkout. Use
`JOTTUNE_SYNTH_ROOT` or `--harness PATH` to choose it; no synthesis source is
copied into ToneSeal. The output directory must be new. Encoding checks the
canonical replay before reporting success and never overwrites an existing
output directory. The receiver does not read the sender's timeline or expected
text. `--decoder PATH` selects an existing receiver executable.

Use the portable-TL-capable harness from the pinned synth revision in the
[native build guide](docs/NATIVE-CLI.md#build). New `message.tl` files begin with
`# jottune-tl 1 1` and retain a saved PCM hash. These are TL/engine compatibility
requirements, not a Telephone/ultrasonic setting. Header metadata never contains
the message text, and legacy JSON output names the Nearby profile and versions.

The decoder accepts mono/stereo PCM16 WAV at 44.1 or 48 kHz, up to 20 seconds and
4 MiB. Stereo uses the first channel; 44.1 kHz samples are explicitly resampled.
Unsupported, truncated or oversized inputs refuse. A valid recording without a
packet returns `ok:false` and exit 1; input/operational errors use exit 2.

The receiver can also decode signed little-endian mono PCM16 at 48 kHz directly:

```sh
build/receiver stream capture.pcm irregular
```

Messages passed through `--text` are visible in process arguments. The CLI is
for dummy clear-text tests, not passwords. The native C client implements its
own session, replay, receipt and live-audio integration.

## Browser diagnostic

`communication.html` in the assembled static app exposes the original
capture/prepare/play/decode experiment. Build the full app normally and serve
`dist/`; the page requires the same local renderer assets and browser microphone
permission. Its navigation returns to ToneSeal's Advanced tools.

## Tests

`npm test` verifies independent framing vectors against both JavaScript and the
native C decoder. For the original acoustic tests, first build the receiver and
WebAssembly module, then provide a built native synth harness:

```sh
python3 build.py
python3 build.py --wasm
JOTTUNE_SYNTH_ROOT=../jottune-synth node tests/check.mjs
```

The source fixtures replace the old monorepo-only Python test dependency. The
framing implementation itself is unchanged.
