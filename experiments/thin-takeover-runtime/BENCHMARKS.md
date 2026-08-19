# Benchmarks

Benchmarks are regression probes, not marketing claims. Hosted CI measurements vary by runner load and do not equal glass-to-glass latency on a physical Mac/iPhone path.

## CI environment

Current dedicated job:

- GitHub-hosted `macos-26` ARM64 runner;
- Xcode 26.6;
- Swift 6.3.3;
- hardware-required VideoToolbox H.264 encode/decode sessions.

## Latest pre-AEAD baseline

Run 17 on 2026-08-20 (JST) established:

| Probe | p50 | p95 | p99 |
|---|---:|---:|---:|
| H.264 encode 1280x720 | 5.677 ms | 6.444 ms | 7.601 ms |
| H.264 encode 1920x1080 | 9.064 ms | 11.822 ms | 16.594 ms |
| codec round trip 1280x720 | 9.335 ms | 27.426 ms | 45.242 ms |
| codec round trip 1920x1080 | 13.173 ms | 39.242 ms | 50.266 ms |
| 32 KiB localhost complete frame | 0.213 ms | 0.795 ms | 1.158 ms |

The codec round-trip probe allocates synthetic source frames and measures VideoToolbox encode callback through hardware decode callback. The tail includes shared hosted-runner scheduling noise; p50 is currently the useful architecture signal.

The descriptor packetizer processed 2000 synthetic 128 KiB frames in 0.881 ms total versus 119.795 ms for the retained copy-heavy reference path on that run, roughly 136x faster for the packetization step.

A 128 KiB frame at 16 ms pacing completed 91% of frames with a 128 KiB receive buffer and 100% with a bounded 256 KiB receive buffer. This validates the design decision to make keyframe repair explicit rather than hiding burst pressure inside blocking sends or unbounded queues.

## Authenticated transport probe

`takeover-crypto-bench` measures one ChaCha20-Poly1305 seal/open per complete frame. It exists to answer the only performance question that matters for transport confidentiality: whether frame-level AEAD materially changes the latency budget.

```bash
swift run -c release takeover-crypto-bench 32000 2000
swift run -c release takeover-crypto-bench 131072 1000
```

The CI workflow runs both sizes on every experiment change. Results should be recorded in the PR when the first green authenticated run completes.

## Physical-device acceptance still required

Before calling any number glass-to-glass, measure on a physical Mac and a real native client:

1. ScreenCaptureKit callback timestamp;
2. encode callback;
3. AEAD seal complete;
4. final packet send;
5. final packet receive;
6. AEAD open complete;
7. VideoToolbox decode callback;
8. actual display presentation;
9. input creation → host receive → OS injection acknowledgement.

The project target is latency minimization under bounded loss, not perfect frame delivery.
