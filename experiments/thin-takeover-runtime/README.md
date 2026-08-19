# Thin Takeover Runtime — v0.1 candidate

> **Extraction-ready OSS experiment.** This code currently lives under `mcp-execution-handoff/experiments` so it does not widen the parent package's public API. The subtree has its own MIT license, protocol, security model, benchmarks, and contribution rules and is designed to move to a standalone repository after physical-device acceptance.

Thin Takeover Runtime is an ultra-low-latency media/input plane for **short-lived, authority-fenced Human Takeover**. It is deliberately not a permanent remote-desktop server.

## What is implemented

```text
Human authority from control plane
        │
        ├─ session / epoch / generation
        ├─ short-lived random 32-byte root key
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
  fresh random 96-bit nonce
        ↓
MTU-bounded descriptor packetizer
  authenticated 72-byte routing header
        ↓
scatter/gather non-blocking UDP
        ↓
network
        ↓
header auth before allocation
        ↓
bounded newest-frame reassembly
  completed-frame replay fence
        ↓
frame AEAD verify
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
  pressed state released on revoke/expiry

Control plane
        ↓
authenticated revoke-only control lane
        ↓
shared lease revoked immediately
```

The core includes:

- exclusive Agent/Human authority controller;
- intervention / epoch / client-generation fencing primitives;
- monotonic ephemeral session lease with explicit revoke and expiry;
- fresh-random-nonce ChaCha20-Poly1305 with HKDF-SHA256 directional/channel keys;
- authenticated 72-byte video routing header using a separately derived truncated HMAC-SHA256 tag;
- pre-reassembly header verification and completed-frame replay fencing;
- frame admission (`maxInFlight=1`) to prevent stale encoder queues;
- MTU-aware zero-copy-oriented packet descriptors and non-blocking scatter/gather UDP send;
- bounded newest-frame-only receiver reassembly;
- binary input protocol with realtime vs critical semantics;
- secure input datagrams and replay/deduplication gate;
- authenticated revoke-only control protocol and replay gate;
- deadline-bounded keyframe NACK / rate-limited IDR recovery planner;
- monotonic latency metrics;
- packetization, UDP, AEAD, hardware encode and hardware codec round-trip benchmarks.

The macOS host includes:

- ScreenCaptureKit complete-frame filtering;
- captured-display selection shared with Human input coordinate mapping;
- aspect-ratio-preserving max 1920×1080 output dimensions;
- 60 fps target and small capture queue;
- VideoToolbox hardware H.264 request;
- real-time mode, no B-frame reordering, zero frame-delay request;
- speed-over-quality and zero-lookahead hints;
- AVCC-native encoder output;
- authenticated frame transport;
- authenticated realtime/critical Human input receiver;
- bounded pointer/button/scroll/key/Unicode text injection;
- tracked key/button release on revoke, expiry, or input-loop exit;
- 50 ms bounded input/control receive timeouts so lease changes are observed promptly;
- authenticated immediate revoke listener on a distinct control port;
- fail-closed startup if session key, binding, or expiry is absent/invalid.

## Validation

The hardened ARM64 macOS gate verifies **21/21 Swift tests**, release build, macOS host compile, random-nonce frame AEAD, authenticated video routing headers, secure input/control protocols, hardware H.264 encode/decode, packetization, and UDP loss/buffer stress.

Representative hosted-runner p50 values from the hardened authenticated baseline:

| probe | p50 |
|---|---:|
| 32 KiB AEAD seal / open | 0.065 / 0.071 ms |
| 128 KiB AEAD seal / open | 0.232 / 0.252 ms |
| 720p hardware codec round trip | 9.241 ms |
| 1080p hardware codec round trip | 14.980 ms |
| authenticated 32 KiB complete localhost frame | 1.009 ms |
| authenticated 128 KiB complete localhost frame, bounded 256 KiB receive buffer | 3.695 ms |

The per-datagram routing-header authentication measured about **0.382 ms per 128 KiB frame on the sending side** in the 2000-frame synthetic probe. Security hardening is measurable but still below hardware codec cost in this environment.

These are hosted-runner synthetic probes, **not glass-to-glass claims**. See [BENCHMARKS.md](BENCHMARKS.md) for p95/p99, methodology and burst-loss results.

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

The host intentionally has no insecure default session. The authority/control plane must provide a short-lived binding. The environment-variable example below is a development/reference path only; production embeddings should inject and destroy key material through an appropriate secret/IPC boundary without argv or ordinary logs.

```bash
export THIN_TAKEOVER_SESSION_KEY_HEX=<64 hex chars / 32 random bytes>
export THIN_TAKEOVER_SESSION_HASH_HEX=<16 hex chars>
export THIN_TAKEOVER_EPOCH=1
export THIN_TAKEOVER_GENERATION=1
export THIN_TAKEOVER_EXPIRES_AT_UNIX_MS=<future unix time in milliseconds>

# Safe defaults for Human input and revoke control are loopback.
# For a remote client/control bridge, bind only an explicitly approved local interface.
export THIN_TAKEOVER_INPUT_BIND_HOST=127.0.0.1
export THIN_TAKEOVER_CONTROL_BIND_HOST=127.0.0.1

# args: <client-ip> [video-port] [input-port] [control-port]
# defaults: input=video+1, control=video+2
swift run -c release takeover-macos-host <client-ip> 45555 45556 45557
```

Screen Recording permission is required for capture, and macOS must permit the host process to inject the requested Human input.

To exercise immediate revoke using the same short-lived binding:

```bash
swift run -c release takeover-control-send 127.0.0.1 45557
```

The revoke sender reads the transport key/binding from the environment, not argv. A valid revoke drops the shared local lease immediately; capture/media/input then stop and tracked pressed Human key/button state is released.

## Authority boundary

Possession of a media, input, or revoke-control socket is not Human authority. `Done`, `Cancel`, approval, revoke policy, and Agent resume remain authoritative control-plane semantics. The local revoke signal is teardown-only.

The required lifecycle is:

```text
Agent active
  ↓ revoke/fence Agent input
Human authority grant
  ↓ fresh generation + fresh root key
short-lived authenticated media/input session
  ↓ Done / Cancel via control plane
signed local revoke + Human authority revoke
  ↓ local lease stops + pressed state released
  ↓ epoch/generation advance + old key invalidation
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
- pre-reassembly routing metadata is authenticated and bounded;
- completed frames cannot be replayed inside a live generation;
- all media/input/control is bound to the active session generation and expiry;
- control-plane authority stays reliable and separate from the media hot path.

## What remains before a physical v0.1 acceptance tag

The software/runtime contract is implemented and CI-gated. Remaining work requires a real operator path rather than more synthetic CI:

1. physical Mac ScreenCaptureKit callback → encode timing;
2. native client receive/header-auth/reassembly/AEAD-open → hardware decode → actual presentation timing;
3. physical network RTT/loss and Human input → OS injection → next-frame timing;
4. immediate revoke → input cleanup/capture-stop timing;
5. mobile background/foreground/reconnect behavior through fresh generation/key rotation;
6. MTU, steady/burst packet loss and congestion measurements on the intended mobile path.

If bounded keyframe NACK/IDR proves insufficient on real networks, compare small FEC or codec/NAL-aware fragmentation. Do not hide loss behind an unbounded reliable-video queue.

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
