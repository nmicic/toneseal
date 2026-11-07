# Key sizes and advanced options

The automatic page always shows Message, Password, Clear text, and Advanced.
Select the **Advanced** tab to choose a fixed key-exchange profile, then return
to Message or Password before Start. Both devices must choose the same option;
there is no automatic negotiation or fallback. Clear text does not use these
crypto settings.

| Profile | Public key | Initial offer/answer | Encrypted rekey offer/answer |
| --- | ---: | ---: | ---: |
| Compatible P-256 (default; v2 single transfer, v6 chat) | 65 bytes | 84 bytes | 113 bytes |
| Compact X25519 (v3 single transfer, v7 chat) | 32 bytes | 51 bytes | 80 bytes |

P-256 currently sends an uncompressed point: a one-byte marker and two 32-byte
coordinates. X25519 uses a 32-byte public value. Both target approximately
128-bit classical key-agreement security. This does not claim 128-bit security
for every part of this experimental protocol or its human fingerprint check.
Neither is post-quantum. See [NIST SP 800-57, section 5.6.1](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-57pt1r5.pdf)
and [RFC 7748](https://www.rfc-editor.org/rfc/rfc7748.html).

The complete eight-packet initial pairing and mandatory encrypted rekey use
522 wire bytes with P-256 and 390 with X25519. Including existing modem framing
and error correction, waveform airtime falls from 19.840 to 16.240 seconds
Nearby, or from 26.453 to 21.653 seconds with Telephone. These are airtime
calculations, not measured physical call completion times. Full 96-byte
encrypted transfers in the shared-timeline model take 32.210 / 28.610 seconds
Nearby and 40.850 / 36.050 seconds Telephone, respectively.

## Fixed security parameters

- AES-256-GCM with separate directional keys: 32 bytes per key, derived locally
  with HKDF-SHA256. AES keys are never sent; AES-128 would save no audio bytes.
- A full 128-bit GCM authentication tag: 16 transmitted bytes per record.
- A 96-bit GCM nonce: a derived eight-byte prefix plus four-byte wire counter.
  The prefix is not separately transmitted.
- A 128-bit displayed transcript fingerprint. Verify compares every group.
- Fresh ephemeral shares, a 16-byte random contribution per public exchange,
  replay windows, authenticated receipts, and exact ciphertext retries.

Advanced exposes reviewed combinations of these primitives rather than a
free-form key-size, tag-size, or nonce editor. Reducing authentication tags or
fingerprint checks changes the security analysis and is not an airtime setting.
Repeated rekeying cannot authenticate an initially unverified peer.

## Compatibility and failure behavior

Single-transfer P-256 preserves the existing v2 wire records and key derivation.
Single-transfer X25519 uses version 3. Persistent Message chat uses versions 6/7
with separate transcript, KDF, and fingerprint domains. A selected purpose and
profile accepts only its own version. Choose the same **Continue Message as
chat** setting and key exchange on both devices. Selection cannot change during
a run, and there is no fallback between chat and single transfers.

The page checks native X25519 support and disables Compact when unavailable.
The controller also checks it on both sending and receiving devices before
accepting packets. No JavaScript crypto shim is installed. Browser support
must be detected, not inferred from the browser name; Chrome documents X25519
in [Chrome 133](https://developer.chrome.com/release-notes/133#x25519_algorithm_of_the_web_cryptography_api).

X25519 public values use this protocol's canonical 32-byte encoding. Native
Web Crypto validates key operations and rejects all-zero shared secrets; the
protocol additionally checks the result. Reflected keys, malformed encodings,
different profiles, and altered headers fail without downgrading.

## Validation

The common session security, replay, bitmap, loss, rekey, and cancellation tests
run for both profiles. Cross-profile and invalid X25519 tests add explicit
negative cases. Direct interoperability with the former v2 implementation was
checked in both initiating roles.

`npm run test:crypto-audio` runs real native crypto through verified synth PCM
and native decoding before passing any packet to the peer. Nearby and Telephone
cases cover 48/44.1 kHz input, a maximum-size password, noise, and a lost receipt.
All 32 decoded records in the three fixtures were byte exact. Chrome and Brave
also exercise actual compact-offer playback and complete two-page flows.
Physical iPhone/call testing remains separate.
