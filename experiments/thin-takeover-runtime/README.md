# Thin Takeover Runtime — v0.1 candidate

> **Extraction-ready OSS experiment.** This code lives under `mcp-execution-handoff/experiments` so it does not widen the parent package's public API. The subtree has its own MIT license, protocol, security model, benchmarks, and contribution rules and is designed to move to a standalone repository after physical-device acceptance.

Thin Takeover Runtime is an ultra-low-latency media/input plane for **short-lived, authority-fenced Human Takeover**. It is deliberately not a permanent remote-desktop server.

## Current V4 path

```text
mcp-execution-handoff / embedding control plane
        │
        ├─ principal / intervention / epoch / generation
        ├─ short-lived random 32-byte root key
        └─ absolute expiry
        │
        ▼
macOS host
ScreenCaptureKit
  ↓ complete frames only
VideoToolbox H.264
  real-time / no reorder / zero lookahead
  ↓
maxInFlight=1
  newest-frame-wins
  ↓
ChaCha20-Poly1305 once per encoded frame
  fresh random 96-bit nonce
  ↓
72-byte HMAC-authenticated routing header
  ↓
MTU-bounded scatter/gather UDP
        │
        ▼
iOS/native client
header auth before allocation
  ↓
bounded newest-frame reassembly
  ↓
frame AEAD open
  ↓
VideoToolbox hardware decode
  ↓ IOSurface-backed NV12 CVPixelBuffer
single-slot latest-frame store
  ↓
Metal display-cadence presenter

Human input
  iOS local cursor immediately updates
  ↓
  realtime pointer ─ latest wins / no retry
  critical click/key/text ─ bounded retry
  ↓ per-event AEAD
  macOS replay/dedupe gate
  ↓
  CoreGraphics injection
  ↓ injected critical event only
  authenticated ACK

Decoder recovery
  native client request IDR
  ↓ authenticated + rate-limited feedback
  macOS encoder force-next-keyframe

Done / Cancel
  authoritative control plane
  ↓ authenticated revoke-only local signal
  shared lease revoked immediately
```

## Implemented runtime

### Core security and transport

- exclusive Agent/Human authority controller and intervention/epoch/client-generation fencing primitives;
- monotonic ephemeral session lease with explicit revoke and expiry;
- fresh-random-nonce ChaCha20-Poly1305 with HKDF-SHA256 separation by session/epoch/generation/direction/channel;
- authenticated 72-byte video routing header using a separately derived 128-bit truncated HMAC-SHA256 tag;
- pre-reassembly header verification and completed-frame replay fencing;
- MTU-aware descriptor packetization and non-blocking scatter/gather UDP send;
- bounded newest-frame-only reassembly;
- realtime and critical input lanes with replay/deduplication;
- authenticated revoke-only control protocol;
- separately keyed authenticated input-ACK and video-IDR feedback channels;
- malformed-datagram / routing-header mutation robustness tests;
- monotonic stage-local latency metrics and synthetic regression probes.

### macOS host

- ScreenCaptureKit complete-frame filtering;
- explicit display selection when multiple displays are capturable;
- capture display ID reused for Human input coordinate mapping;
- aspect-ratio-preserving max 1920×1080 output;
- 60 fps target, small capture queue, `maxInFlight=1` encoder admission;
- VideoToolbox hardware H.264 request with real-time, no-reorder, zero-frame-delay, speed-over-quality and zero-lookahead hints;
- AVCC-native output without a full-frame Annex-B sender conversion;
- authenticated video/input/feedback/revoke UDP planes;
- CoreGraphics pointer/button/scroll/key/Unicode injection;
- pressed key/button tracking and release-all on revoke/expiry/input-loop exit;
- critical input ACK only after successful OS injection, with safe re-ACK of already-injected bounded retries;
- authenticated, replay-fenced, rate-limited IDR request handling;
- Screen Recording and Accessibility permission preflight before the Human surface starts;
- fail-closed multi-display selection;
- production-preferred inherited-FD root-key input (`THIN_TAKEOVER_SESSION_KEY_FD`), with hex environment fallback only for development/reference use.

### iOS/native client library

`TakeoverNativeClient` supports macOS/iOS and is generic-iOS compile-gated in CI.

It includes:

