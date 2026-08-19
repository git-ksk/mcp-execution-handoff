# Thin Takeover Runtime — v0.1 candidate

> **Extraction-ready OSS experiment.** This code currently lives under `mcp-execution-handoff/experiments` so it does not widen the parent package's public API. The subtree has its own MIT license, protocol, security model, benchmarks, and contribution rules and is designed to move to a standalone repository after physical-device acceptance.

Thin Takeover Runtime is an ultra-low-latency media/input plane for **short-lived, authority-fenced Human Takeover**. It is deliberately not a permanent remote-desktop server.

## What is implemented

```text
Human authority from control plane
        │
        ├─ session / epoch / generation
        ├─ short-lived 32-byte root key
        └─ absolute expiry
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
native decoder adapter

Human input
        ↓
realtime lane  ─ latest wins
critical lane  ─ bounded retry + dedupe
        ↓
per-event AEAD
        ↓
macOS bounded CoreGraphics input adapter
```

The core includes:

- exclusive Agent/Human authority controller;
- intervention / epoch / client-generation fencing primitives;
- monotonic ephemeral session lease with explicit revoke and expiry;
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
- 60 fps target and small capture queue;
- VideoToolbox hardware H.264 request;
- real-time mode, no B-frame reordering, zero frame-delay request;
- speed-over-quality and zero-lookahead hints;
- AVCC-native encoder output;
- authenticated frame transport;
- authenticated realtime/critical Human input receiver;
- bounded pointer/button/scroll/key/Unicode text injection;
- fail-closed startup if session key, binding, or expiry is absent/invalid;
- runtime media/input shutdown after lease expiry.

## Validation

The dedicated ARM64 macOS gate currently verifies **17/17 Swift tests**, release build, macOS host compile, frame AEAD, hardware H.264 encode/decode, packetization and UDP loss/buffer stress.

Representative hosted-runner p50 results from the authenticated v0.1 baseline:

| probe | p50 |
|---|---:|
| 32 KiB AEAD seal / open | 0.074 / 0.080 ms |
| 128 KiB AEAD seal / open | 0.244 / 0.294 ms |
| 720p hardware codec round trip | 7.667 ms |
| 1080p hardware codec round trip | 12.474 ms |
| 32 KiB complete localhost frame | 0.203 ms |
| 128 KiB complete localhost frame, bounded 256 KiB receive buffer | 0.691 ms |

These are synthetic hosted-runner probes, **not glass-to-glass claims**. See [BENCHMARKS.md](BENCHMARKS.md) for p95/p99, methodology and burst-loss results.

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

## macOS authenticated host

The host intentionally has no insecure default session. The authority/control plane must provide a short-lived binding. The example below is for development; production embeddings should inject and clear key material without putting it in command-line arguments or logs.

```bash
export THIN_TAKEOVER_SESSION_KEY_HEX=<64 hex chars / 32 random bytes>
export THIN_TAKEOVER_SESSION_HASH_HEX=<16 hex chars>
export THIN_TAKEOVER_EPOCH=1
export THIN_TAKEOVER_GENERATION=1
export THIN_TAKEOVER_EXPIRES_AT_UNIX_MS=<future unix time in milliseconds>

# Safe default is loopback input binding. For a remote client, bind an explicitly approved local interface.
export THIN_TAKEOVER_INPUT_BIND_HOST=192.0.2.10

# args: <client-ip> [video-port] [input-port]
# input-port defaults to video-port + 1
swift run -c release takeover-macos-host <client-ip> 45555 45556
```

Screen Recording permission is required for capture, and macOS must permit the host process to inject the requested Human input. The root key must come from the authority/control plane and must not be persisted or logged.

At expiry the local lease stops capture admission, frame transmission and Human input injection. Product-level Done/Cancel/revoke should still terminate or revoke the runtime immediately rather than waiting for expiry.

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
Human input revoke + local lease revoke
  ↓ epoch advance + old key invalidation
fresh Agent attach
  ↓ fresh readiness / semantic verify
Agent active
```

Human completion is never authentication proof. Credential, MFA/OTP, passkey, cookie, token, typed secret text and framebuffer data must never be returned to MCP/model context or durable handoff state.

Read [PROTOCOL.md](PROTOCOL.md) and [SECURITY.md](SECURITY.md) before integrating the runtime.

## Performance policy

The project optimizes for **freshness under bounded loss**, not perfect delivery:

- no unbounded video retransmission;
- no stale frame queue;
- ordinary delta-frame loss drops;
- keyframe repair is short-deadline only;
- realtime input is newest-wins;
- critical input is deduplicated;
- all media/input is bound to the active session generation and expiry;
- control-plane authority stays reliable and separate from the media hot path.

## What remains before a physical v0.1 acceptance tag

The software/runtime contract is implemented and CI-gated. The remaining acceptance work requires a real operator path rather than more synthetic CI:

1. physical Mac ScreenCaptureKit callback → encode timing;
2. native client receive/reassembly/AEAD-open → hardware decode → actual presentation timing;
3. physical network RTT/loss and input → OS injection → next-frame timing;
4. mobile background/foreground/reconnect behavior through the existing handoff generation fencing.

Those measurements determine transport tuning; they do not change the authority/security contract above.

## Scope intentionally outside the core

- signaling / NAT traversal / relay provider;
- permanent remote access accounts;
- audio, gamepad, HDR, virtual displays;
- browser screenshot polling;
- CAPTCHA solving or credential automation;
- authority issuance/authentication itself.

Browser and Windows/Linux capture/input adapters can reuse the same transport/security core later.

## License and provenance

The subtree includes an MIT license. Sunshine, Moonlight, Selkies, RustDesk and similar systems are architecture/performance references only; no source code is copied from them into this runtime.
