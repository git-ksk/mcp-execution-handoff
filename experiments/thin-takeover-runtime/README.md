# Thin Takeover Runtime — v0.1 candidate

> **Extraction-ready experiment.** This code currently lives under `mcp-execution-handoff/experiments` so it does not widen the parent package's public API. The runtime is designed to move to a standalone MIT-licensed repository once physical-device acceptance is complete.

Thin Takeover Runtime is an ultra-low-latency media/input plane for **short-lived, authority-fenced Human Takeover**. It is deliberately not a permanent remote-desktop server.

## What is implemented

```text
Human authority from control plane
        │
        ├─ short-lived session / epoch / generation / root key
        │
macOS ScreenCaptureKit
        ↓
VideoToolbox H.264
  real-time / no reorder / zero lookahead
        ↓
maxInFlight=1
  stale capture frames drop instead of queue
        ↓
ChaCha20-Poly1305 once per encoded frame
        ↓
MTU-bounded descriptor packetizer
        ↓
scatter/gather non-blocking UDP
        ↓
network
        ↓
bounded newest-frame reassembly
        ↓
AEAD verify
        ↓
VideoToolbox/native decoder adapter

Human input
        ↓
realtime lane  ─ latest wins
critical lane  ─ bounded retry + dedupe
        ↓
per-event AEAD
        ↓
bounded platform input adapter
```

The core currently includes:

- exclusive Agent/Human authority controller;
- intervention / epoch / client-generation fencing primitives;
- frame admission (`maxInFlight=1`) to prevent stale encoder queues;
- fixed-size MTU-aware video header and zero-copy-oriented packet descriptors;
- non-blocking scatter/gather UDP send;
- bounded newest-frame-only receiver reassembly;
- frame-level ChaCha20-Poly1305 with HKDF-SHA256 directional/channel keys;
- binary input protocol with realtime vs critical semantics;
- secure input datagrams and replay/deduplication gate;
- deadline-bounded keyframe NACK / rate-limited IDR recovery planner;
- monotonic latency metrics;
- packetization, UDP, AEAD, hardware encode and hardware codec round-trip benchmarks.

The macOS host includes:

- complete ScreenCaptureKit frame filtering;
- 60 fps target and minimum capture queue;
- VideoToolbox hardware H.264 request;
- real-time mode, no B-frame reordering, zero frame delay request;
- speed-over-quality and zero-lookahead hints;
- AVCC-native encoder output;
- authenticated frame transport;
- fail-closed startup if the control-plane session binding is absent.

## Build and test

Requires macOS 14+ for the host. The core and benchmarks are exercised on ARM64 macOS CI.

```bash
swift test
swift build -c release
swift run -c release takeover-crypto-bench 32000 2000
swift run -c release takeover-packet-bench 2000 131072
swift run -c release takeover-vt-bench 1280 720 180 20
swift run -c release takeover-vt-codec-bench 1280 720 120 20
```

See [BENCHMARKS.md](BENCHMARKS.md) for current numbers and methodology.

## macOS authenticated host

The host intentionally has no insecure default session. A control plane must provide a short-lived binding:

```bash
export THIN_TAKEOVER_SESSION_KEY_HEX=<64 hex chars / 32 random bytes>
export THIN_TAKEOVER_SESSION_HASH_HEX=<16 hex chars>
export THIN_TAKEOVER_EPOCH=1
export THIN_TAKEOVER_GENERATION=1

swift run -c release takeover-macos-host <client-ip> 45555
```

Screen Recording permission is required. The root key must come from the authority/control plane and must not be persisted or logged.

## Authority boundary

Possession of a media or input socket is not Human authority. `Done`, `Cancel`, revoke and Agent resume stay in the control plane.

The required lifecycle is:

```text
Agent active
  ↓ revoke/fence Agent input
Human authority grant
  ↓
short-lived authenticated media/input session
  ↓ Done / Cancel via control plane
Human input revoke
  ↓ epoch advance + old key invalidation
fresh Agent attach
  ↓ fresh readiness / semantic verify
Agent active
```

Human completion is never authentication proof. Credential, MFA/OTP, passkey, cookie, token, typed text and framebuffer data must never be returned to MCP/model context or durable handoff state.

Read [PROTOCOL.md](PROTOCOL.md) and [SECURITY.md](SECURITY.md) before integrating the runtime.

## Performance direction

The project optimizes for **freshness under bounded loss**, not perfect delivery:

- no unbounded video retransmission;
- no stale frame queue;
- ordinary delta-frame loss drops;
- keyframe repair is short-deadline only;
- realtime input is newest-wins;
- critical input is deduplicated;
- control-plane authority stays reliable and separate from the media hot path.

Current hosted ARM64 results show the UDP packet plane below the hardware codec cost. Physical Mac → native-client presentation measurements are still required before claiming glass-to-glass latency.

## Scope still intentionally outside v0.1 core

- signaling / NAT traversal / relay provider;
- permanent remote access accounts;
- audio, gamepad, HDR, virtual displays;
- browser polling/screenshot transport;
- CAPTCHA solving or credential automation;
- authority issuance/authentication itself.

Browser and Windows/Linux capture/input adapters can reuse the same transport/security core later.

## License and provenance

This directory is covered by the parent repository's MIT license. Sunshine, Moonlight, Selkies, RustDesk and similar systems are architecture/performance references only; no source code is copied from them into this experiment.
