# Audio profiles and telephone relay

The first physical call experiment uses two laptops and two phones:

```text
Laptop A ⇄ phone A on speaker ⇄ telephone call ⇄ phone B on speaker ⇄ Laptop B
```

The apps use the laptops' microphones and speakers. They do not capture another
app's call audio on iOS or Android. The call must carry sound in both directions:
fresh encrypted pairing, rekey, data, and acknowledgments all need return audio.
Recording one side alone is not the current automatic exchange.

## Choose the audio connection

The automatic page has an **Audio connection** selector. Choose the same option
on both devices before pressing Start:

| Option | Tone range | Symbol duration | Maximum 128-byte packet audio |
| --- | ---: | ---: | ---: |
| **Nearby · faster** (default) | 600–3750 Hz | 20 ms | 4.16 s |
| **Telephone · slow (experimental)** | 450–2812.5 Hz | 26.667 ms | 5.55 s |
| **Near-ultrasonic · very slow (experimental)** | 18400–19975 Hz centers | 40 ms | 8.32 s |

Telephone plays the existing modem waveform at 0.75 of its normal speed. The
receiver compensates for that rate before decoding. Packet framing, the native
modem, encryption, peer verification, and receipts are unchanged. Each packet
takes 33.3% longer on air; the complete exchange also includes turns, processing,
and retries, so this percentage is not an end-to-end completion-time guarantee.

Near-ultrasonic uses a separate verified JotTune Synth timeline and a matching
mixer/low-pass receiver front end. It is intended for nearby devices held still,
not ordinary phone calls. The same packet framing, cryptography and receipts
apply. Physical device compatibility remains unqualified: high-frequency
filtering, microphone clipping and room acoustics can prevent reception, and
the tones are not guaranteed inaudible. The browser and C CLI support it; the
enrollment showcase retains Nearby/Telephone. Test with dummy Clear text first.
The selected idle timeout does not grow automatically; Advanced's two-minute
option provides more time to recover lost slow turns.

There is **no automatic profile negotiation or fallback**. A Nearby sender and
a Telephone receiver are not a supported pair. To change the connection, stop
both devices, select the same option, and start a new exchange. Retry waits
allow for the longer Telephone packets. Turn and echo delays, and the overall
three-minute run limit, remain physical elapsed time.

Nearby remains the default for devices in the same room. Telephone is an
experimental option for testing calls, not a claim that every landline, mobile,
or VoIP route supports the waveform.

## Codec diagnostics

After building the web assets:

```sh
npm run test:telephone
node tests/telephone-profiles.mjs
node tests/telephone-profiles.mjs --rates 0.75 --patterns 12 --output out/telephone-profiles-extended.json
npm run test:report
```

`tests/telephone-channel.mjs` renders real synth packets of 18, 84, and 128 bytes
using the Nearby profile, passes them through the selected transforms, and
decodes them with the native
receiver. It writes `out/telephone-channel.json`. FFmpeg and SoX are optional
local dependencies and are never installed automatically. The report records
their versions and the renderer/receiver hashes. No real call is recorded.

The initial Nearby-profile results were:

| Path | Exact packets recovered |
| --- | ---: |
| Unimpaired 48 kHz control | 3/3 |
| Synthetic 300–3400 Hz bandpass | 3/3 |
| 8 kHz PCM round trip | 3/3 |
| G.711 μ-law or A-law | 3/3 each |
| Bandpass plus G.711 μ-law | 3/3 |
| G.722, 16 kHz / 64 kbit/s | 3/3 |
| Opus VoIP, narrowband 12 kbit/s | 3/3 |
| Opus VoIP, wideband 24 kbit/s | 3/3 |
| GSM full rate | 1/3: only the short packet |
| AMR-NB / AMR-WB | Not tested |

Zero corrupt packets were accepted. A partial or no-decode result is an observed
incompatibility, not a reason to weaken integrity checks. The test command
asserts the clean control and byte accuracy; successful exit does **not** mean
every telephone path worked.

