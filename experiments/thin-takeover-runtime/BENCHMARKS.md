# Benchmarks

Benchmarks are regression probes, not marketing claims. Hosted CI measurements vary by runner load and do not equal glass-to-glass latency on a physical Mac/iPhone path.

## CI environment

Current dedicated job:

- GitHub-hosted `macos-26` ARM64 runner;
- Xcode 26.6;
- Swift 6.3.3;
- hardware-required VideoToolbox H.264 encode/decode sessions.

## Authenticated v0.1 baseline

Thin Takeover Experiment run 45 on 2026-08-20 (JST) verifies the extraction-ready authenticated runtime with 17/17 tests, release build, macOS host compile, frame AEAD, hardware codec, packetization, and UDP stress gates.

### Frame AEAD

One ChaCha20-Poly1305 seal/open is performed per complete encoded frame/config blob, before MTU fragmentation.

| Payload | Operation | p50 | p95 | p99 |
|---|---|---:|---:|---:|
| 32 KiB | seal | 0.074 ms | 0.194 ms | 0.298 ms |
| 32 KiB | open | 0.080 ms | 0.205 ms | 0.297 ms |
| 128 KiB | seal | 0.244 ms | 0.614 ms | 0.739 ms |
| 128 KiB | open | 0.294 ms | 0.762 ms | 0.920 ms |

The authenticated-frame overhead is materially below the hardware codec cost on this runner. This supports sealing once per frame instead of once per datagram.

### Hardware codec

| Probe | p50 | p95 | p99 |
|---|---:|---:|---:|
| H.264 encode 1280x720 | 6.383 ms | 14.065 ms | 20.750 ms |
| H.264 encode 1920x1080 | 9.777 ms | 15.603 ms | 38.087 ms |
| codec round trip 1280x720 | 7.667 ms | 9.527 ms | 20.074 ms |
| codec round trip 1920x1080 | 12.474 ms | 14.517 ms | 19.447 ms |

For the codec-round-trip probes specifically, decode p50 was 1.989 ms at 720p and 2.954 ms at 1080p. The probe uses synthetic source buffers and measures VideoToolbox hardware encode callback through hardware decode callback; it does not include ScreenCaptureKit, network, or presentation/scanout.

### Packet plane

The descriptor packetizer processed 2000 synthetic 128 KiB frames in 0.796 ms total versus 109.157 ms for the retained copy-heavy reference path, a 137.20x packetization-step speedup.

| Probe | completion | p50 complete frame | p95 complete frame |
|---|---:|---:|---:|
| 32 KiB, 1 ms pace, 128 KiB receive buffer | 100% | 0.203 ms | 0.606 ms |
| 128 KiB, 16 ms pace, 128 KiB receive buffer | 90.5% | 0.661 ms | 2.295 ms |
| 128 KiB, 16 ms pace, 256 KiB receive buffer | 100% | 0.691 ms | 2.124 ms |

The constrained-buffer loss case is intentional evidence for the recovery design: ordinary video does not become reliable or queue indefinitely; decoder-critical repair stays bounded and a fresh IDR is preferred after the deadline.

## Earlier pre-AEAD reference

Run 17 established a useful pre-security comparison:

| Probe | p50 | p95 | p99 |
|---|---:|---:|---:|
| H.264 encode 1280x720 | 5.677 ms | 6.444 ms | 7.601 ms |
| H.264 encode 1920x1080 | 9.064 ms | 11.822 ms | 16.594 ms |
| codec round trip 1280x720 | 9.335 ms | 27.426 ms | 45.242 ms |
| codec round trip 1920x1080 | 13.173 ms | 39.242 ms | 50.266 ms |
| 32 KiB localhost complete frame | 0.213 ms | 0.795 ms | 1.158 ms |

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
4. final packet send;
5. final packet receive;
6. bounded reassembly + AEAD open complete;
7. VideoToolbox decode callback;
8. actual display presentation;
9. input creation → host receive → OS injection acknowledgement.

The project target is latency minimization under bounded loss, not perfect frame delivery.
