# Thin Takeover Runtime architecture

This experiment is intentionally outside the public `mcp-execution-handoff` package contract. It is an extraction-ready, low-latency Human Takeover data plane whose authority comes from a separate control plane.

```text
mcp-execution-handoff / embedding control plane
  └─ authenticates principal
  └─ grants intervention / epoch / generation
  └─ issues short-lived root transport key + absolute expiry
  └─ owns Done / Cancel / revoke / Agent resume
                    │
                    ▼
         Thin Takeover Runtime
  ┌───────────────────────────────────┐
  │ EphemeralSessionLease             │
  │ TakeoverSessionController         │
  │ TransportCipher                   │
  │ VideoPacketizer / Reassembler     │
  │ InputProtocol / SecureInputCodec  │
  │ RecoveryPlanner                   │
  │ LatencyMetrics                    │
  └───────────────────────────────────┘
           │                    ▲
           ▼                    │
     host adapters          client adapters
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
ChaCha20-Poly1305
  ↓
MTU-bounded packet descriptors
  ↓
stack-backed header + scatter/gather non-blocking sendmsg
  ↓
UDP
```

There is no full-frame AVCC→Annex-B reconstruction in the sender hot path. Packet descriptors describe ranges of one sealed frame instead of allocating a `[Data]` containing every UDP packet.

## receive policy

```text
UDP datagrams
  ↓
untrusted fixed header parse
  ↓ hard packet/frame bounds
newest-frame-only reassembly
  ↓
complete sealed frame
  ↓
AEAD verification
  ↓
decoder adapter
```

Starting a newer frame abandons an older incomplete one. Ordinary delta-frame loss is dropped. Decoder-critical keyframe repair has a short NACK deadline and bounded packet count; after the deadline the runtime requests a new IDR. No reliable-video backlog exists.

## input path

```text
Human client
  ├─ realtime pointer/scroll state ─ latest wins
  └─ critical click/key/text ─ bounded retry
            ↓
      per-event AEAD
            ↓
       UDP input lane
            ↓
      verify/decrypt
            ↓
      replay/dedupe gate
            ↓
      lease still active?
            ↓
      platform bounds check
            ↓
      OS input injection
```

The macOS adapter uses CoreGraphics for pointer, buttons, scrolling, keyboard events, and bounded Unicode text commit. Invalid, stale, unauthenticated, expired, or unsupported events are dropped without changing authority.

## expiry and revoke

The control plane supplies an absolute expiry. At process startup it is converted to a monotonic local deadline. The same `EphemeralSessionLease` fences capture admission, media sends, and input injection. Expiry is defense in depth; explicit Done/Cancel/revoke should revoke/terminate the runtime immediately.

The runtime never promotes Human completion into Agent authorization. Fresh Agent attach and semantic readiness verification remain mandatory after Human revoke and epoch advancement.

## latency model

Measure each stage independently:

```text
capture callback
  → encode callback
  → frame AEAD
  → packet send
  → packet receive
  → reassembly / AEAD open
  → decode callback
  → presentation

input creation
  → receive / AEAD open
  → replay gate
  → OS injection
  → next presented frame
```

Queues are a latency budget. The default policy is to drop obsolete work instead of preserving throughput at the cost of freshness.

## portability

The authority, crypto, packetization, reassembly, recovery and input semantics are adapter-neutral. Current concrete host adapter is macOS. Browser, Windows and Linux capture/input adapters should consume the same core rather than introduce platform semantics into the authority layer.

## invariants

- Human and Agent input authority are mutually exclusive.
- Agent cannot resume before Human revocation.
- A stale or expired epoch/generation cannot inject input or continue media delivery.
- Video delivery never blocks input delivery.
- Slow receivers do not create an unbounded frame queue.
- Socket pressure must not block the capture/encoder callback path.
- Reconnect never revives an expired/revoked intervention.
- Credential text and framebuffer content are not returned to an agent/model control plane.
- Platform/product ownership semantics remain outside the generic parent core.
