# Benchmarks

Benchmarks are regression probes, not marketing claims. Hosted CI measurements vary by runner load and do not equal glass-to-glass latency on a physical Mac/iPhone path.

## CI environment

Current dedicated job:

- GitHub-hosted `macos-26` ARM64 runner;
- Xcode 26.6;
- Swift 6.3.3;
- hardware-required VideoToolbox H.264 encode/decode sessions.

## Hardened authenticated v0.1 baseline

Thin Takeover Experiment run 69 on 2026-08-20 (JST) verifies the hardened authenticated runtime with **21/21 tests**, release build, macOS host compile, random-nonce frame AEAD, authenticated video routing headers, secure control/input protocols, hardware codec, packetization, and UDP stress gates.

### Frame AEAD

One ChaCha20-Poly1305 seal/open is performed per complete encoded frame/config blob, before MTU fragmentation. Every message carries a fresh random 96-bit nonce; sequence remains authenticated context/replay metadata.

| Payload | Operation | p50 | p95 | p99 |
|---|---|---:|---:|---:|
| 32 KiB | seal | 0.065 ms | 0.080 ms | 0.105 ms |
| 32 KiB | open | 0.071 ms | 0.087 ms | 0.112 ms |
| 128 KiB | seal | 0.232 ms | 0.260 ms | 0.289 ms |
| 128 KiB | open | 0.252 ms | 0.284 ms | 0.318 ms |

The authenticated-frame overhead remains materially below hardware codec cost on this runner.

### Hardware codec

| Probe | p50 | p95 | p99 |
|---|---:|---:|---:|
| H.264 encode 1280x720 | 5.234 ms | 6.788 ms | 7.261 ms |
| H.264 encode 1920x1080 | 11.970 ms | 15.966 ms | 18.224 ms |
| codec round trip 1280x720 | 9.241 ms | 11.678 ms | 14.242 ms |
| codec round trip 1920x1080 | 14.980 ms | 22.522 ms | 25.819 ms |

For the codec-round-trip probes specifically, decode p50 was 2.164 ms at 720p and 3.435 ms at 1080p. These probes use synthetic source buffers and measure VideoToolbox hardware encode callback through hardware decode callback; they do not include ScreenCaptureKit, network, or presentation/scanout.

### Authenticated packet plane

The 72-byte video routing header is authenticated per datagram with a separately derived, 128-bit truncated HMAC-SHA256 tag before receiver reassembly-state mutation.

For 2000 synthetic 128 KiB frames / 234,000 packets:

- legacy copy-heavy packetization: 130.373 ms total;
- descriptor-only packetization: 0.561 ms total;
- descriptor speedup vs retained reference: 232.27x;
- authenticated descriptor/header work: 764.723 ms total;
- authenticated header cost: **0.3824 ms/frame** or **3.268 µs/packet** on the sending side.

The loopback probes authenticate the header on both send and receive:

| Probe | completion | p50 complete frame | p95 complete frame |
|---|---:|---:|---:|
| 32 KiB, 1 ms pace, 128 KiB receive buffer | 100% | 1.009 ms | 1.957 ms |
| 128 KiB, 16 ms pace, 128 KiB receive buffer | 91.5% | 3.160 ms | 4.568 ms |
| 128 KiB, 16 ms pace, 256 KiB receive buffer | 100% | 3.695 ms | 7.592 ms |

The security hardening has a measurable packet-plane cost, but it remains below the 1080p codec-round-trip median on this hosted runner. The constrained-buffer loss case remains intentional evidence for bounded recovery rather than hidden reliable-video queues.

## Earlier references

Earlier runs without pre-reassembly header authentication showed sub-millisecond localhost frame completion. Those values are retained only as optimization references and must not be presented as current secure-wire performance.

Hosted-runner tail latency is noisy. Do not interpret differences between individual hosted runs as a product regression without repeated physical-device measurements.

## Reproduce

```bash
swift test
swift build -c release
swift run -c release takeover-crypto-bench 32000 2000
swift run -c release takeover-crypto-bench 131072 1000
swift run -c release takeover-vt-bench 1280 720 180 20
swift run -c release takeover-vt-codec-bench 1280 720 120 20
swift run -c release takeover-packet-bench 2000 131072
swift run -c release takeover-loopback 400 32000 1 131072
swift run -c release takeover-loopback 200 131072 16 262144
```

## Physical-device acceptance still required

Before calling any number glass-to-glass, measure on a physical Mac and a real native client:

1. ScreenCaptureKit callback timestamp;
2. encode callback;
3. AEAD seal complete;
4. authenticated final packet send;
5. authenticated final packet receive;
6. bounded reassembly + AEAD open complete;
7. VideoToolbox decode callback;
8. actual display presentation;
9. input creation → host receive → OS injection → next presented frame;
10. immediate revoke → input cleanup/capture stop latency.

For the WebRTC sibling transport, record three identifier-free acceptance metrics per viable path: selected candidate-pair RTT for `direct`, selected candidate-pair RTT for `relay`, and locator/connect-attempt → first rendered video frame latency. The browser classifies only `direct` vs `relay` from local WebRTC stats; candidate IDs, IPs, ICE/TURN endpoints, SSID/carrier/network identifiers, credentials, SDP, and key material are not samples. The runtime retains only a bounded process-memory window and exposes aggregate comparison; no durable telemetry is required.

Real mobile/WAN acceptance must also measure MTU, steady and burst packet loss, congestion, background/foreground, reconnect, same-Wi-Fi direct selection, and real 5G/external-Wi-Fi TURN fallback. If bounded keyframe repair/IDR is insufficient, compare small FEC or codec/NAL-aware fragmentation rather than introducing an unbounded retransmission queue.

The project target is latency minimization under bounded loss, not perfect frame delivery.
