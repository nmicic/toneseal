# Releasing ToneSeal

The browser application is an experimental beta. The public repository includes
the app, protocol, portable C receiver, live C client and diagnostic file CLI. It needs no
message backend or account service.

## Build and identify the candidate

Publish JotTune Synth before a ToneSeal release that depends on it. Follow its
own build instructions (`make web` for its prepared browser assets). From fresh
checkouts, provide that bundle to ToneSeal and run the documented build and
checks. Do not assume the synth's ignored local build products are in a clone.

Record the ToneSeal commit, JotTune Synth commit/release, selected renderer ID
and renderer digest in the release notes. Use a tested immutable synth revision
for reproducing a release. The currently tested prepared renderer is:

- Source revision: `d2997c99c01f5a1d75af6c2c68454a99d02356d6`
- Fresh source build ID: `dev-9ab5e7ce88a22ed9`
- Browser Wasm SHA-256:
  `24c6110ebb8a0b69c3dab2c806b499fc4be7a02dfc41de38d350b228284e35b5`

These identify the tested artifact, not an assertion that an arbitrary newer
synth checkout produces the same default bundle. The builder validates the
prepared registry and referenced checksums; it does not download a dependency.
The fresh synth checkout passed `make web`, ToneSeal's standalone site build,
the native CLI/acoustic suite and actual browser worker/replay checks. The
previously tested archive ID `2026-10-26-8443cd5` has the same browser Wasm digest.
See [self-hosting](SELF-HOSTING.md) for source-root and prepared-asset overrides.

## Checks

The CI workflow runs core/packaging checks, the C receiver's independent framing
vectors, and session/chat simulations on Linux and macOS. Its Linux job also
runs C framing checks with address and undefined-behavior sanitizers. It needs
no renderer, microphone, browser installation or deployment credentials. A new
workflow has not run on GitHub until the repository is pushed and Actions runs.

The separate native CLI job checks out the pinned external JotTune Synth source,
installs system OpenSSL/PortAudio development libraries, and builds/tests the
live C client on Linux/macOS. Linux also exercises a process-local ALSA null
backend and runs native checks under ASan/UBSan. This job requires the synth
repository and pinned revision to be publicly available. See the
[native CLI guide](NATIVE-CLI.md) for commands and remaining physical acceptance.

For the assembled release, also run the browser/acoustic checks described in
[testing](TESTING.md). Preserve the distinction between model time, synthesized
PCM, browser emulation and actual device measurements. The maintainer has
reported successful browser tests on Android, Windows, iOS and macOS; preserve
the tested versions/pairs in release notes when available rather than inventing
a complete device/version matrix.

After any behavior change, check the affected flows with dummy content:
Message/chat, Password, Clear text, matching profiles, optional bilateral peer
verification, delivery receipts, Copy/Paste, Stop, backgrounding and timeout.
Do not turn a passed simulation into a claim about every telephone codec.

## Publish

Tag the reviewed ToneSeal commit and publish concise release notes containing
the changes, dependency revision, tested scope and known limitations. Keep
`package.json`, its lockfile and the release version consistent. Mark the release
as a prerelease while its status is experimental beta. Never publish `out/`,
prompts, keys, captures, signing material or development account configuration.

The main app already opens at `index.html`; serve `dist/` at the chosen public
origin root for an open launch. An unlisted staging path can remain available
until launch. Serve HTTPS outside localhost, correct module/Wasm/font MIME types,
and the policies in [self-hosting](SELF-HOSTING.md). Confirm the displayed beta
status, all supported origins, app navigation and a known-good rollback build.

Point users to [SECURITY.md](../SECURITY.md) for private vulnerability reports.
Keep the [trust model](TRUST-MODEL.md), beta limitations and contact information
visible. Publishing source and passing tests do not constitute an independent
cryptographic audit. Native mobile apps and full X.509 PKI can ship separately.
The C CLI's physical laptop/browser/phone acceptance remains a separate gate
from its automated crypto, timed-controller, synth/decoder and backend checks;
it does not need to hold this browser beta.