- `SecureVideoReceiver`: header auth → bounded reassembly → complete-frame AEAD open;
- `VideoToolboxH264Decoder`: hardware-required H.264 AVCC decode to IOSurface-backed NV12 `CVPixelBuffer`;
- `NativeVideoClientPipeline`: secure receive-to-decode state machine;
- `NativeInputClient`: latest-only realtime input and bounded critical retries;
- authenticated critical-input ACK consumption;
- `NativeVideoFeedbackClient`: rate-limited authenticated IDR requests;
- `NativeTakeoverClientSession`: video receiver, input sender, ACK receiver and IDR sender UDP glue;
- `LatestDecodedFrameStore`: single-slot decoded frame handoff, not a presentation FIFO;
- `TakeoverMetalView`: iOS CVMetalTextureCache + GPU NV12→RGB rendering at the device display cadence;
- `TakeoverClientViewController`: reference touch client with immediate local cursor, video/ACK receive loops, critical retry loop and fail-closed mobile lifecycle;
- background/foreground behavior that discards the current binding and requires a fresh generation/root key rather than silently reviving stale authority.

The reference controller is intentionally a thin example, not an authentication/control-plane UI.

### WebRTC browser client

The Native path above remains unchanged. An additional install-free Safari transport is available through the parent Handoff broker:

- locator opens a fullscreen `playsinline` Mac video surface;
- direct tap and swipe operate on that surface;
- tapping an editable field bridges to the iOS keyboard for text / Backspace / Enter;
- no Scroll / Tab / Send operation-button fallback is exposed for WebRTC-only locators;
- background / peer disconnect destroys the old peer and requires fresh-generation reconnect;
- WebRTC-only input is broker-generation-gated before entering a bounded local helper pipe;
- WebRTC browser capture is capped at 1280×720 / 30 fps and uses Constrained Baseline H.264 (`42c01f`) for the initial Safari acceptance path; encoder admission stays at one in-flight frame plus one latest pending encoded frame;
- server-side implicit third-party STUN is disabled; TURN/NAT traversal is an explicit future embedding policy.

The macOS helper is built as `takeover-webrtc-host`. It carries only ephemeral framebuffer/H.264 and bounded Human input. It does not receive MCP/model context, and its environment is reduced to expiry plus optional display selection rather than inheriting the parent process environment.

## Validation

The latest native-client phase ARM64 gate verifies:

- **36/36 Swift tests PASS**;
- release package build PASS;
- authenticated macOS host compile PASS;
- `TakeoverNativeClient` compile PASS on macOS;
- **generic iOS 17 `TakeoverNativeClient` build PASS with signing disabled**;
- hardware-required H.264 encode/decode PASS;
- secure native receive→hardware-decode pipeline PASS at 720p and 1080p;
- authenticated packet/loopback loss-buffer stress PASS.

Representative hosted-runner p50 values from that phase:

| probe | p50 |
|---|---:|
| 32 KiB frame AEAD seal / open | 0.067 / 0.073 ms |
| 128 KiB frame AEAD seal / open | 0.241 / 0.260 ms |
| 720p hardware codec round trip | 7.654 ms |
| 1080p hardware codec round trip | 14.100 ms |
| **post-encode secure native receive → HW decode, 720p** | **1.881 ms** |
| **post-encode secure native receive → HW decode, 1080p** | **2.723 ms** |
| authenticated 32 KiB complete localhost frame | 1.009 ms |
| authenticated 128 KiB complete localhost frame, 256 KiB receive buffer | 3.408 ms |

The secure native-client probe includes frame AEAD, video-header authentication, MTU packetization, reassembly, AEAD open and hardware decode. It deliberately excludes real network transit and display presentation/scanout.

These are hosted-runner component probes, **not glass-to-glass claims**. See [BENCHMARKS.md](BENCHMARKS.md).

## Build and test

```bash
swift test
swift build -c release
swift build -c release --product takeover-webrtc-host
swift run -c release takeover-crypto-bench 32000 2000
swift run -c release takeover-vt-bench 1280 720 180 20
swift run -c release takeover-vt-codec-bench 1280 720 120 20
swift run -c release takeover-native-client-pipeline-bench 1280 720 60
swift run -c release takeover-packet-bench 2000 131072
swift run -c release takeover-loopback 200 131072 16 262144

# iOS compile smoke
xcodebuild -scheme TakeoverNativeClient \
  -destination 'generic/platform=iOS' \
  -configuration Release \
  CODE_SIGNING_ALLOWED=NO build
```

## macOS authenticated host

The host has no insecure default session. Production embeddings should pass the root key via an inherited read-only FD containing exactly 32 raw bytes:

```bash
export THIN_TAKEOVER_SESSION_KEY_FD=<inherited-fd-number>
export THIN_TAKEOVER_SESSION_HASH_HEX=<16 hex chars>
export THIN_TAKEOVER_EPOCH=1
export THIN_TAKEOVER_GENERATION=1
export THIN_TAKEOVER_EXPIRES_AT_UNIX_MS=<future unix ms>
```

