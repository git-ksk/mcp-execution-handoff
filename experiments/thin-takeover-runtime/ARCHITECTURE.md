# Thin Takeover Runtime architecture (experiment)

## Design objective

Minimize Human-perceived control latency while preserving an external authority controller that grants and revokes a short-lived takeover deterministically. The runtime is a transport implementation experiment, not a new public `mcp-execution-handoff` API.

## Target split

```text
mcp-execution-handoff control plane
        │
        │ grant / revoke / principal / intervention / epoch
        ▼
Thin Takeover Runtime
        ├─ CaptureAdapter
        ├─ EncoderAdapter
        ├─ TransportAdapter
        ├─ InputAdapter
        └─ LatencyMetrics
```

The control plane remains authoritative. Media possession alone cannot grant control.

## Data plane

### Media plane

- native capture;
- GPU-backed buffers where the platform permits;
- low-delay hardware encoder;
- newest-frame-wins queueing;
- MTU-aware UDP packets;
- no retransmission for ordinary delta-frame packets;
- short-deadline recovery / IDR request for decoder-critical loss.

### Input plane

- pointer/gesture updates: unordered, latest-wins, no retransmit;
- click/key/text: sequenced, deduplicated, bounded retries;
- Done/Cancel/revoke: reliable authenticated control plane.

## Adapters

```text
CaptureAdapter
  macOS: ScreenCaptureKit
  Windows: WGC/DXGI (future)
  Linux: PipeWire/DRM (future)
  Chrome: compositor/native window (future)

EncoderAdapter
  macOS: VideoToolbox
  Windows/Linux: platform hardware encoders (future)

TransportAdapter
  V3: WebRTC (future compatibility path)
  V4: thin native UDP (latency ceiling experiment)
```

## Authority sequence

```text
Agent active
  ↓ fence Agent input
Human grant(intervention, principal, epoch, generation)
  ↓
media/input active
  ↓ Done / Cancel / revoke
Human authority revoked
  ↓ epoch advance
fresh automation attach / fresh semantic verification
  ↓
Agent active
```

## Invariants

- Human and Agent input authority are mutually exclusive.
- Agent cannot resume before Human revocation.
- A stale epoch or generation cannot inject input.
- Video delivery never blocks input delivery.
- Slow receivers do not create an unbounded frame queue.
- Reconnect never revives an expired/revoked intervention.
- Credential text and framebuffer content are not returned to an agent/model control plane.
- The experiment must stay out of the generic public core until more than one real consumer validates the abstraction.
