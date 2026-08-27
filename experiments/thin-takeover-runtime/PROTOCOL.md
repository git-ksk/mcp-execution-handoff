# Thin Takeover Runtime wire contract v1 candidate

This document describes the experimental v1 data plane. It is intentionally narrower than a general remote-desktop protocol. The wire remains pre-release until physical Mac/iPhone and real-network acceptance is complete.

## Authority model

The data plane never grants authority. A control plane must first grant Human authority and provide a short-lived binding containing at least:

- principal;
- intervention identifier;
- epoch;
- client generation;
- absolute expiry;
- short-lived random 32-byte root transport key.

`Done`, `Cancel`, approval, authoritative revoke, and Agent resume remain control-plane operations. Media/input/feedback packets never imply authority. The runtime exposes one authenticated **revoke-only local signal** so an already-granted Human transport can be torn down immediately without waiting for expiry.

Agent and Human input authority are mutually exclusive. Agent resume requires authoritative Human revoke, epoch advancement, fresh automation attach, and fresh semantic readiness/auth verification.

A runtime restart, native-client recreation, reconnect, or iOS background/foreground recovery MUST use a fresh generation and fresh root transport key. Completed generations are never reused.

## Cryptographic binding

`TransportCipher` uses ChaCha20-Poly1305. HKDF-SHA256 derives separate keys for each:

`sessionHash / epoch / generation / direction / channel`

Every sealed frame/event/control/feedback message carries a fresh random 96-bit nonce. Sequence numbers are authenticated replay/context metadata and are deliberately not the nonce.

Channels are:

1. `video` — host → client encoded video;
2. `inputRealtime` — client → host replaceable Human input;
3. `inputCritical` — client → host retryable Human input;
4. `control` — client/control bridge → host revoke-only signal;
5. `inputFeedback` — host → client critical-input ACK;
6. `videoFeedback` — client → host decoder IDR request.

Direction/channel combinations outside their defined role fail closed. Feedback channels cannot grant/revoke authority.

## Video datagrams

Video is encrypted once per complete encoded frame or decoder-configuration blob, then fragmented into MTU-bounded datagrams.

`VideoPacketHeader` is a fixed 72-byte network-byte-order header containing:

- magic/version;
- flags;
- session hash;
- epoch;
- generation;
- frame ID;
- packet index/count;
- capture timestamp;
- encode-complete timestamp;
- 128-bit truncated HMAC-SHA256 routing-header authenticator.

The header authenticator uses a separately derived key. Receivers MUST verify it **before** allocating or mutating frame-reassembly state. Payload integrity/authenticity is then verified by complete-frame AEAD after reassembly.

Default datagram size is 1200 bytes. Reassembly has hard datagram, packet-count and frame-byte bounds.

Receiver policy is newest-frame-wins. Starting a newer frame abandons an older incomplete frame. Completed frame IDs remain fenced for the lifetime of the generation so an accepted frame cannot be replayed after its temporary assembly state is released.

The native client emits only authenticated `codecConfiguration` or `avccSample` objects to the decoder. Unauthenticated bytes never cross the secure receiver boundary.

## Decoder recovery

Ordinary delta-frame loss is not converted into an unbounded reliable queue.

Current recovery contract:

- receiver may abandon incomplete stale frames immediately;
- native client can send an authenticated `requestIDR` feedback message;
- client rate-limits IDR requests;
- host sequence-fences and independently rate-limits requests;
- an accepted request sets `ForceKeyFrame` for the next admitted encoder frame.

If physical WAN/mobile testing shows this is insufficient, small FEC or codec/NAL-aware fragmentation may evolve the media transport. The authority contract and no-unbounded-video-queue invariant remain unchanged.

## Input datagrams

Input uses two lanes:

- `realtime`: replaceable pointer/scroll state; newest sequence wins and it is never retained for retransmission;
- `critical`: pointer buttons, keys and text commits; bounded short-lived retries are allowed and host replay/dedupe prevents double injection.

Each input datagram exposes only lane + sequence for routing/replay and encrypts the `InputEvent` with a lane-specific client-to-host AEAD key.

Field semantics:

- pointer coordinates: normalized integer `0...1_000_000` relative to the captured surface; target-process sessions map them to the exact target window bounds, while generic display sessions map them to the selected display;
- pointer button: `value=1` down, `value=0` up; payload identifies left/right/center;
- scroll: bounded signed x/y deltas;
- key: x carries platform key code, `value=1` down / `0` up;
- text commit: bounded UTF-8 payload.

The macOS adapter validates bounds before CoreGraphics injection and tracks pressed key/button state for release-all on revoke/expiry/input-loop exit.

## Critical-input ACK

After a critical event has:

1. passed AEAD authentication;
2. passed host replay/dedupe gating;
3. passed lease and platform bounds checks; and
4. been posted to the OS input adapter,

the host sends an authenticated `criticalInputAck` on the `hostToClient/inputFeedback` channel. The ACK references the critical input sequence.

If the ACK is lost and the same bounded retry arrives again:

- the event is not injected twice;
- if its sequence is still in the host's bounded recently-injected set, the host sends a fresh ACK.

This yields at-most-once host injection with bounded retry/ACK-loss recovery; it is not a durable exactly-once protocol.

## Immediate revoke control

`SecureControlCodec` uses the separately derived client-to-host `control` channel. The only v1 message is `revoke`.