For development only, `THIN_TAKEOVER_SESSION_KEY_HEX=<64 hex chars>` remains a fallback.

Human-plane sockets bind to loopback unless explicitly configured:

```bash
export THIN_TAKEOVER_INPUT_BIND_HOST=127.0.0.1
export THIN_TAKEOVER_CONTROL_BIND_HOST=127.0.0.1
export THIN_TAKEOVER_FEEDBACK_BIND_HOST=127.0.0.1

# Optional when more than one display is capturable; required in that case.
export THIN_TAKEOVER_DISPLAY_ID=<CGDirectDisplayID>

# args:
# <client-ip> [video] [input] [control] [host-video-feedback] [client-input-feedback]
# defaults from video 45555: 45555 / 45556 / 45557 / 45558 / 45559
swift run -c release takeover-macos-host <client-ip> 45555 45556 45557 45558 45559
```

The host fails closed before takeover if required Screen Recording or Accessibility permission is unavailable.

Immediate local teardown can be exercised with the separately authenticated revoke sender:

```bash
swift run -c release takeover-control-send 127.0.0.1 45557
```

The local revoke lane is teardown-only. It cannot approve an action or resume Agent authority.

## Authority boundary

Possession of media/input/feedback/control sockets is not Human authority. The control plane owns Human grant, Done/Cancel, authoritative revoke, epoch/generation advancement and Agent resume.

```text
Agent active
  ↓ fence Agent input
Human authority grant
  ↓ fresh generation + fresh root key
short-lived native media/input session
  ↓ Human Done / Cancel
control-plane revoke + authenticated local teardown
  ↓ capture/input/feedback stop + pressed state release
  ↓ epoch/generation advance + old key invalidation
fresh Agent attach
  ↓ semantic readiness/auth verification
Agent active
```

Human completion is never authentication proof. Credential, MFA/OTP, passkey, cookie, token, typed secret text and framebuffer data must never be returned to MCP/model context or durable handoff state.

## Performance policy

The project optimizes for **freshness under bounded loss**:

- capture admission `maxInFlight=1`;
- no stale video FIFO;
- single-slot decoded-frame presentation handoff;
- realtime pointer state is never retransmitted;
- critical input retries are short-lived, bounded and host-deduplicated;
- ACK loss causes safe re-ACK, not double injection;
- ordinary lost delta frames do not become an unbounded reliable queue;
- decoder recovery uses authenticated, replay-fenced, client+host rate-limited IDR requests;
- old/revoked mobile generations are not automatically resurrected.

## Remaining before standalone v0.1.0

### WebRTC Safari physical acceptance

The browser transport is implementation-complete enough for physical acceptance, but the following must still be verified on a real iPhone Safari against the Mac host:

1. open the short-lived locator directly in Safari;
2. confirm the Mac screen renders as live video without the legacy Scroll / Tab / Send controls;
3. tap and one-finger swipe directly on the video and verify Mac input;
4. tap an editable field and verify the iOS keyboard can send text and Backspace;
5. press Done and confirm further input is immediately impossible;
6. background Safari and return to foreground, confirming the stale peer/generation does not revive and recovery uses a fresh generation;
7. re-run the existing Native physical path to confirm no regression.

The current default WebRTC path intentionally uses host ICE candidates only (`iceServers: []`). Same-network acceptance comes first. TURN / WAN / cellular traversal is a separate explicit relay trust-policy decision, not an automatic fallback.

The main remaining work now requires physical devices / real networks:

1. physical Mac ScreenCaptureKit callback → encode timing;
2. actual iPhone receive → secure pipeline → VideoToolbox decode → **Metal presentation/scanout** timing;
3. touch/input creation → host injection → next presented frame timing;
4. immediate revoke → input cleanup/capture-stop timing;
5. background/foreground with a real fresh control-plane generation/key;
6. real Wi-Fi/cellular RTT, MTU, steady/burst loss and congestion behavior;
7. decide from evidence whether bounded IDR recovery is sufficient or whether small FEC / codec-NAL-aware fragmentation is justified;
8. choose/implement the production NAT traversal or relay adapter without changing the authority contract.

Do not add an unbounded reliable-video queue to hide loss.

## Scope intentionally outside the core

- authority issuance/principal authentication;
- permanent remote-access accounts;
- provider-specific signaling/NAT/relay implementation;
- audio, gamepad, HDR, virtual displays;
- browser screenshot polling;
- CAPTCHA solving or credential automation.

Windows/Linux host adapters can reuse the same transport/security/native-client contract later.

## License and provenance

The subtree is MIT licensed. Sunshine, Moonlight, Selkies, RustDesk and similar systems are architecture/performance references only; no source code is copied from them into this runtime.
