# Security model

Thin Takeover Runtime is a short-lived Human interaction data plane. It is not an authorization service and not a permanent remote-desktop daemon.

## Security invariants

1. Human and Agent input authority are mutually exclusive.
2. A media/input/control socket never grants Human authority.
3. Every transport binding is short-lived and scoped to session / intervention / epoch / principal / client generation / expiry by the control plane.
4. A runtime restart/reconnect requires a fresh generation and fresh random root transport key; completed generations are never reused.
5. Stale epoch or generation material fails closed.
6. Expired or explicitly revoked local leases stop media admission/transmission and Human input injection.
7. `Done` and `Cancel` are authoritative control-plane operations. Human completion is not proof that authentication or another semantic action succeeded.
8. Agent resume requires revoke, epoch advancement, fresh attach, and fresh readiness/semantic verification.
9. Credential, OTP/MFA, passkey, cookie, token, typed text, and framebuffer contents are not durable control-plane artifacts.
10. No transport error may fall back to unauthenticated media or input.

## Transport protection

The runtime accepts a random 32-byte root key from the authority/control plane. It does not invent a key exchange protocol.

`TransportCipher` derives independent ChaCha20-Poly1305 keys with HKDF-SHA256 for each session/epoch/generation/direction/channel tuple. Each sealed message carries a fresh random 96-bit nonce. Sequence numbers remain authenticated replay/context metadata but are not used as nonces, preventing accidental nonce reuse after a process-local counter reset.

Video is sealed once per encoded frame before fragmentation. Input is sealed per event. Immediate revoke control is sealed per message.

The clear video routing header has a separately derived 128-bit truncated HMAC-SHA256 authenticator. Receivers verify that authenticator before allocating or mutating reassembly state. This prevents an unauthenticated sender from forging a huge/new frame ID or packet count to poison newest-frame state before complete-frame AEAD verification. Reassembly also has hard datagram, packet-count, and frame-byte bounds and remembers the highest completed frame ID for replay fencing.

At host startup, the absolute control-plane expiry is converted once to a monotonic process-local deadline. This avoids extending a grant because of later wall-clock changes. Input and revoke-control sockets bind to loopback by default; remote operation requires an explicitly configured local bind address.

The macOS input adapter tracks pressed keys/buttons and releases all remaining pressed state when the lease ends or the input loop exits. The input receive loop uses a bounded timeout so revoke/expiry is observed even while no Human packets arrive.

## WebRTC browser transport boundary

The browser transport shares the control-plane intervention / epoch / principal / client-generation / expiry binding. HTTP signaling cannot grant Human authority by itself. Every DataChannel input message passes an in-process exact-generation authority check before it can enter the bounded macOS helper pipe. A released, stale, revoked, or expired generation fails closed.

Backgrounding, `pagehide`, peer failure, explicit suspend, Done, Cancel, and expiry all tear down media/input capability. Background/foreground does not resurrect the old peer: reconnect requires the generation-bound reconnect handle and a freshly rotated client generation. WebRTC-only locators reject the legacy HTTP frame/input endpoints, so media failure cannot downgrade to the old button-driven surface.

Werift is configured with `iceServers: []` to prevent implicit third-party STUN discovery. TURN/relay credentials and topology are not part of the current default path and must be reviewed as a separate trust boundary if enabled. Do not log or persist raw Human input, framebuffer/H.264/RTP payloads, SDP/DTLS key material, reconnect handles/capabilities, credentials, OTP/MFA/passkey material, cookies, or target-service tokens.

## Threats explicitly addressed

- AEAD nonce reuse caused by process-local sequence reset;
- video routing-header spoofing before frame authentication;
- packet tampering / content injection;
- completed-frame replay inside a live generation;
- cross-epoch and cross-generation packet replay;
- host-to-client packet reflection into client-to-host channels;
- duplicate critical input injection;
- stale realtime input application;
- stuck key/button state on revoke/expiry;
- use of an already-expired runtime grant;
- transport continuing indefinitely after expiry;
- unauthenticated revoke attempts;
- unbounded frame reassembly allocation;
- reliable-video queue growth causing latency collapse;
- accidental unauthenticated fallback.

## Residual / acceptance risks

The following are not considered solved by synthetic CI and require physical-path validation or embedding policy:

- real mobile/WAN packet loss, burst loss, MTU behavior, congestion, and whether bounded NACK/IDR needs FEC or codec-aware fragmentation;
- actual display presentation/scanout latency and input-to-next-presented-frame latency;
- mobile background/foreground/reconnect lifecycle;
- NAT traversal / relay trust policy;
- Screen Recording / Accessibility permission UX and least-privilege process boundaries;
- secure key injection/destruction in a production embedding (environment variables are only a development/reference path).

## Out of scope for the data plane

The embedding application must provide:

- principal authentication;
- capability issuance and authoritative expiry/revoke;
- intervention lifecycle;
- process/sandbox boundaries;
- NAT traversal / relay trust policy;
- OS permission UX;
- secure destruction/rotation of session keys;
- immediate control-plane Done/Cancel/disconnect/timeout policy.

The authenticated local revoke signal is a teardown mechanism only; it does not replace authoritative control-plane state transitions.

## Logging

Safe logs may contain aggregate latency, packet counts, codec names, frame sizes, and opaque non-secret generation numbers. Do not log root keys, plaintext input, text commits, framebuffer bytes, credential material, cookies, tokens, full takeover URLs/capabilities, or plaintext control messages containing future sensitive operations.

## Reporting

While this code lives inside `mcp-execution-handoff`, follow the repository-level `SECURITY.md` reporting process. If it is later extracted, this security model should move with it unchanged unless the public contract changes.
