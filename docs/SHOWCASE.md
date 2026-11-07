# Native signed-enrollment showcase

The main page always shows four tabs: **Message**, **Password**, **Clear text**,
and **Advanced**. Select Advanced for crypto settings and the **Showcase** entry.
Returning to a transfer tab keeps the selected crypto profile. The showcase's
back link returns directly to Advanced.

The showcase is a small example of exchanging public identity material over
audio. It uses the browser's native Web Crypto P-256 ECDSA implementation for
signatures, and the existing encrypted audio sessions for transport. It adds no
third-party library, server, OpenSSL binary, or crypto implementation.

The records are explicitly **custom signed enrollment and approval objects**.
They are not PKCS#10 CSRs or X.509 certificates. Full certificate-chain,
renewal, intermediate-CA and revocation demonstrations belong to the future
native CLI, where standard libraries or installed OpenSSL can perform them.

## Two laptops

1. Select **Advanced → Showcase** on both. Choose the Device role on laptop 1 and the Authority
   role on laptop 2. Create each role's demo identity. Each private signing key
   remains nonextractable and local to that page.
2. Select the same audio and key-exchange profiles on both. Start receiving the
   enrollment on the Authority, then send the Device's enrollment. Compare the
   audio-session fingerprints and Continue on both when requested.
3. The Authority verifies the enrollment's signature. This proves possession
   of the included key, not the real-world identity or account ownership of the
   person who supplied the name. Review it and explicitly approve the request.
4. After the first transfer has completed, start receiving the approval on the
   Device and send the Authority's signed approval. Confirm the new session's
   fingerprints when requested.
5. Independently compare the Authority's full SHA-256 identity fingerprint with
   the Authority screen. Supply that expected fingerprint on the Device before
   accepting its approval. A fingerprint learned solely from the received
   approval is not an independent trust anchor.
6. The Device checks the signature, expected authority, original request and
   public key, and validity period. It accepts that approval once.

Only public signed records cross the audio link. Neither private key is
exported, uploaded, or included in a record. Demo identities live only in the
page's application state; Reset or closing/reloading the page discards them.
JavaScript cannot guarantee physical memory erasure. Keep the page open while
completing the example. Hiding the page stops the microphone and transfer.

## Transport and trust boundaries

An enrollment is about 358 bytes and an approval about 612 bytes with the
default labels. They exceed the ordinary message limit, so the showcase sends
a bounded manifest and numbered fragments within one encrypted session. It
retains exact ciphertext for retries and checks the complete SHA-256 digest
before releasing a received artifact. An authenticated application completion
record distinguishes successful assembly from ordinary message ACKs.

Each artifact is limited to 2,048 bytes and its audio run to ten minutes. The
ordinary three modes retain their existing 96-byte message and three-minute
run limits. The showcase does not execute received data, install a certificate
in the browser/OS, or automatically trust a received public key.

Request and approval signatures use distinct domain strings and strict,
bounded canonical JSON. Requests and approvals each have a one-hour validity
period; the demo relies on reasonably correct device clocks. A matching pin is
required even if a signature is mathematically valid. Altered records, another
device's request, a different authority, expiry, replay, and concurrent duplicate
acceptance are rejected.

The approval authenticates this example's signed object. It does not add
certificate authentication to the audio handshake, validate a public CA chain,
or change the Simple/Verify peer guarantees of the ordinary app.

The [Web Crypto API](https://www.w3.org/TR/webcrypto/#subtlecrypto-interface)
provides native signing and verification primitives, not a complete X.509
trust-store or revocation API for page scripts.
