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
- accepts an optional consumer-bound target process ID; if present, exactly one eligible on-screen window must resolve and be fully contained in one capturable display;
- uses a one-window ScreenCaptureKit inclusion filter plus display-local source cropping and maps Human input to that exact window bounds;
- commits ordinary non-secure focused AppKit text through `AXSelectedText` only after exact-window, PID, and non-web ancestry revalidation, while unsupported controls retain the bounded keyboard-event path and mismatches fail closed; route diagnostics expose only a bounded payload-free stage;
- without a target process, retains explicit display selection when multiple displays are capturable and maps input to that display;
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
  ↓ prepare ICE for that exact generation (direct-only, or short-lived STUN/TURN)
Handoff WebRTC runtime
  ├─ no-store HTTP signaling: bounded ICE configuration + bounded SDP
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

The Safari surface also has a client-local precision transform bounded to 1×–4×. Two-finger pinch/pan and zoomed one-finger pan mutate only the rendered video transform; they do not send DataChannel input or modify the target browser/page zoom. Stationary taps are mapped through the transformed video bounds back to normalized exact-window coordinates. Reconnect and orientation change reset the transform so stale client geometry cannot carry across a new media generation.

Safari lifecycle is fail-closed. `pagehide` / background / peer disconnect destroys the peer and releases that exact client generation. Foreground or connection recovery constructs a new peer only after the broker validates the generation-bound reconnect handle and rotates to a fresh generation. The old capability remains fenced. `Done` revokes broker authority before transport teardown and never means authentication succeeded.

The server explicitly disables Werift's implicit third-party STUN default. No provider preserves direct-only behavior. TURN providers are owned by the Handoff runtime, not a consumer such as Maps. `CloudflareRealtimeTurnCredentialProvider` obtains two independent short-lived credential sets from Cloudflare after generation binding. `CoturnRestTurnCredentialProvider` derives two independent coturn TURN REST credentials locally from a server-only shared secret using `timestamp:random` usernames plus base64 HMAC-SHA1. One credential set is returned to the browser in no-store signaling and one is retained for the Werift peer. Werift/browser both use normal `iceTransportPolicy: all`; host/direct candidates stay eligible and a relay candidate is used only if ICE selects it. A credential-provider failure does not switch to a different relay or a weaker transport: direct remains eligible and the UI reports relay unavailable if WAN establishment fails.

The relay is a distinct network trust boundary, not an authority boundary. It can observe relay-visible network metadata and encrypted traffic characteristics, but Handoff does not attach principal/intervention/client identifiers to relay credentials or analytics. TURN credential success cannot advance authentication or Agent authority. Suspend/disconnect/Done/Cancel/expiry/reconnect always revoke the generation's Handoff ICE/media/input session. Cloudflare supports active short-lived allocation revoke; coturn REST credentials instead expire at the same generation deadline and cannot by themselves re-establish broker authority. PLI requests remain rate-limited before asking the macOS encoder for a new IDR.

For acceptance comparisons, the browser derives only the selected path class (`direct` or `relay`), candidate-pair RTT, and first-video-frame latency from local WebRTC stats/timing. It sends only those bounded numeric/path fields through a generation-capability-verified endpoint. Candidate IDs, addresses, ICE/TURN endpoints, credentials, and network identifiers are rejected and the runtime keeps at most a bounded process-memory sample window.

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
