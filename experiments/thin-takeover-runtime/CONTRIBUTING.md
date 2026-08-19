# Contributing

Thin Takeover Runtime optimizes a narrow problem: short-lived, low-latency Human Takeover under a separate authority/control plane.

Before proposing a change:

1. keep authority, media transport, and OS/browser adapters separate;
2. preserve fail-closed session / epoch / generation / expiry binding;
3. never add an unauthenticated fallback;
4. never make ordinary video reliable by default or introduce an unbounded queue;
5. keep realtime input latest-wins and critical input deduplicated;
6. add deterministic negative tests for security-boundary changes;
7. add/extend a benchmark when touching capture, codec, crypto, packetization, reassembly, or input hot paths;
8. do not log or fixture credentials, OTP/MFA, passkeys, cookies, tokens, typed secret text, framebuffer contents, session root keys, or full takeover capabilities;
9. do not copy code from Sunshine, Moonlight, RustDesk, Selkies, or other reference projects unless its license is explicitly compatible and provenance is documented. Architecture observations alone are preferred;
10. do not add audio, gamepad, HDR, permanent remote access, CAPTCHA solving, proxy products, or unrelated remote-desktop features to the core runtime.

## Required checks

```bash
swift test
swift build -c release
swift run -c release takeover-crypto-bench 32000 2000
swift run -c release takeover-packet-bench 2000 131072
```

macOS codec/host changes must also pass the dedicated ARM64 `Thin Takeover Experiment` workflow.

Performance changes should report p50/p95/p99, test resolution/payload size, hardware/software codec policy, and whether the number is packet-only, codec-only, or glass-to-glass. Do not label synthetic or hosted-runner measurements as physical-device latency.
