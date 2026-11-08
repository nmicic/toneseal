# Security policy

ToneSeal is an experimental beta. The protocol and implementation have not
received an independent security audit. Automated tests and reported successful
device transfers do not establish a security proof.

## Report a vulnerability privately

Email [Nenad Micic](mailto:nenad@micic.be) at **nenad@micic.be**. Use a subject
such as `ToneSeal security report`. Please avoid posting an exploitable issue
publicly before we have had a chance to investigate and coordinate a fix.

Include the affected release or commit, browser/OS, reproduction steps, expected
and observed behavior, and a small example using dummy content. Do not send real
passwords, private keys, clipboard contents, microphone recordings containing
secrets, or another person's data. Ask for a suitable channel before sending
sensitive exploit material. Email confidentiality is not guaranteed.

This is maintained by an individual; no response or remediation deadline is
promised. We will investigate reproducible reports and coordinate disclosure
with the reporter where possible. There is no bug bounty program.

## Supported code

During beta, fixes target the latest code on `main` and the latest published
beta release. Older commits and retired previews do not receive separate
backports. When reporting a problem, include the actual app URL and source
revision if known; deployments may differ from the latest repository code.

## Security boundaries

- Simple mode encrypts traffic but leaves the initial peer unverified.
  Rekeying confirms continuity; it does not authenticate that initial peer.
- Verify peer depends on an independent comparison of every fingerprint group
  on trusted screens and confirmation on both devices.
- Clear text and TL/WAV file conversions provide no confidentiality or peer
  authentication. Playback completion is not a delivery receipt.
- The native C client's encrypted modes share the browser trust model. It uses
  installed OpenSSL 3, PortAudio and the external JotTune Synth SDK. Passwords
  remain masked unless explicitly revealed/exported; protect output files and
  terminal history. Received text cannot invoke local CLI commands or terminal
  control sequences. Physical CLI/device acceptance remains pending.
- The host-delivered code, browsers, operating systems, endpoint screens and
  clipboard behavior remain trusted. A hidden URL is not access control.
- Signed-enrollment showcase objects do not authenticate the audio handshake
  or install a certificate authority. Telephone remains experimental.

See [the trust model](docs/TRUST-MODEL.md) and [protocol](PROTOCOL.md). Use dummy
secrets while evaluating the beta. Do not weaken verification, tags or nonce
rules to work around a reliability problem.
