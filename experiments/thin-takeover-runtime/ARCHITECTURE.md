# Thin Takeover Runtime architecture

This experiment is intentionally outside the public `mcp-execution-handoff` package contract. It is an extraction-ready, low-latency Human Takeover data plane whose authority comes from a separate control plane.

```text
mcp-execution-handoff / embedding control plane
  ├─ authenticates principal
  ├─ grants intervention / epoch / generation
  ├─ issues short-lived root transport key + absolute expiry
  ├─ owns Done / Cancel / authoritative revoke
  └─ owns Agent resume
                    │
                    ▼
         Thin Takeover Runtime
  ┌────────────────────────────────────────┐
  │ TakeoverCore                           │
  │ lease / fencing / crypto / wire        │
  │ packetization / input / feedback       │
  │ recovery / latency                     │
  └────────────────────────────────────────┘
          │                           │
          ▼                           ▼
      macOS host                 native client
 ScreenCaptureKit                iOS / macOS
 VideoToolbox encode             secure receiver
 CoreGraphics input              VideoToolbox decode
                                 Metal presenter
```

## macOS host hot path

```text
ScreenCaptureKit
  ↓ complete frames only
FrameAdmissionGate(maxInFlight: 1)
  ↓
CVPixelBuffer
  ↓
VideoToolbox H.264
  - hardware requested
  - real time
  - no frame reordering
  - zero frame-delay request
  - speed over quality
  - zero lookahead where available
  ↓
AVCC CMBlockBuffer view
  ↓ one AEAD operation per complete encoded frame/config
ChaCha20-Poly1305 + random 96-bit nonce
  ↓
MTU-bounded packet descriptors
  ↓
72-byte authenticated routing header
  ↓
scatter/gather non-blocking UDP
```

There is no full-frame AVCC→Annex-B reconstruction in the sender hot path. Packet descriptors describe ranges of one sealed frame rather than allocating a `[Data]` packet array.

## native receive / presentation path

```text
UDP datagram
  ↓
fixed routing parse + hard datagram bounds
  ↓
HMAC verify before reassembly state mutation
  ↓
bounded newest-frame-only reassembly
  ↓
complete-frame ChaCha20-Poly1305 open
  ↓
AVCC / codec-config dispatch
  ↓
VideoToolbox hardware decode
  ↓
IOSurface-backed NV12 CVPixelBuffer
  ↓
LatestDecodedFrameStore (one slot)
  ↓ display cadence
CVMetalTextureCache
  ↓
Metal NV12→RGB
  ↓
presentation
```

`LatestDecodedFrameStore` intentionally replaces an unpresented old frame with a newer one. It is not a FIFO.

## input and ACK path

```text
Human touch
  ├─ local cursor immediately updates
  ├─ realtime pointer ─ no retry / latest wins
  └─ critical click/key/text ─ bounded retry
             ↓
         per-event AEAD
             ↓
           UDP input
             ↓
      auth + replay/dedupe
             ↓
       lease still active?
             ↓
       CoreGraphics inject
             ↓ success only
     authenticated input ACK
             ↓
 client removes pending retry
```

If an ACK is lost, a bounded duplicate critical event is not injected twice. A recently injected sequence is re-ACKed instead.

## decoder recovery feedback

```text
client detects decode/desync failure
  ↓
authenticated requestIDR
  ↓ client rate limit
UDP video-feedback
  ↓ host replay gate + rate limit
encoder.requestIDR()
  ↓
next admitted frame ForceKeyFrame
```

Input ACK and IDR feedback have separate derived crypto channels and cannot be interpreted as revoke/authority messages.

## revoke / expiry

The control plane supplies an absolute expiry. At host process startup it becomes a monotonic local deadline. The same `EphemeralSessionLease` fences capture admission, media send and Human input injection.

An authenticated revoke-only local control signal can drop that lease immediately. It cannot grant authority, approve an operation, or resume the Agent. Fresh Agent attach and semantic readiness verification remain mandatory after authoritative Human revoke and epoch advancement.

