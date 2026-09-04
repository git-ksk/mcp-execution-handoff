# Component ownership and support matrix

This document is the checked-in component-completeness view for Handoff. It records what Handoff
owns, what remains consumer-owned, and which Target Surface / host / transport combinations are
actually supported. Architectural composability is **not** a support claim.

Tracked by #151 and the conformance gate #184. The machine-readable companion is
[`component-support-matrix.json`](component-support-matrix.json); `tests/component-support-matrix.test.ts`
rejects support-state drift, missing deterministic coverage references, missing physical-acceptance
commands for physical-pending rows, and untracked P0 failure-injection categories.

## Ownership boundary

### Handoff owns

For a Target Surface that Handoff exposes as a first-class component, Handoff owns the reusable
security and Human-control mechanics that a consumer should not have to reconstruct:

- intervention authority, resource epoch, principal/invocation binding and resume policy;
- one-client Human lease, client generation, capability/reconnect fencing, expiry and revoke;
- exact target admission/revalidation for supported Browser/Window hosts;
- bounded Human capture/input transport mechanics for supported Browser/Window hosts;
- transport construction, transport-generation sequencing and provider/connectivity policy;
- transient-vs-authority-loss failure classification where the surface can distinguish them safely;
- Human `Done` fencing and transition to consumer verification without treating Done as approval;
- restart/recovery semantics (`reissue_and_revalidate`, never stale authority restoration);
- privacy-bounded audit/readiness/operator diagnostics;
- deterministic conformance and canonical physical acceptance harnesses.

Raw framebuffer and Human-input bytes may exist only in the ephemeral Human transport path needed to
operate the bounded surface. They are not generic MCP/model data and must not enter logs, audit,
checkpoints or reusable continuity state. Credentials, cookies, tokens, OTP/MFA values, typed
secrets and account identity are never continuity material.

### Consumer owns

Consumers keep the semantics that Handoff cannot safely infer generically:

- whether/why an intervention is authorized, including quarantine and business policy;
- application/browser-profile/process lifecycle except where an explicit Handoff host helper owns a
  narrow capture/input mechanism;
- selecting the already-authorized candidate process/window or consumer-owned PTY/session;
- PTY allocation, descendant/process containment, cwd/env/job-control and process truth;
- target-service identity/account checks;
- fresh post-Human semantic/postcondition verification;
- consequential-action approval and replay/reissue policy beyond Handoff's stale-authority fences.

The consumer may provide an exact target candidate, but Handoff must validate the authority boundary
before it permits Human capture/input. A consumer must not duplicate Handoff's lease/generation,
transport fallback, exact-window authority or recovery state machine merely because an OS or
transport differs.

## Support states

- **Supported** — deterministic Handoff coverage exists and the path has the acceptance evidence
  documented by the component/transport contract.
- **Deterministic / physical pending** — reusable implementation and deterministic gates exist, but
  the required physical acceptance has not yet been recorded; do not market this as fully accepted.
- **Planned** — tracked work exists; consumers must not depend on it yet.
- **Unsupported** — Handoff intentionally fails closed. Absence of a transport is not permission for
  the consumer to widen authority or assemble a silent fallback.

## Current matrix