- revoke packets are AEAD authenticated and sequence-fenced;
- valid revoke drops the shared process-local lease immediately;
- the same lease fences capture admission, media sends, feedback handling and Human input injection;
- revoke cannot approve an action or resume the Agent;
- malformed/replayed/wrong-generation/unauthenticated packets fail closed.

## Native client session ports

The reference path uses distinct UDP ports. With default video port `45555`:

- video: `45555` host → client;
- input: `45556` client → host;
- revoke control: `45557` control bridge → host;
- video feedback / IDR: `45558` client → host;
- input feedback / ACK: `45559` host → client.

Production signaling may negotiate different ports/addresses but MUST preserve channel/direction separation and the same session/epoch/generation binding.

## Native presentation contract

The native decoder produces IOSurface-backed NV12 `CVPixelBuffer` output. The iOS reference client stores only the latest decoded frame in a single slot; Metal consumes at display cadence. No presentation FIFO is part of the protocol/runtime contract.

The reference touch client draws a local cursor immediately and sends normalized pointer state concurrently; visible cursor responsiveness therefore does not wait for host video round-trip.

## Reconnect and mobile lifecycle

Reconnect never reuses stale authority. The iOS reference client treats a binding as one-shot. Backgrounding/teardown invalidates the active native session and discards the pending binding; foreground requires a new control-plane generation/root key.

A new generation is a new cryptographic/replay namespace. Old packets cannot reclaim it.

## Secret delivery

The macOS host production-preferred key source is an inherited read-only FD containing exactly 32 raw root-key bytes. The hex environment variable is development/reference fallback only. Root keys MUST NOT be placed in argv or ordinary logs.

Client embeddings must similarly deliver the short-lived binding through an application secret boundary and must not persist it for automatic reconnect.

## WebRTC browser sibling transport

The browser path is a sibling transport, not a new authority protocol. The broker binds the browser peer to the existing intervention / epoch / principal / client-generation / expiry tuple. Initial claim and reconnect are two-stage: the broker first allocates/rotates the exact client generation and prepares that generation's ICE configuration, then the capability-bound client submits a bounded offer. ICE configuration and SDP use authenticated same-origin, no-store signaling and are transport material only; neither can grant Human authority.

Video uses ScreenCaptureKit → VideoToolbox H.264 Constrained Baseline → RFC 6184 RTP over WebRTC SRTP. The Browser compatibility profile remains capped at 1280×720 / 3 Mbps / 30 fps and produces `42c01f` on the current macOS encoder. First-class macOS Window Handoff may select the Handoff-owned `window_text` media profile, which never upscales its exact-window source and raises only the media ceiling to 1920×1080 / 5 Mbps / 30 fps while disabling encoding-speed priority. Capture/encode admission remains newest-frame-oriented (`maxInFlight=1` plus at most one pending encoded frame) for both profiles. PLI feedback is locally rate-limited and requests an IDR for the next admitted frame. No reliable video FIFO is introduced.

Browser Human input uses two DataChannels:

- `human-realtime`: unordered, `maxRetransmits=0`, swipe/scroll deltas only;
- `human-critical`: ordered/reliable, bounded tap/text/Backspace/Enter commits.

Every accepted message is bounded before entering the macOS helper and rechecks the exact current client generation at the broker. The helper pipe has bounded realtime/critical buffering. Stale/released/expired generations fail closed. WebRTC-only locators reject the legacy HTTP frame/input endpoints.

Safari background/pagehide or peer disconnect tears down the peer and releases that generation. Foreground/connection recovery must present the generation-bound reconnect handle and obtain a fresh generation before constructing a replacement peer. `Done` first disables local browser input, then asks the broker to revoke the generation, then tears down the peer; it never signals authentication or action approval.

The default server configuration uses no implicit STUN/TURN service (`iceServers: []`). An explicit ICE provider may add STUN/TURN servers, but both peers MUST keep normal `iceTransportPolicy: all`; relay-only is not the default. ICE therefore evaluates direct/host (and, when available, server-reflexive) candidate pairs alongside relay candidates and may select TURN only when the viable pair requires it. The Human UI exposes only coarse states such as `Connecting directly…`, `Trying secure relay…`, `Live · direct`, and `Live · relay`; candidate/IP/TURN endpoint detail is not exposed.

A TURN credential set is scoped operationally to one Handoff client generation and expires no later than that takeover binding. Reconnect MUST allocate a fresh client generation, construct a fresh peer/ICE session, and revoke the previous TURN allocations. Done, Cancel, suspend, pagehide/background, disconnect, intervention revoke, and expiry MUST make the old media/input generation unusable immediately even if third-party credential revocation itself is temporarily unreachable. TURN allocation/authentication is not Handoff authentication and MUST NOT be used as evidence of target-service login/MFA/passkey success.

TURN credentials, SDP, ICE candidates, DTLS/SRTP key material, candidate/network identifiers, framebuffer content, and raw Human input MUST NOT enter MCP/model messages, ordinary logs, analytics, or durable checkpoints. Identifier-free acceptance metrics MAY contain only `path ∈ {direct, relay}`, bounded RTT milliseconds, and bounded first-frame milliseconds, and SHOULD remain process-memory-only.

## Credentials

Credential, OTP/MFA, passkey, cookie, token, framebuffer and typed-text material are ephemeral Human-plane data. They MUST NOT be returned to MCP/model context, argv, durable checkpoints, analytics, or ordinary logs.