## mobile lifecycle

The iOS reference controller treats one session binding as one-shot:

```text
fresh generation + root key
  ↓
NativeTakeoverClientSession
  ↓
background / teardown
  ↓
discard binding + pending input
  X no automatic reconnect
  ↓
control plane must issue fresh generation + root key
```

This prevents app lifecycle transitions from silently reviving stale Human authority.

## platform and secret boundaries

The macOS host:

- preflights Screen Recording and Accessibility before starting the Human surface;
- requires explicit display ID if multiple displays are capturable;
- maps Human input to the same selected display;
- prefers a 32-byte root key delivered over an inherited FD; hex environment input is development fallback only.

The native client consumes its binding once when constructing a session and does not persist it for automatic reconnect.

## latency model

Measure stages independently:

```text
host:
capture callback
  → encode callback
  → AEAD/header auth
  → packet send

client:
packet receive
  → header verify/reassembly
  → AEAD open
  → decode callback
  → Metal command submit
  → actual presentation/scanout

input:
client event
  → host auth/dedupe
  → OS injection
  → ACK
  → next presented frame
```

Host and client monotonic clocks are not interchangeable. Cross-device glass-to-glass results require physical instrumentation or an explicit clock-correlation method.

## WebRTC browser transport

The install-free browser transport is a sibling data plane under the same Handoff control plane; it does not replace the Native Thin Takeover Runtime.

```text
control plane: intervention / epoch / principal / client generation / expiry
  ↓ authenticated locator claim or fresh reconnect
Handoff WebRTC runtime
  ├─ HTTP signaling: bounded SDP only
  ├─ ScreenCaptureKit → VideoToolbox H.264 Constrained Baseline
  │    → 1280×720 / 30 fps initial Safari acceptance profile
  │    → maxInFlight=1 → latest pending encoded frame only
  │    → RFC 6184 RTP → SRTP/DTLS → Safari playsinline video
  └─ Safari direct tap/swipe/iOS keyboard
       → bounded WebRTC DataChannels
       → exact generation authority gate
       → bounded local helper pipe → CoreGraphics input
```

The realtime DataChannel is unordered with zero retransmissions and carries swipe/scroll deltas only. Critical tap/text/key input is ordered and reliable but is bounded before it reaches the authority gate. WebRTC signaling/media/input state is process-local; framebuffer bytes, raw input, credentials, MFA/passkeys, SDP/DTLS key material, and target-service secrets are not MCP/model/checkpoint artifacts.

Safari lifecycle is fail-closed. `pagehide` / background / peer disconnect destroys the peer and releases that exact client generation. Foreground or connection recovery constructs a new peer only after the broker validates the generation-bound reconnect handle and rotates to a fresh generation. The old capability remains fenced. `Done` revokes broker authority before transport teardown and never means authentication succeeded.

The server explicitly disables Werift's implicit third-party STUN default. Same-network host candidates are the current acceptance path. TURN/NAT traversal is an embedding policy and requires an explicit relay trust review rather than an automatic fallback. PLI requests are rate-limited before asking the macOS encoder for a new IDR.

## portability

`TakeoverCore` keeps authority, crypto, packetization, reassembly, feedback and input semantics platform-neutral. Current concrete host adapter is macOS. `TakeoverNativeClient` supports iOS/macOS compilation. Windows/Linux host adapters should consume the same core rather than introduce platform ownership semantics into it.

## invariants

- Human and Agent input authority are mutually exclusive.
- Agent cannot resume before authoritative Human revocation.
- A stale/expired generation cannot inject input or continue media delivery.
- Runtime restart/reconnect requires a fresh generation/root key.
- Video delivery never blocks input delivery.
- Slow receivers do not create an unbounded frame or presentation queue.
- Critical retries do not cause duplicate OS injection.
- Feedback can request recovery or acknowledge injection, never change authority.
- Reconnect never revives an expired/revoked intervention.
- Credential text and framebuffer content are not returned to agent/model control-plane state.
