# First transfer: Device 1 and Device 2

Use this order for the first test. **Device 1 sends the first message. Device 2
receives it.** For encrypted transfers, Device 1 chooses **Start pairing** and
Device 2 chooses **Answer pairing**. Keep those device names throughout.

**Prepare makes audio ready; it does not play sound.** Every transfer needs three
separate actions: the receiving device taps **Listen**, the sending device taps
**Play packet**, then the receiving device taps **Stop & decode**. Wait until the
sound has finished, leave a short quiet interval, and then stop and decode.

Keep both pages visible and both phones unlocked. Use the same app version on
both devices. Start with the phones close together in a quiet room, at a
comfortable playback volume. Allow microphone access when each phone first
listens. A capture lasts at most 20 seconds, so prepare the sender before
starting the receiver's capture.

## Cleartext: check that sound reaches the other phone

1. **Both devices:** select **Cleartext lab**. Pairing is not needed in this mode.
2. **Device 1:** type `Hello from Device 1` in the message field.
3. **Device 1:** tap **Prepare cleartext message**. Wait until the packet is ready.
   Nothing has played yet.
4. **Device 2:** tap **Listen** and allow microphone access. Wait until the page
   says it is listening.
5. **Device 1:** tap **Play packet**. Let the entire sound finish.
6. **Device 2:** tap **Stop & decode** after the short quiet interval.
7. **Device 2:** check **Received**. It should contain exactly
   `Hello from Device 1`. Cleartext has no delivery receipt to send back.

If no message appears, do not start encrypted pairing yet. Repeat steps 4–6
using the same prepared packet, and check microphone permission, playback
volume, distance, and room noise. A message saying **No packet recovered** means
no transfer was accepted; hearing the sound alone does not establish reception.

## Encrypted pairing: four sound transfers before sending a message

The setup sends an offer, an answer, Device 1's confirmation, and Device 2's
confirmation. Tapping the two pairing buttons alone does not complete setup.

| Step | Device | Action | What should happen |
| --- | --- | --- | --- |
| 1 | Both | Select **Encrypted message**. If a previous attempt is still active, tap **Disconnect** on both first. | Both are ready to start a new pairing. |
| 2 | Device 1 | Tap **Start pairing**. | A **Pairing offer** is prepared. Wait for preparation to finish. |
| 3 | Device 2 | Tap **Answer pairing**, then **Listen**. Allow microphone access if asked. | Device 2 is listening for the offer. |
| 4 | Device 1 | Tap **Play packet**. | The offer plays from Device 1 to Device 2. |
| 5 | Device 2 | After the sound finishes, tap **Stop & decode**. | Device 2 receives the offer and prepares a **Pairing answer**. Its fingerprint appears. |
| 6 | Device 1 | Tap **Listen**. Allow microphone access if asked. | Device 1 is listening for the answer. |
| 7 | Device 2 | Tap **Play packet**. | The answer plays from Device 2 to Device 1. |
| 8 | Device 1 | After the sound finishes, tap **Stop & decode**. | Device 1's fingerprint appears too. |
| 9 | Both | Compare **every one of the eight fingerprint groups** on the two screens. | All groups must match exactly. If they do not, disconnect on both and stop this attempt. |
| 10 | Device 1 | If all groups match, tap **All groups match · confirm peer**. | A **Peer confirmation** is prepared. This button does not play it. |
| 11 | Device 2 | Tap **Listen**. | Device 2 is listening for Device 1's confirmation. |
| 12 | Device 1 | Tap **Play packet** and let it finish. | Device 1's confirmation plays to Device 2. |
| 13 | Device 2 | Tap **Stop & decode**. | Device 2 accepts Device 1's confirmation. Device 2 must still confirm and send its own confirmation. |
| 14 | Device 2 | Tap **All groups match · confirm peer**. | Device 2 prepares its **Peer confirmation**. |
| 15 | Device 1 | Tap **Listen**. | Device 1 is listening for Device 2's confirmation. |
| 16 | Device 2 | Tap **Play packet** and let it finish. | Device 2's confirmation plays to Device 1. |
| 17 | Device 1 | Tap **Stop & decode**. | Both devices have now confirmed and exchanged their confirmations. Pairing is complete. |

