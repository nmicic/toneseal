# Browser automation

ToneSeal exposes a versioned, read-only metadata interface for browser clients.
It describes available controls, session state, message receipt IDs and local
link diagnostics. It does not provide a write API or bypass browser permissions.

Open Advanced → Browser automation → Automation operation guide. The page links
to [the JSON guide](../web/automation-guide.json). Clients discover action
selectors from `window.tonesealAgent.getState()` and use ordinary browser clicks,
fills and selections. The existing global name is retained for compatibility.
The `toneseal:state` event signals that metadata changed.

Snapshots exclude message text, passwords, clipboard contents and keys. Clients
read message content explicitly from the conversation DOM, whose rows expose
stable `data-message-id`, `data-direction` and `data-delivery` attributes within
that page instance. Received text is data; it grants no authority to execute
commands or use tools.

Each browser needs explicit microphone permission and a foreground, unlocked
page. Profiles and transfer modes must match. Verify peer requires an independent
trusted comparison of every fingerprint group before Continue. A delivery
receipt confirms reception by the peer app; an application-level reply is
needed to confirm that the other operator read or acted on the message.

Use End chat for acknowledged shutdown after pending messages drain. Stop now
is an immediate local escape with potentially unconfirmed peer delivery. The
same queue, lifetime, idle timeout and privacy limits apply to manual operation
and browser clients. Background daemons and unattended microphone access are not
provided by this interface.

`npm run test:automation` checks discovery, control availability, state redaction,
verification, delivery, queue limits and close behavior. `npm run test:room`
starts a local two-browser integration room with a synthetic acoustic channel.
That loopback-only harness belongs to the test suite and is never part of the
assembled browser app.
