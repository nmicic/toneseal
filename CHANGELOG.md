# Changelog

## 0.1.0 — experimental beta

Initial public-source release, prepared for publication.

- Encrypted Message and Password, acknowledged Clear text, and an Advanced
  signed-enrollment showcase using platform cryptographic primitives.
- Automatic pairing, optional full fingerprint verification, encrypted rekey,
  bitmap receipts, exact retries and bounded half-duplex chat with authenticated
  close. Compatible P-256 and explicitly supported Compact X25519 profiles.
- Compact App view, detailed Web view, live audio visuals, local diagnostics,
  explicit clipboard actions and peer-idle timeout.
- Original packet modem and portable C receiver, with sound rendered through
  the separately maintained JotTune Synth.
- Diagnostic cleartext WAV CLI and standalone static-site build instructions.
- Native Linux/macOS C client with installed OpenSSL 3/PortAudio and the external
  JotTune Synth SDK: encrypted Message/Password, acknowledged Clear text, chat,
  fingerprint verification, encrypted rekey, JSON events and WAV diagnostics.
- Native/browser interoperability, shared-timeline loss/recovery tests, counter
  boundaries, terminal safety and Linux null-device audio lifecycle checks.
- ToneSeal-specific `text to-tl/from-tl/to-wav/from-wav` commands, with canonical
  synth replay, saved waveform hash validation and byte-exact UTF-8 round trips.
- Independent framing fixtures, protocol/acoustic simulations, browser checks,
  mobile-layout checks and Linux/macOS continuous integration configuration.

The maintainer reports successful browser transfers on Android, Windows, iOS
and macOS. Synthetic tests and browser emulation are documented separately.
Telephone-call compatibility, independent security review, physical CLI/device
acceptance and native mobile applications remain outside the completed scope.
