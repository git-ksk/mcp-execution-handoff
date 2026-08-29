# Component ownership and support matrix

This document is the checked-in component-completeness view for Handoff. It records what Handoff
owns, what remains consumer-owned, and which Target Surface / host / transport combinations are
actually supported. Architectural composability is **not** a support claim.

Tracked by #151 and the conformance gate #184.

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
| Window | macOS ordinary exact window | **Supported** | **Supported** | **Deterministic / physical pending (#183)** | Explicit WSS-only facade exists; managed OS-neutral composition is #185. No desktop fallback. |
| Window | macOS LocalAuthentication secure window | **Supported** | **Supported where WebRTC relay is selected** | **Deterministic / physical pending (#183)** | Explicit PID-only secure policy. Backspace/secure text and Human pointer only as reviewed; Enter is not approval. |
| Window | macOS same-process successor/modal lineage | **Supported** | **Supported where WebRTC relay is selected** | **Planned (#186)** | Exact-one remains default; WSS must reuse the existing lineage authority primitive before support is claimed. |
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

## High-risk conformance gaps

P0/P1 work that most directly reduces future consumer-to-Handoff backtracking:

- **P0 #172** — retain a valid WSS generation after explicitly recoverable Human input helper/ACK
  failure while still fencing exact authority loss. Deterministic implementation is present on the
  #183 work branch; merge/consumer evidence remains to be closed out.
- **P0 #177** — make Human completion vs authority loss lifecycle deterministic and physically clear;
  WSS verification parity is part of the current #183 work, while Browser physical terminal-state
  acceptance remains tracked by #177.
- **P0 #183** — macOS ordinary + LocalAuthentication exact-window WSS-only component; deterministic
  implementation/harness exists, physical iPhone Safari acceptance is still required.
- **P0 #184** — turn this matrix into a durable failure-injection/conformance gate rather than a
  prose-only inventory.
- **P0 #185** — deterministic implementation is present: transport order/transport-only selection is exact, managed Window WSS construction uses one OS-neutral macOS/Linux surface factory, and managed diagnostics consume one bounded OS-neutral projection. Merge/CI closeout remains; successor/modal WSS lineage stays separately tracked by #186.
- **P1 #186** — reuse the existing macOS same-process successor authority under WSS.
- **P1 #160** — reduce WSS interaction jank only after correctness/authority gates remain green.
- **P2 #151/#159** — product/package/clean-checkout delivery maturity; do not confuse packaging with
  authority correctness.

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
