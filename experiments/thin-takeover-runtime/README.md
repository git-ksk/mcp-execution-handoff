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

Browser WebRTC diagnostics remain bounded, identifier-free, and process-memory-only. Receiver metrics
include network RTT/jitter, jitter-buffer actual/target/minimum delay, decode/processing time,
receive-to-display/compositor time, and tap-to-host-feedback latency. The browser's WebRTC
`requestVideoFrameCallback().captureTime` is treated only as a remote RTP/RTCP sender-timeline
estimate: with the custom Werift sender it is **not** labeled or interpreted as the true
ScreenCaptureKit capture instant. Host encode and RTP-drain timings are measured server-side and
cannot be supplied by the browser metrics payload.

### macOS host

- ScreenCaptureKit complete-frame filtering;
- optional consumer-bound target process ID; when present, exactly one eligible on-screen target window must resolve or the runtime fails closed;
- target-window capture uses a one-window ScreenCaptureKit inclusion filter plus a display-local `sourceRect` crop, and Human pointer input maps to the same window bounds;
- generic callers without a target process keep explicit display selection when multiple displays are capturable;
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

- locator opens a fullscreen `playsinline` video surface for the selected host capture scope;
- direct tap and swipe operate on that surface;
- bounded local 1×–4× zoom plus two-finger pinch/pan supports precision targets on small mobile screens; while zoomed, one-finger drag pans only the local view and never emits target scroll input, while a stationary tap still maps through the transformed video bounds to the exact capture surface;
- tapping an editable field bridges to the iOS keyboard for text / Backspace / Enter;
- no Scroll / Tab / Send operation-button fallback is exposed for WebRTC-only locators;
- background / peer disconnect destroys the old peer and requires fresh-generation reconnect;
- WebRTC-only input is broker-generation-gated before entering a bounded local helper pipe;
- WebRTC browser capture is capped at 1280×720 / 30 fps and uses Constrained Baseline H.264 (`42c01f`) for the initial Safari acceptance path; encoder admission stays at one in-flight frame plus one latest pending encoded frame;
- server-side implicit third-party STUN remains disabled; when an explicit ICE credential provider is configured, host/direct candidates remain eligible and short-lived STUN/TURN candidates are added for WAN fallback without switching the default policy to relay-only;
- Cloudflare Realtime TURN and self-hosted coturn are optional credential-provider adapters: long-lived provider secrets stay server-side, while separate short-lived browser/server ICE credentials are issued only after the Handoff client generation is bound; Cloudflare credentials are actively revoked, while coturn TURN REST credentials expire at the generation deadline because coturn has no per-credential revoke API;
- no TURN provider means the existing direct-only `iceServers: []` behavior; credential issuance failure remains direct-only with relay explicitly unavailable rather than silently widening trust.

The macOS helper is built as `takeover-webrtc-host`. It carries only ephemeral framebuffer/H.264 and bounded Human input. It does not receive MCP/model context, and its environment is reduced to expiry plus optional display/target-process selection rather than inheriting the parent process environment. When a consumer supplies a target process, the helper requires exactly one eligible window and crops capture/input to that window; it never broadens an ambiguous target to the desktop.

WAN relay configuration is owned by the Handoff runtime deployment, not by Maps or another consumer. `SpawnedWebRtcRuntimeProvider` accepts exactly zero or one provider family. Cloudflare uses both server-side variables together:

```text
MCP_HANDOFF_CLOUDFLARE_TURN_KEY_ID
MCP_HANDOFF_CLOUDFLARE_TURN_KEY_API_TOKEN
```

Self-hosted coturn TURN REST mode uses:

```text
MCP_HANDOFF_COTURN_SHARED_SECRET
MCP_HANDOFF_COTURN_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
MCP_HANDOFF_COTURN_STUN_URLS=stun:turn.example.com:3478   # optional
```

The coturn server must use `use-auth-secret` with the same high-entropy `static-auth-secret` (or equivalent dynamic secret). Handoff generates `timestamp:random` usernames and base64 HMAC-SHA1 credentials locally; it does not call a credential web API. Provider secrets are never forwarded to the browser or helper. If no provider family is present, the runtime remains direct-only. Partial configuration or simultaneous Cloudflare+coturn configuration is an invalid, fail-closed startup state. Production deployment should inject the Cloudflare API token or coturn shared secret from its normal server-side secret boundary rather than commit it to source or configuration files.

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

The canonical same-LAN physical acceptance harness is committed at `scripts/webrtc-lan-acceptance.mts`. Run it from the repository root with:

```bash
npm run accept:webrtc:lan
```

