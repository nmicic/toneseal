# ToneSeal trust model

ToneSeal carries short messages and secrets over audio. A nearby acoustic link
or a telephone call is a transport path; the protocol must still decide who is
allowed to receive a secret and which received data an application may trust.
Hosting is separate from the audio session protocol.

## Current behavior

- **Cleartext test** provides checksums and delivery receipts, without encryption
  or peer authentication.
- **Simple** encrypts the connection but does not authenticate the initial peer.
  Its automatic rekey confirms continuity with that peer, not the peer's identity.
- **Verify peer** waits for the user to compare fingerprints and confirm. That
  comparison is only as trustworthy as the way the user checks the other screen
  or communicates with the other person.

A fingerprint sent automatically over the same unverified audio path supplies
no independent identity evidence. Reading it aloud can be a useful human check,
but the design must not assume that call routing or audible beeps make active
interception impossible. Account ownership and support-agent authorization stay
with the service's own verification process.

The audio-session protocol does not implement certificate validation, pinned
identity keys, signed handshake records, or automatic execution of received data.
The following is a design direction, not an additional security mode already
available in the app.

The separate [signed-enrollment showcase](SHOWCASE.md) uses native browser
signatures and an explicitly entered authority fingerprint to accept a custom
demo approval. That pin authenticates the approval object. It does not bind a
certificate identity to the audio handshake, install an OS/browser trust anchor,
or implement X.509 path validation, renewal, or revocation.

## Existing PKI can supply the trust anchor

A robot or support client may already trust a manufacturer's or organization's
public key. An application can validate a signed object against that key after
ToneSeal carries it. The object's recipient, purpose, and freshness requirements
still need to be checked; an old valid signature alone does not make a replayed
bootstrap instruction acceptable.

Validating an object's signer is different from authenticating the current
encrypted peer. If a secret must be disclosed only to a particular recipient,
the sender must authenticate that recipient's session before sending the secret.
A trusted signature on unrelated data does not bind the recipient's ephemeral
encryption key to the expected identity.

## Authenticate the fresh exchange

A future identity mode should use a reviewed authenticated key-exchange design.
For a signature-based extension, the signed transcript must bind both ephemeral
key shares, both roles, fresh challenges/nonces, protocol version, and relevant
session/application context. Each peer must verify the required identity and
finish key confirmation before releasing protected application data. This is
the same architectural separation illustrated by TLS 1.3's transcript-bound
CertificateVerify and Finished messages; ToneSeal does not currently implement
TLS or inherit its security proof. See [RFC 8446, sections 4.4.3–4.4.4](https://www.rfc-editor.org/rfc/rfc8446.html#section-4.4.3).

The application must specify whether it authenticates the sender, recipient,
or both. A support service may authenticate itself to the client with a pinned
key while using a separate process to establish the caller's account ownership.
Robot enrollment may require authorization of the provisioning operator as well
as authentication of the robot.

## Provisioning and lifecycle

An unauthenticated first audio exchange must not silently install its own trust
anchor. Pinned keys need a defined installation, replacement, and recovery
process. Certificate-based trust additionally requires the application's
certificate/path validation and authorization policy, including applicable
validity, usage, and revocation checks. [RFC 5280, section 6](https://www.rfc-editor.org/rfc/rfc5280.html#section-6)
defines certificate path validation with a separately supplied trust anchor.

Slow or narrowband audio should change the physical transmission profile, not
remove authentication or integrity checks. Fresh authenticated session state,
replay handling, bounded retries, and explicit Stop behavior remain necessary
regardless of how long a packet takes to play.