The audio directions are:

```text
Device 1  ── offer ──────────────>  Device 2
Device 1  <─ answer ──────────────  Device 2
             compare both screens
Device 1  ── confirmation ───────>  Device 2
Device 1  <─ confirmation ────────  Device 2
             ready for messages
```

Do not proceed past a receive step if the page reports **No packet recovered**
or **Packet refused**. Repeat that sound transfer before continuing. A prepared
reply is evidence of progress; a listening microphone or audible tone alone is
not.

## Send the first encrypted message and acknowledge it

Continue with the same paired devices:

1. **Device 1:** type `Hello from Device 1` in the message field. A blank field
   keeps **Prepare encrypted message** disabled even after pairing.
2. **Device 1:** tap **Prepare encrypted message** and wait for preparation to
   finish. Nothing has played yet.
3. **Device 2:** tap **Listen**.
4. **Device 1:** tap **Play packet** and let it finish.
5. **Device 2:** tap **Stop & decode**. Check that **Received** contains the exact
   message. Device 2 also prepares a **Delivery receipt** automatically.
6. **Device 1:** tap **Listen**.
7. **Device 2:** tap **Play packet** to send the receipt back.
8. **Device 1:** tap **Stop & decode**. Its delivery status should now confirm
   receipt by the peer.

To send in the other direction, Device 2 becomes the message sender and Device 1
becomes the receiver. They remain the same paired devices; do not start pairing
again.

## Transfer a dummy password

Complete pairing and the first message/receipt exchange above first.

1. **Both devices:** select **Password transfer**. Switching directly between
   **Encrypted message** and **Password transfer** keeps the session paired.
2. **Device 1:** paste a dummy password, such as `Audio-test-only_42!`, into the
   password field. Use **Paste from clipboard**, or the phone's usual Paste
   command if clipboard reading is unavailable.
3. **Device 1:** tap **Prepare encrypted password**. The sending password field
   clears when the password has been encrypted.
4. **Device 2:** tap **Listen**. **Device 1:** then taps **Play packet**.
5. **Device 2:** after the sound finishes, tap **Stop & decode**. The received
   password appears as a masked field, and a **Delivery receipt** is prepared.
6. **Device 1:** tap **Listen**. **Device 2:** tap **Play packet**. **Device 1:**
   tap **Stop & decode** after the sound to confirm delivery.
7. **Device 2:** tap **Copy**, then switch to the destination app and paste.
   Receiving a password never copies it automatically.

Copy before the received password clears after 60 seconds. Hiding the page also
clears its received password field, so copy before switching apps. The system
clipboard can retain or sync its copy independently of this page.

Do not switch through **Cleartext lab** during this sequence: entering or
leaving cleartext mode disconnects the encrypted session. Do not refresh session
keys during the first transfer; that is a separate optional exchange.

## If Prepare is still grey

Read the explanation beside the button and the next-action panel. These are the
conditions that can prevent preparation:

| Situation | What to do |
| --- | --- |
| Pairing has not finished | Complete all four setup sound transfers, including both confirmations. |
| You tapped Confirm but did not play it | Have the other device listen, play the prepared confirmation completely, then stop and decode on the other device. |
| A required answer, confirmation, or delivery receipt is prepared | Play that packet to the listening peer before preparing another message. |
| The message/password field is empty | Enter a short dummy message or password. |
| The text exceeds the byte limit | Shorten it to at most 96 UTF-8 bytes for encrypted transfer or 127 for cleartext. Some characters use several bytes. |
| The page is listening, playing, preparing, or decoding | Finish the current action, or tap **Stop** to cancel audio work. |
| A page was hidden during pairing | Tap **Restore last packet** on the sender to prepare the pending packet again, then repeat that sound transfer. |
| A message or receipt was lost | On the message sender, tap **Resend unacknowledged**, have the peer listen, and play it again. The peer returns a fresh receipt without displaying the message twice. |
| The session expired or the steps no longer line up | Tap **Disconnect** on both devices and restart pairing from step 1. |

The message field itself can be filled before pairing. An enabled text field
does not mean the encrypted channel is ready. Conversely, an empty text field
keeps Prepare disabled even when pairing is complete.