The command rebuilds the release `takeover-webrtc-host` first, starts a disposable normal Chrome window backed by a loopback-only target page, and exposes only the Handoff broker on the selected private LAN address. It intentionally refuses to start if Cloudflare TURN credentials are present so this baseline remains an unambiguous direct-path check. Fresh locator creation, diagnostics, revoke, and lifecycle controls stay loopback-only (`/__new`, `/__diag`, `/__revoke`, `/__lifecycle`). This harness is the regression baseline; do not replace it with ad-hoc `--app=file://...` targets for Safari input acceptance.

The same target includes a harmless macOS pointer-activation matrix for ordinary `<button>`, checkbox default activation, focus-only input, a legacy `javascript:` anchor, and an ordinary navigation link followed by a second ordinary link. The target records only boolean acceptance state; no entered text or remote input payload is retained. Start a fresh locator through `/__new`, complete the pointer matrix on the Human surface, then read `http://127.0.0.1:8891/__state` locally and require `pointerComplete: true`. This makes the browser-pointer regression repeatable without any Maps/Cinema/provider selector, DOM `.click()` fallback, or target-service state.

The same committed harness also provides a public-relay mode without changing the target/runtime shape. Build the release host first, load the server-side TURN variables into the process environment, set `HANDOFF_PUBLIC_ORIGIN` to the reviewed HTTPS Handoff origin, and run `npm run accept:webrtc:public-relay`. Public-relay binds the broker only to `127.0.0.1:18789` for the reviewed Tunnel origin and requires both TURN credential variables. Control endpoints require both a loopback socket and loopback Host, so requests forwarded by a public Tunnel remain ineligible even though the local cloudflared hop originates on loopback.

The self-hosted coturn adapter has a separate container acceptance that proves the generated TURN REST credentials against a real pinned coturn image and forces both Werift peers to `iceTransportPolicy: relay`. It publishes no host ports, uses an isolated temporary Docker network and random test-only shared secret, asserts that both local descriptions contain relay candidates only, sends one bounded DataChannel probe, then removes the containers, network, and secret file:

```bash
npm run accept:webrtc:coturn-relay
```

This acceptance is intentionally relay-only so it proves coturn interoperability; production Handoff remains direct-first with `iceTransportPolicy: all`.

When a target process is bound, the macOS WebRTC host now raises the unique AX window whose frame matches the captured `inputBounds` and activates that application before accepting each Human input. If the target window cannot be resolved uniquely or activated, the input fails closed. This keeps window-scoped capture and Human input on the same target even when another Mac application was frontmost before the remote action.

Physical acceptance is now recorded for the current transport baseline:

1. same-Wi-Fi iPhone Safari selected a direct path;
2. cellular/4G iPhone Safari selected TURN relay after direct connectivity was unavailable;
3. the target-process path showed only the dedicated Chrome window and restored that exact target window before Human input even when another Mac app was frontmost;
4. tap/focus, text, Backspace, and scrolling worked on the physical Safari surface;
5. Done/revoke invalidated the locator and stale reuse was rejected;
6. identifier-free diagnostics confirmed bounded direct/relay path and latency state without retaining candidate strings, IP addresses, SDP, credentials, framebuffer bytes, or Human input.

The default remains direct-only when no ICE credential provider is configured. With the Cloudflare Realtime TURN adapter configured, normal ICE negotiation uses `iceTransportPolicy: all`: host/direct and server-reflexive candidates remain eligible, and relay is selected only when the ICE candidate pair cannot establish a direct path. Relay allocation is transport reachability, **not** Human authentication or proof that the target service accepted credentials.

The browser control plane is intentionally two-stage: (1) claim/reconnect rotates and binds the exact intervention / epoch / principal / client-generation / expiry tuple and prepares short-lived ICE material; (2) only that generation may submit its bounded offer. Reconnect always creates a fresh peer, fresh generation, and fresh ICE session. TURN credentials, SDP, candidates, DTLS/SRTP key material, framebuffer bytes, and raw Human input remain process-memory/no-store signaling data and are never MCP/model/checkpoint/log artifacts.

Remaining physical/mobile work is narrower and tracked separately:

1. keyboard-aware `visualViewport` composition so the focused target stays visible above the iOS software keyboard;
2. bounded portrait/landscape target sizing or safe client-side fit/letterbox behavior;
3. explicit Safari reload/reconnect UX with fresh-generation rotation and stale-page fencing;
4. real Wi-Fi/cellular MTU, steady/burst loss, and congestion characterization;
5. Native Thin Takeover physical-path regression/acceptance;
6. decide from evidence whether bounded IDR recovery is sufficient or whether small FEC / codec-NAL-aware fragmentation is justified.

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
