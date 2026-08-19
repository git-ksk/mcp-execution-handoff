# Thin Takeover Runtime experiment

> **Experimental / unstable.** This directory is intentionally outside the public `mcp-execution-handoff` contract. Nothing here is exported by the npm package or treated as a supported provider API. If the approach proves useful across consumers, it may later move to a separate repository.

This experiment explores an ultra-low-latency Human Takeover media/input plane for short-lived, authority-fenced remote interaction. It is intentionally **not** a general-purpose remote desktop.

## V0 architecture

```text
macOS ScreenCaptureKit
        ↓
VideoToolbox H.264 (real-time / low-latency)
        ↓
MTU-bounded thin packetizer
        ↓
UDP media plane
        ↓
future native client

Human input (next slice)
        ↓
separate deadline-aware input plane
        ↓
authority / epoch / generation validation
```

The platform-neutral core contains:

- exclusive Agent/Human authority controller;
- intervention/epoch/generation fencing primitives;
- MTU-bounded video datagram header + packetizer;
- monotonic latency metrics;
- UDP sender/receiver;
- a localhost first-packet overhead probe.

The macOS host prototype contains:

- ScreenCaptureKit display capture;
- VideoToolbox H.264 hardware-acceleration request;
- real-time encoding mode;
- frame reordering disabled;
- low-latency rate-control encoder request;
- 60 fps capture target;
- small capture queue;
- UDP packetization path.

## Portable checks

```bash
swift test
swift build -c release
swift run -c release takeover-loopback 800
```

The reported `udp_first_packet_latency_ms` is **not glass-to-glass latency**. It measures only local packetize/send/receive overhead and exists to catch accidental transport overhead/regressions. The probe packetizes a full synthetic encoded frame but sends only its first datagram so the benchmark itself does not create an artificial localhost receive backlog.

## macOS host probe

Requires macOS 14+ and Screen Recording permission.

```bash
swift run takeover-macos-host 127.0.0.1 45555
```

The macOS slice is sender-only and must be validated on a real Mac before any promotion beyond `experiments/`. Planned slices:

1. native receiver + VideoToolbox decode/render;
2. input datagrams with separate realtime/critical semantics;
3. authenticated ephemeral session key + AEAD packet protection;
4. NACK/IDR recovery with deadlines and no unbounded retransmission;
5. NAT traversal / relay provider;
6. browser/Chrome capture adapter;
7. Windows/Linux capture adapters.

## Security boundary

Possession of a media socket is **not** Human authority. Every future input/control message must be bound to a short-lived authenticated takeover session, intervention, epoch, principal and client generation. Human and Agent input authority must remain mutually exclusive. Agent resume is rejected while Human authority remains active.

Credential text and framebuffer content must never be returned to the requesting model/MCP control plane or persisted as durable handoff state.

## Dependency / license note

This experiment is covered by the repository's MIT license. Sunshine, Selkies, RustDesk and similar remote-display systems are architecture/performance references only; no code is copied from them here.
