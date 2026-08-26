# WebSocket takeover comparison — Issue #40

This note records the evidence for the private WebSocket takeover experiment. It is an engineering comparison, not a performance claim.

## Evidence status

| Criterion | WebSocket | WebRTC direct | WebRTC + TURN |
|---|---|---|---|
| Physical iPhone Safari Human takeover | PASS through HTTPS/WSS via Cloudflare Tunnel to the exact-window acceptance image | PASS from prior physical acceptance | PASS from prior physical 4G/TURN acceptance |
| Exact bounded target helper | PASS; reuses the Linux exact PID/X11-window helper and has no desktop fallback | PASS | PASS |
| Human actions exercised | tap, text, scroll, Enter, Done | tap/focus, text, Backspace, scroll, Done/revoke | tap/focus, text, Backspace, scroll, Done/revoke |
| TURN/STUN/ICE required | No | ICE direct path | TURN only when relay is selected |
| Slow-client video backlog | Bounded: at most one pending latest frame; older pending frames are dropped | Bounded real-time RTP/DataChannel policies; not TCP reliable-video | Same WebRTC policy; relay changes network path, not authority semantics |
| Reconnect authority | Fresh server-derived generation; stale generation/reconnect state is fenced | Fresh generation | Fresh generation and fresh ICE/TURN session |
| Managed-runtime public `run.app` route | BLOCKED by Google Frontend 404 before the container despite Ready/RoutesReady/public ingress; reproduced in `us-central1` and `asia-northeast1` | Not the target of this experiment | Not the target of this experiment |

The physical WSS run was also confirmed server-side with content-free booleans: target ready, tap observed, text observed, scroll observed, submit observed, and Done observed were all true. The temporary public Tunnel/container were stopped after acceptance.

The Japanese glyph boxes visible in the acceptance Chromium are not treated as a transport failure. The Debian acceptance image lacks a CJK font; the target still observed the text-input event. This should be fixed only if the acceptance image is kept as a reusable UX fixture.

## Backpressure and memory behavior

`ExperimentalWebSocketTakeoverChannel` never accumulates a reliable video queue. When a send is in flight or `bufferedAmount` exceeds the configured bound, it stores only one `pendingFrame`. A newer frame replaces that pending frame and increments the drop counter. After backlog clears, only the newest pending frame is flushed.

The deterministic stress regression pushes 10,000 frames while the peer remains backpressured and requires:

- zero frames sent while backpressured;
- exactly 9,999 older frames dropped;
- channel authority remains open;
- after backlog clears, exactly one frame is sent and it is the latest frame.

This proves bounded application-side pending-frame memory independent of backlog duration. It does not claim that the browser/network stack itself has zero buffering; the server additionally uses the WebSocket `bufferedAmount` bound to stop feeding that stack.

## Reconnect, revoke, and stale authority

The WebSocket ingress and shared `TakeoverSessionManager` tests prove:

- clean disconnect does not mean Human Done;
- reconnect requires server-held continuity state and rotates to a fresh client generation;
- peer messages cannot supply principal, Origin, client binding, generation, or reconnect authority;
- stale generation is rejected before target input;
- explicit revoke fences the session and later reconnect fails;
- Done is one-shot and fences later input before consumer completion handling.

These are the same authority semantics used by the Native/WebRTC siblings; transport selection is not exposed to consumers.

## Latency comparison

No numeric physical latency result is recorded for Issue #40 yet. Earlier WebRTC physical acceptance proved both direct and relay paths, but the retained evidence only records path class / successful Human interaction, not a p50/p95 RTT or first-frame distribution. The WSS iPhone run likewise did not timestamp glass-to-glass response.

Therefore the defensible comparison today is operational rather than numeric:

| Property | WebSocket | WebRTC direct | WebRTC + TURN |
|---|---|---|---|
| Network setup | HTTPS upgrade; no ICE gathering | ICE negotiation; direct candidate pair | ICE negotiation plus relay allocation |
| Video delivery | JPEG/PNG frames over reliable ordered TCP/WSS with latest-frame dropping at the application boundary | H.264/RTP optimized for real-time delivery | Same H.264/RTP through relay |
| Expected latency under loss | Can exhibit TCP head-of-line delay; latest-frame dropping bounds producer backlog but cannot remove transport-level HOL | Best latency when direct path is viable | Added relay RTT/cost, but retains real-time media semantics |
| Infra requirement | Standard HTTPS/WSS ingress only | STUN/ICE reachability | TURN provider/credentials when direct path is unavailable |
| Operational simplicity | Highest for HTTPS-only platforms if their WebSocket routing works | Moderate | Highest network reachability, more infra/trust boundary |
| Recommended role | Private/experimental managed-runtime alternative and diagnostic path | Primary browser low-latency transport | WebRTC fallback for WAN/NAT reachability |

A future numeric comparison should capture the same identifier-free metrics for each viable path: locator/connect start to first rendered frame, input creation to visible target response, and (for WebRTC) selected-pair RTT. Until those are collected in the same physical session, this repository should not claim that WSS is faster or slower by a specific number.

## Decision

Keep WebRTC as the primary browser low-latency transport. Keep WebSocket as a private experimental sibling because it successfully provides physical iPhone Safari Human takeover without TURN and preserves the same authority boundary. Do not promote the WebSocket API to stable/public while the Cloud Run public hostname path remains externally blocked and same-session numeric latency data is absent.