The Nearby tone profile spans 600–3750 Hz. Conventional telephony's nominal band
is 300–3400 Hz, but the current redundancy survived these particular filtered
fixtures. The GSM full-rate losses are more concrete evidence against claiming
general call compatibility. AMR, GSM full rate, and Opus are different codecs;
one does not qualify another. See [ITU-T P.341](https://www.itu.int/epublications/publication/itu-t-p-341-2011-03-transmission-characteristics-for-wideband-digital-loudspeaking-and-hands-free-telephony-terminals)
and [RFC 4867 on AMR/AMR-WB](https://datatracker.ietf.org/doc/html/rfc4867#section-3).

`tests/telephone-profiles.mjs` compares reversible speed changes to the same
real synth waveform and decodes with the native streaming receiver. It requires
both FFmpeg and SoX with GSM support. The default matrix uses nine fixtures:
84, 113, and 128 bytes, each with a deterministic ramp and two seeded patterns.
The decoded packets must match the input bytes exactly.

| Playback rate | Clean | 300–3400 Hz bandpass | Bandpass + G.711 μ-law | Bandpass + GSM full rate |
| --- | ---: | ---: | ---: | ---: |
| 1 (Nearby) | 9/9 | 9/9 | 9/9 | 3/9 |
| 0.75 (Telephone) | 9/9 | 9/9 | 9/9 | 9/9 |
| 2/3 (diagnostic candidate) | 9/9 | 9/9 | 9/9 | 9/9 |
| 0.5 (diagnostic candidate) | 9/9 | 9/9 | 9/9 | 9/9 |

The fastest passing candidate in this matrix was 0.75. An expanded run tested
36 fixtures at that rate: the three packet sizes with a ramp and eleven seeded
patterns each. All four paths recovered **36/36 byte-exact packets**, for 144
successful decodes and zero corrupt packets accepted. The matrix and expanded
reports are `out/telephone-profiles.json` and
`out/telephone-profiles-extended.json`. The profile diagnostic asserts the clean
control and byte accuracy; it records channel failures without treating them as
a successful compatibility result. Its successful exit alone does not mean all
channel paths decoded every packet.

These measurements qualify only those synthetic codec paths. They do not test
actual calls, AMR-NB/AMR-WB, handset processing, capture-clock drift, real room
echo, AGC, noise suppression, VAD/DTX, network loss, concealment, or tandem
transcoding. A successful GSM full-rate simulation does not establish support
for a route using a different speech codec or several codecs in sequence.

## First physical call test

1. Put laptop A with phone A at one end of the call, and laptop B with phone B
   at the other. Use separate locations, or rooms far enough apart that the
   laptops cannot hear one another directly. Connect the call and enable
   speakerphone on both handsets. Each laptop needs to hear its local phone's
   speaker, and that phone needs to hear the laptop's speaker.
2. Open the same current app URL on both laptops. Select **Telephone · slower
   (experimental)** under Audio connection on both, then **Cleartext test**.
   Keep both pages visible and unlocked, and the call connected.
3. Leave laptop B's input empty and press **Start receiving**. On laptop A,
   press **Send example**. Wait for the text on B and **Delivery confirmed** on A;
   the receipt and final confirmation also travel through the call.
4. Stop the completed run on both if needed. Repeat in the other direction,
   then test maximum-length dummy messages. Only one laptop should have text
   entered in each run.
5. Try encrypted **Message**, then a dummy **Password**, with the same Telephone
   selection on both sides. Test **Verify peer** by comparing every fingerprint
   group and pressing **Continue** on both. Keep the receiver open until the
   sender confirms delivery, then use **Copy** for a received password.
6. Record the route, devices, elapsed time, retries and byte accuracy. Record the
   negotiated codec only when it can actually be observed; a carrier or phone
   label does not establish which codec traversed the entire route.

## Short-secret product scope

Password handoff, support recovery tokens, and robot enrollment keys fit the
short-message channel. A general terminal stream can remain a later experiment.
For support recovery, prefer a short-lived, single-use reset/enrollment token
where the service supports it, and retain the service's caller-verification
process. The transport cannot establish account ownership by itself.
[OWASP's recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
also recommends expiring, single-use recovery tokens.

For an unattended robot, the bootstrap design needs a way to authenticate the
device or operator, such as a previously pinned public key or independently
checked fingerprint. Simple-mode encryption and a second rekey alone do not
provide that first identity check. The ordinary message channel should not
silently become a command-execution interface.

A telephone call is a useful two-party transport, but a call being unicast or
the tones being audible does not authenticate the peer or rule out interception
or injection. Reading a fingerprint aloud is useful only when the comparison
cannot itself be substituted. If a device already trusts a signing key or
certificate, its enrollment protocol can require an appropriately signed
message carried by ToneSeal; that application-level trust check is separate
from the current audio session and is not implemented by this profile switch.

## Native Linux/macOS CLI

The live C client now implements Message, Password, Clear text and chat using
installed OpenSSL 3, PortAudio and the external JotTune Synth SDK. It supports
Nearby, Telephone and the experimental Near-ultrasonic profile. It also retains
WAV/TL diagnostics and byte-exact text conversions. See [native CLI instructions](NATIVE-CLI.md)
for builds, browser pairing, limits and the automated-versus-physical test scope.
