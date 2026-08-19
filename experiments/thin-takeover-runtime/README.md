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
- descriptor-based packetization for the hot path;
- monotonic latency metrics;
- UDP sender/receiver;
- non-blocking scatter/gather UDP send for encoded payload slices;
- bounded frame admission so encoder work cannot create an unbounded stale-frame queue;
- localhost packetization / full-frame delivery probes.

The macOS host prototype contains:

- ScreenCaptureKit display capture;
- complete-frame filtering from ScreenCaptureKit metadata;
- VideoToolbox H.264 hardware-acceleration request;
- real-time encoding mode;
- frame reordering disabled;
- zero max-frame-delay request;
- low-latency rate-control encoder request;
- speed-over-quality encoding hint;
- zero-lookahead request;
- 60 fps capture target;
- minimum ScreenCaptureKit queue depth of three;
- encoder `maxInFlight=1` admission mode;
- descriptor/scatter-gather UDP packetization path.

## Portable checks

```bash
swift test
swift build -c release
swift run -c release takeover-packet-bench 2000 131072
swift run -c release takeover-loopback 400 32000 1
swift run -c release takeover-loopback 200 131072 16
```

The reported transport timings are **not glass-to-glass latency**. They measure only local packetization/send/receive overhead and exist to expose accidental CPU copies, queueing and burst-loss regressions.

Synthetic Linux/x86_64 development-container results from 2026-08-20:

- 128 KiB packetization, 2000 frames: copy-heavy reference roughly 311–339 ms total versus descriptor path roughly 0.5–0.8 ms in repeated runs;
- 32 KiB full-frame localhost UDP at 1 ms pacing: 100% packet delivery / 100% frame completion; complete-frame p50 roughly 0.10–0.15 ms;
- 128 KiB burst/keyframe stress at 16 ms pacing: packet delivery stayed near 99%+, but frame completion fell below 100% with the intentionally non-blocking sender.

The large-frame stress result is intentional evidence: the runtime must solve keyframe burst pacing/recovery explicitly rather than hiding pressure inside a blocking socket or unbounded queue.

## macOS host probe

Requires macOS 14+ and Screen Recording permission.

```bash
swift run takeover-macos-host 127.0.0.1 45555
```

The macOS slice is sender-only and must be validated on a real Mac before any promotion beyond `experiments/`. Planned slices:

1. real-Mac capture → VideoToolbox encode latency p50/p95/p99;
2. native receiver + VideoToolbox decode/render;
3. bounded keyframe packet pacing + short-deadline IDR recovery comparison;
4. input datagrams with separate realtime/critical semantics;
5. authenticated ephemeral session key + AEAD packet protection;
6. NAT traversal / relay provider;
7. browser/Chrome capture adapter;
8. Windows/Linux capture adapters.

## Security boundary

Possession of a media socket is **not** Human authority. Every future input/control message must be bound to a short-lived authenticated takeover session, intervention, epoch, principal and client generation. Human and Agent input authority must remain mutually exclusive. Agent resume is rejected while Human authority remains active.

Credential text and framebuffer content must never be returned to the requesting model/MCP control plane or persisted as durable handoff state.

## Dependency / license note

This experiment is covered by the repository's MIT license. Sunshine, Selkies, RustDesk and similar remote-display systems are architecture/performance references only; no code is copied from them here.