| Target Surface | Host/runtime | WebRTC direct | WebRTC + TURN | WebSocket/WSS | Notes |
| --- | --- | --- | --- | --- | --- |
| Browser | macOS bounded browser/window host | **Supported** | **Supported** | **Not claimed as a first-class macOS Browser WSS path** | Browser remains a browser-policy facade; do not infer support from the macOS Window WSS primitive alone. |
| Browser | Linux isolated exact-window browser host | **Supported** | **Supported where relay is configured** | **Supported managed fallback** | Exact X11 PID/window authority, bounded AT-SPI metadata and WSS helper paths remain Handoff-owned. |
| Window | macOS ordinary exact window | **Supported** | **Supported** | **Supported** | Physical iPhone WSS-only acceptance passed on PR #214, including Aim/text/scroll/Done and consumer completion. No desktop fallback. |
| Window | macOS LocalAuthentication secure window | **Supported** | **Supported where WebRTC relay is selected** | **Deterministic / physical pending (#183)** | Explicit PID-only secure policy. Backspace/secure text and Human pointer only as reviewed; Enter is not approval. |
| Window | macOS same-process successor/modal lineage | **Supported** | **Supported where WebRTC relay is selected** | **Supported** | #186 physical iPhone Safari acceptance proved same-process WSS successor rotation with stale-generation fencing; exact-one remains default. |
| Window | Linux exact X11 window | **Supported** | **Supported where relay is configured** | **Supported managed fallback** | WSS recoverable helper failures retain the valid generation; exact authority loss fences it (#172). |
| Terminal/PTY | consumer-owned bounded PTY | **Supported DataChannel transport** | **Supported where relay is configured** | **Unsupported / not justified** | WSS is not added for visual symmetry. Terminal owns ordered byte-stream/drain semantics, not framebuffer capture. |
| Terminal/PTY | Windows ConPTY-specific containment | **Not claimed** | **Not claimed** | **Unsupported** | The first-class API does not imply Windows descendant-containment parity. |
| Desktop | physical/virtual/remote desktop | **Unsupported as implicit Window fallback** | **Unsupported as implicit Window fallback** | **Unsupported as implicit Window fallback** | Explicit future authority/session work is #125/#161; Handoff is not a general remote-desktop product. |

Native compatibility seams exist below some Browser/Window transport code, but they are not a reason
to claim a fourth blanket first-class transport row. A Native product path requires its own bounded
acceptance evidence.

## Managed transport-plan policy

Browser/Window managed transport sequencing is no longer hard-coded to one fallback order. Handoff accepts a strict `transportPolicy.order` containing one to three unique supported attempts. The array is exact: one entry is an explicit transport-only mode, arbitrary reviewed order is allowed, and omitted attempts stay disabled. The default keeps the production-proven `webrtc_direct -> websocket_relay -> webrtc_relay` shape when those backends are configured.

`webrtc_relay` is intentionally named as the existing relay-capable WebRTC attempt: TURN credentials/candidates are available, but normal ICE remains `all` and may still select a direct pair. A future true relay-only mode must be a separate explicit policy/capability rather than changing this meaning silently. Provider selection and secrets remain deployment-owned below the plan.

The plan never changes Target Surface authority. If a selected attempt cannot support the requested OS/surface policy, construction fails closed before Human mutation; Handoff does not remove that attempt and improvise another order. The WSS host factory defaults to platform auto-detection: macOS reuses the reviewed runtime host executable, while Linux requires its exact-window host script/X11 deployment inputs. An explicit platform override exists for deployment/testing, but consumers never select concrete surface classes.

## Cross-transport invariants

Every supported or planned Human transport must preserve the same authority facts:

1. transport rotation cannot change the intervention, principal or authorized target scope;
2. the abandoned transport generation is fenced before a fresh generation can mutate;
3. Human input is never automatically replayed across reconnect, restart or transport change;
4. disconnect is not `Done`;
5. `Done` fences Human mutation before consumer verification starts and is never semantic approval;
6. exact target authority loss cannot silently rebind to a replacement target;
7. unsupported combinations fail closed instead of widening to desktop/display/frontmost-window;
8. transport/provider details stay below the normal consumer lifecycle API.

## Executable WSS lifecycle gate

[`tests/websocket-lifecycle-conformance.test.ts`](../tests/websocket-lifecycle-conformance.test.ts)
composes the real session manager, WSS session authority and channel. It controls only the clock,
peer and consumer callbacks, so the following boundary checks run without ICE, a browser, platform
helpers, credentials or wall-clock sleeps:

| Boundary | Required result |
| --- | --- |
| Media lease deadline | New input, frames, ping and handshake claims fail closed at the exact deadline. |
| Completion-only grace | A still-open claimed channel may submit Done within the bounded grace even after ticket pruning; Done fails at the grace deadline. |
| Reconnect or resource epoch change | Old input, frames and Done fail; cleanup of the old channel cannot release or mutate the successor. |
| Input in flight | Idle reconnect cannot overtake dispatched input; disconnect does not replay it or imply Done. |
| Expiry with queued input | Already dispatched work may finish; queued input is revalidated and never dispatched after expiry. |
| Explicit authority revoke | A locally open channel cannot send input, deliver frames or complete the revoked session. |
| Completion observer failure | Mutable authority is fenced before the observer runs and stays fenced if it throws. |

Run the focused gate with:

```sh
node --import tsx --test tests/websocket-lifecycle-conformance.test.ts
```

The file is also included automatically by `npm run check` in the existing Linux Node 20/22/24,
macOS Node 22 and Windows Node 22 CI jobs. It complements
[real-socket ingress coverage](../tests/websocket-ingress.test.ts),
[broker completion/revoke coverage](../tests/websocket-broker-binding.test.ts) and
[channel delivery/backpressure coverage](../tests/websocket-takeover.test.ts).

This is a shared WSS authority gate, not proof of every Browser/Window host or of WebRTC/PTY parity.
It does not exercise TLS/proxy delivery, exact-target capture/input helpers, consumer semantic
verification, or physical iPhone Safari behavior. Completion grace is not permission to reconnect
or resume input, and a channel already failed/closed by stale input does not reopen for Done.
Platform support states and pending physical acceptance above remain unchanged; #184 remains open
for the rest of the component/failure matrix.

## High-risk conformance gaps

P0/P1 work that most directly reduces future consumer-to-Handoff backtracking:

- **Completed #172** — recoverable Human-input helper/ACK failure ends the bound use, records
  `dispatch_rejected`, retains the valid WSS generation, and never automatically replays the input;
  exact authority loss still revokes fail-closed.
- **P0 #183** — macOS ordinary + LocalAuthentication exact-window WSS-only component; deterministic
  implementation/harness exists, with the remaining physical acceptance tracked there.
- **P0 #184** — maintain this matrix as an executable conformance gate. The checked JSON index now
  requires deterministic coverage for every supported/conditional/pending row and pins the P0
  content-free failure-injection categories to tests that run under `npm test`. Broader physical
  evidence indexing remains follow-up work.
- **Completed #186** — macOS same-process successor authority is reused under WSS and has physical iPhone Safari acceptance.
- **P2 #151** — Product Readiness/consumer compatibility contract; #159 clean-consumer packaging is complete.

Recently completed hardening is no longer tracked as an open conformance gap: #177 completion/revoke
lifecycle correctness closed after PR #194 plus physical WSS Done/verifying/teardown evidence; #185
OS-neutral managed Window composition closed after PR #187; and #160 managed-WSS latency/jank work
closed after the measurement/fix series through #200/#202.

## Physical acceptance rule

Consumer dogfood is valuable evidence but is not the component test harness. A support row that
requires platform proof must have a Handoff-owned physical acceptance command and record the exact
Handoff revision used. Consumer acceptance may then prove integration without being the only way to
reproduce Handoff behavior.

For #183 the canonical Handoff-owned commands are:

```sh
npm run accept:window:macos-wss
npm run accept:window:macos-local-auth-wss
```

They intentionally construct the WSS-only Window component and no WebRTC/ICE/STUN/TURN runtime. The ordinary command is consumer-independent: it builds and launches a harmless AppKit scroll/text fixture, discovers its exact PID/window id from a local state file, and creates a temporary Cloudflare quick tunnel when `HANDOFF_WSS_PUBLIC_BASE_URL` is not supplied. The acceptance server itself listens only on loopback, while the Human locator uses one exact HTTPS/WSS origin. Its local verifier checks only the fixed harmless marker `WSS_ACCEPT_OK`; framebuffer and Human-input payloads remain outside diagnostics.

The LocalAuthentication command shares the same loopback + exact-HTTPS ingress helper but deliberately does **not** create the secure prompt. A benign already-displayed Apple LocalAuthentication prompt remains the platform precondition, because prompt generation/authorization semantics are outside the transport component.

## Synthetic authentication UX conformance

Authentication semantics remain outside the generic transport. `tests/auth-ux-conformance.test.ts` uses only synthetic identifiers and no credential/page content to prove the lifecycle boundary requested by #189:

- Human `Done` enters `verifying`; it is not authentication success.
- consumer outcomes remain distinct: still at login → fresh Human intervention, verification failed, post-navigation result unknown, or verified success → explicit Agent resume;
- cancellation and expiry never become completion;
- transport loss is not `Done`;
- reconnect rotates the Human generation and stale input authority is rejected;
- the checked observation record is content-free;
- secure-form credential brokering is **out of scope** and form-to-direct mode switching is **unsupported** unless separately designed and reviewed.

Browser/profile/session persistence, destination/provider-step validation, intended-account verification, and consequential-action approval remain consumer/provider responsibilities. This gate deliberately does not encode Google- or ChatGPT-specific behavior.
