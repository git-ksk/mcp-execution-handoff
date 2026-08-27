# Roadmap

[日本語](ROADMAP.ja.md)

This roadmap describes product and contract direction, not a release schedule. Version numbers are milestones with exit criteria; the project may insert additional pre-1.0 versions when needed. There is no requirement that `0.9` be followed by `1.0`.

## Current baseline: v0.3.0

`v0.3.0` is the current GitHub/source-release baseline. It retains the first-class Browser, bounded OS Window, and bounded Terminal/PTY source components from v0.2.0, includes the completed bounded Window/Linux/media hardening, and adds the Recovery & Observability boundary: provider-neutral bounded checkpoint storage, privacy-bounded audit/operator diagnostics v1, and deterministic crash/restart conformance with `reissue_and_revalidate` as the only recovery outcome.

The npm package remains `private: true`. npm publication is not required for the roadmap and is governed by a separate publication gate below.

### Current working state — 2026-08-27

The post-v0.1.0 validation now has three first-class consumer-facing Handoff components backed by real consumer evidence. #46 documents the semantic-domain/Target Surface admission contract, and the v0.2 terminology convergence adds canonical Human Interaction Policy aliases without freezing a `TargetSurfaceKind` enum:

- `BrowserHandoffAdapter` is complete (#70) and remains the canonical high-level Browser WebRTC composition. Browser completion is now immediate and one-shot on the Browser Human-control session (#84).
- `WindowHandoffAdapter` is complete (#85) and consumed by CUMG instead of consumer-local `TakeoverBroker`/runtime assembly. Merged-code physical iPhone acceptance has passed both public Tunnel/TURN relay and same-LAN direct paths, including stale-locator rejection.
- `TerminalHandoffAdapter` is complete (#86). CUMG no longer composes the experimental PTY authority and Terminal WebRTC transport as unrelated pieces; merged-code real-PTY cross-repo E2E and physical iPhone Human acceptance passed. Mobile connection/authority/verifying state is now explicit and fail-closed (#91).
- Browser WebRTC reconnect after Safari suspend/disconnect is deterministic (#104): generation release is single-flight, overlapping lifecycle triggers coalesce to one reconnect, active-lease conflicts are bounded/observable, and a physical same-LAN iPhone run recovered through three background/foreground cycles without a 409 loop or black-frame stall. Full app termination still requires a fresh authorized flow rather than implicit lease reclamation.
- The HTTPS/WSS managed-runtime experiment is complete (#40). Physical iPhone Safari WSS control and Cloud Run application reachability were proven without adding a WebRTC-to-WebSocket silent downgrade.
- #47 completed reusable bounded macOS/Linux exact-window primitives without adding whole-desktop fallback.
- #48 completed the bounded Terminal/PTY semantic dogfood that established staged Agent/Human drain fences, explicit resume, mandatory post-Human state synchronization, and no Human-period output replay to Agent.
- CUMG is the proven non-browser consumer for both Window and Terminal integration boundaries.

The three proven **surface shapes** are Browser, bounded OS Window, and bounded Terminal/PTY. This does **not** imply a frozen public `TargetSurfaceKind` enum. #46 remains the semantic-domain/admission baseline; the v0.2 terminology gate is complete with compatibility aliases for the policy axis and documentation-first Target Surface labels.

Documentation/design closeout is complete for #42 (positioning), #46 (semantic domains/Target Surface admission), and #5 (MCP-principal vs target-service identity separation). Historical umbrella issues #11 and #13 are also closed as superseded: supported work now lives in first-class bounded Window/WebRTC/WSS evidence, v0.2.x bounded hardening (#124/#56/#34 completed), v0.3 recovery/observability (#127–#130), and later explicit authority/transport/hosted work (#125/#19/#12). Whole-desktop and mandatory custom Native-client directions are not retained as default product scope.

Issues #94 and #124 are complete. #94 proved the existing exact-window stateful macOS pointer backend can operate the tested System Settings secure control without a privileged Screen Sharing/Remote Management fallback. #124 then added explicit opt-in successor-window lineage: a Human session may rotate from one exact window to one uniquely proven newly observed same-process successor, with the old mutable target fenced and ambiguity failing closed. Physical iPhone acceptance rotated `Accessibility -> Add (+) -> Open` within the same WebRTC session; the chooser was a same-PID focused `AXDialog`/modal at WindowServer layer 8, admitted only through the lineage-only rule. Ordinary exact-one-window behavior remains unchanged and layer-zero bounded. Desktop authority remains a separate future escalation in #125 and never a hidden fallback.

### Post-v0.2.0 roadmap issue map

The release gate #119 closed after the v0.2.0 tag and GitHub Release were verified. With #94 complete, the durable post-release backlog now includes the explicit v0.3 Recovery & Observability milestone.

| Issue | Roadmap placement | Current disposition |
| --- | --- | --- |
| #56 | v0.2.x media quality | **Complete.** macOS Window-only `window_text` raises the bounded ceiling to ≤1920×1080 / 5 Mbps / 30 fps without source upscaling or backpressure changes; physical iPhone direct + TURN relay acceptance passed. |
| #34 | v0.2.x cross-platform parity | **Complete.** Linux WebRTC now publishes bounded editable-region/focus hints through a read-only AT-SPI helper scoped by target process ancestry and exact-window geometry; no accessible text/name/value, DOM, CDP, or credential data is read, and unavailable/ambiguous accessibility fails closed to empty/non-editable hints. |
| #127 | v0.3 durable recovery | **Complete.** `HandoffCheckpointStore` is synchronous/provider-neutral, loaded values are untrusted and strictly revalidated by Handoff, the signed-file store remains compatible, and recovery is still only `reissue_and_revalidate`. |
| #128 | v0.3 audit | **Complete.** Stable v1 strict audit union keeps the existing checkpoint/recovery event names, bounds fields/cardinality, uses a 256-event memory reference sink, and makes sink failure observe-only without an unbounded core queue. |
| #129 | v0.3 diagnostics | **Complete.** Stable identifier-free v1 operator summaries are exposed by Browser/Window/Terminal, with generic bounded health/failure categories and target/transport-specific facts kept in `webrtc`, `terminal_session`, and `terminal_webrtc` namespaces; detailed diagnostics remain compatible. |
| #130 | v0.3 restart conformance | **Complete / v0.3 recovery gate.** Deterministic first-class tests cover all persisted lifecycle phases, stale Browser/Window locator/capability/generation/reconnect rejection, Terminal Human-active restart/PTY exit, checkpoint corruption/mismatch/expiry, and interrupted writes without stale authority or Human-input replay. |
| #125 | v0.4+ Desktop authority | Design an explicit Human-only Desktop Handoff escalation only for workflows that #124 cannot represent safely; no silent Window-to-Desktop fallback. |
| #19 | v0.4+ transport maturity | Finish provider-neutral Handoff-owned relay/connectivity configuration around the existing Cloudflare/coturn seams. |
| #12 | v0.4+ hosted topology | Define provider-neutral hosted control plane + stateful execution-worker topology with bounded durable state and outbound worker connectivity. |

## Guiding principles

1. **Standards first.** Prefer MCP-native MRTR, elicitation, Tasks, and related protocol mechanisms instead of inventing parallel protocol semantics.
2. **Security invariants before convenience.** Principal/invocation binding, epoch fencing, authority exclusivity, bounded checkpoints, capability lifetime, one-client lease, and replay restrictions are compatibility requirements.
3. **Keep the generic contract smaller than consumer policy.** Domain detection, provider policy, postcondition verification, native execution, and consequential-action approval remain consumer responsibilities.
4. **Prove abstractions with real adapters.** Do not freeze a new public abstraction based only on synthetic examples.
5. **Handoff is not approval.** Human completion never implicitly authorizes another consequential action.
6. **Browser Handoff stays optional.** The core must remain useful without a Browser Target Surface or any Browser-specific transport.
7. **No bypass product.** CAPTCHA solving, anti-bot evasion, credential relay, stealth/fingerprint spoofing, and payment automation remain explicit non-goals.

## v0.1.x — historical maintenance line

Focus:

- bug and security fixes;
- specification-alignment fixes that preserve the current contract;
- documentation and diagnostics improvements; #42 established the current responsibility-boundary positioning baseline;
- regression coverage from Maps and Japan Cinema;
- maintain cross-platform portability gates and real-browser acceptance while target-surface internals are refactored;
- migration notes for any unavoidable pre-1.0 breaking fix.

Exit condition: each patch must preserve the documented security invariants and remain green in both established real consumers.

## v0.3.0 source release

`v0.3.0` is the current **GitHub source release**. It promotes the completed v0.3 Recovery & Observability contract into the source baseline while also carrying the bounded hardening merged after v0.2.0: secure-system Window admission, same-process successor-window lineage, Window media quality, Linux editable-region parity, and the current Cloudflare TURN credential contract.

The release is tracked by milestone `v0.3.0 — Source Release` and Issue #145. The v0.3.x maintenance issues #141–#144 are explicitly non-blocking and remain separate from this tag. npm publication is still a separate gate and `private: true` remains required.

See [Release process](RELEASING.md) for the repeatable source-release checklist and the separate npm publication boundary.

## v0.2.0 source release

`v0.2.0` is the previous **GitHub source release**. It is a minor pre-1.0 boundary because the public surface materially expanded since `v0.1.0`: first-class Browser, Window, and Terminal components are exported, and the Window/Terminal package subpaths are part of the source package shape.

The release was tracked by milestone `v0.2.0 — Source Release` and Issue #119, which closed after the tag and GitHub Release were verified. #124, #56, and #34 complete the immediate v0.2.x bounded-hardening set. The dedicated `v0.3 — Recovery & Observability` milestone is #127–#130; #125, #19, and #12 remain later authority/transport/deployment maturity work. npm publication is explicitly separate and `private: true` remains required.

See [Release process](RELEASING.md) for the repeatable source-release checklist and the separate npm publication boundary.

## v0.2 — Target Surface contract and bounded host hardening

Current scope and closeout:

- keep Browser, Window, and Terminal as first-class consumer-facing components without forcing their distinct media/stream mechanics behind one premature generic surface interface;
- retain #85's completed physical Window evidence across both same-LAN direct and public Tunnel/TURN relay paths, including stale-locator rejection;
- retain #94 as completed evidence: exact-window Human-only macOS input passes the tested secure System Settings control without privileged/desktop fallback;
- retain #124 as completed bounded successor-window evidence: exact-one remains default, opt-in same-process lineage fences the old target and rotates only to a uniquely proven successor; physical iPhone `Accessibility -> Add (+) -> Open` passed without desktop/display fallback;
- keep #125 as a separate explicit Human-only Desktop authority investigation, sequenced after #124 unless physical evidence proves a workflow cannot be represented by bounded window lineage;
- retain #56 as completed bounded Window media evidence: Browser compatibility stays ≤1280×720 / 3 Mbps, macOS Window uses no-upscale ≤1920×1080 / 5 Mbps with unchanged newest-frame backpressure, and physical iPhone direct/TURN relay passed; retain #34 as completed Linux parity evidence with read-only AT-SPI process/window geometry binding, bounded editable/focus metadata only, and no DOM/CDP/credential exposure;
- keep CUMG on `WindowHandoffAdapter` and `TerminalHandoffAdapter`, with Handoff owning canonical authority/session/transport ordering and CUMG retaining authorization, PTY/process containment, quarantine, and semantic verification;
- formalize compatibility fixtures for authority, epoch, ownership, resume policy, request-state binding, and stale surface/session fencing;
- preserve the #5 MCP-principal vs target-service identity boundary without turning Handoff into a service-account attestation API;
- use the #46 semantic-domain/Target Surface admission decision as the architecture baseline; v0.2 exposes canonical Human Interaction Policy names with compatibility aliases while keeping Target Surface documentation-first. A public enum is not required merely because the three component adapters exist.

Target Surface admission remains evidence-based: a new shape should be recognized only when its authority boundary, capture/input model, lifecycle, or postcondition handling is materially different from the proven Browser / bounded OS Window / bounded Terminal-PTY shapes. A different app, OS, device, transport, or deployment path alone is not sufficient.

Exit criteria:

- the Browser, Window, and Terminal components remain green in deterministic tests and real consumer integration;
- bounded OS-window dogfood demonstrates Agent → Human → verifying → Agent over one exact target on the first-class Window adapter for both required connectivity baselines;
- Terminal/PTY remains a bounded session/stream component rather than becoming a shell/process runner, and its real-PTY/iPhone evidence remains reproducible;
- CUMG depends only on the first-class Window/Terminal components rather than Handoff experimental internals;
- #46 remains the semantic-domain/Target Surface admission baseline, and the completed v0.2 terminology convergence preserves compatibility and security invariants;
- any later generic surface API has a documented compatibility strategy and evidence that it is smaller than the target-specific mechanics it coordinates.

npm publication is **not** an exit criterion for v0.2.

## v0.3 — Recovery & Observability

Milestone `v0.3 — Recovery & Observability` turns the existing signed checkpoint, audit sink, bounded diagnostics, and `reissue_and_revalidate` semantics into a production-grade operator contract. It intentionally adds **no new Target Surface or Human-control authority**.

Tracked work:

- #127 — **complete:** provider-neutral synchronous bounded checkpoint-store contract; the signed-file store remains the reference implementation and loaded values stay Handoff-validated;
- #128 — **complete:** stable privacy-bounded v1 audit contract, strict field bounds, bounded memory sink, and observe-only sink-failure semantics;
- #129 — **complete:** stable identifier-free v1 operator summaries across Browser/Window/Terminal, with namespaced target/transport facts and existing detailed diagnostics retained;
- #130 — **complete:** deterministic first-class crash/restart conformance and the release-level stale-authority gate.

Implementation order is #127 first, #128/#129 in parallel once their shared data-classification boundary is concrete, then #130 as the conformance gate.

Exit criteria:

- a provider-neutral checkpoint-store interface exists without widening the generic durable schema;
- raw action arguments, Human input, PTY/browser/media content, credentials/tokens, challenge answers, payment data, approval receipts, and live transport capabilities are structurally outside generic checkpoint/audit/diagnostic state;
- audit events have a versioned, bounded, privacy-reviewed contract with explicit sink failure/backpressure behavior;
- operator diagnostics expose stable genuinely shared categories while transport/Target-Surface detail remains scoped and process-memory by default;
- restart conformance across Browser, Window, and Terminal proves stale Agent/Human authority, locator/capability, generation/reconnect handle, requestState, media/input session, and PTY authority are not restored;
- recovery remains `reissue_and_revalidate`, requires fresh consumer-owned target/session reconstruction where applicable, and never skips semantic verification.

See [Recovery and observability boundary](docs/recovery-observability.md) for the data classification, restart state machine, sequencing, and non-goals.

## v0.4+ — MCP interoperability and transport maturity

Candidate scope:

- track MCP MRTR, elicitation, and Tasks evolution and remove redundant project-specific plumbing when the standard subsumes it;
- test against multiple MCP client/server implementations where practical;
- maintain the first-class Browser / Window / Terminal component family so consumers depend on bounded lifecycle/target semantics instead of assembling low-level broker, WebRTC, or PTY-authority internals themselves;
- add transport conformance tests for capability, lease, origin, expiry, revocation, reconnect-handle rotation, and client-generation fencing;
- finish the provider-neutral connectivity/relay boundary in #19 without exposing ICE/TURN/provider choice to consumers;
- define the hosted control-plane + stateful execution-worker topology in #12 with bounded durable state and authenticated outbound worker connectivity;
- retain the #13 closeout decision: the historical Thin Takeover/mandatory custom Native-client umbrella is superseded by the accepted WebRTC path and completed WSS evaluation; any future native-client work must return as a new narrowly evidenced requirement;
- retain the #11 closeout decision: first-class bounded Window Handoff plus #94 secure UI, #124 successor-window lineage, and #56 media quality supersede the old full-desktop/provider-latency umbrella; #125 may investigate explicit Desktop authority, but desktop-wide control remains outside the default Window boundary;
- validate any additional low-latency push/latest-frame or native Human Takeover path only when it adds evidence not already covered by current WebRTC/WSS acceptance.

### Transport family direction

Human takeover transports should remain replaceable siblings behind the same broker authority/lifecycle contract rather than becoming consumer-specific forks. The intended family is:

- **Native** — dedicated native operator client; highest control/performance potential, but requires an installed app.
- **WebRTC** — primary browser low-latency transport. Prefer direct ICE when reachable and use an optional TURN provider only as WAN/NAT fallback. TURN is infrastructure, not a core Handoff requirement.
- **WebSocket** — first candidate for an HTTPS-only managed-runtime path (including Cloud Run-style deployments) that can avoid TURN entirely. It should reuse the existing exact-window host helpers, one-client lease, generation fencing, revoke semantics, and bounded latest-frame policy.
- **HTTP streaming + bounded input requests** — a simpler correctness/deployability fallback or diagnostic path if it proves useful; not the performance target.
- **WebTransport / HTTP/3** — a future low-latency browser candidate when the deployment platform exposes a suitable end-to-end path. It must remain an optional transport rather than changing core semantics.

Transport-specific mechanisms such as ICE/SDP/RTP/DataChannel, WebSocket framing/backpressure, or future WebTransport streams/datagrams must stay inside the transport implementation. Consumers should continue to depend on locator/start/reconnect/revoke-style lifecycle semantics, not the underlying network protocol.

Issue #40 completed the initial WebSocket managed-runtime evaluation: physical iPhone Safari WSS control, bounded latest-frame/drop behavior, and Cloud Run application reachability were demonstrated without introducing a WebRTC-to-WebSocket silent downgrade. Any future WebSocket productization remains a separate transport-maturity decision rather than an unfinished #40 acceptance gate.

The current experimental sequence keeps the API private until physical acceptance. The bounded channel core and Handoff-owned Node HTTPS/WSS ingress bind through the same `TakeoverSessionManager` used by the broker: WSS has an explicit route marker, cannot be claimed through legacy HTTP/Native/WebRTC for the same live locator, broker revocation closes the WSS channel, and Human Done fences the shared generation before the existing completion hook runs. A private Generic Window composition now keeps the exact process/window target server-side, invokes only an exact-window host-helper surface for frame/input, performs no capture before an authenticated WSS client is active, and revokes the session if exact capture revalidation fails. A private Generic Browser composition now serves a principal-bound Handoff-owned WSS page for bounded JPEG/PNG frames and tap/scroll/text/key/Done control without exposing target process/window identity or transport selection to consumers. Physical iPhone Safari WSS acceptance with the real Linux exact-window helper has passed through an HTTPS/WSS public Tunnel, with server-side content-free evidence for tap/text/scroll/submit/Done. Slow-client latest-frame semantics are stress-tested with a 10,000-frame backlog. The same acceptance image is healthy in Cloud Run. After initial Google Frontend 404s, the `asia-northeast1` public route reached the acceptance application from physical iPhone Safari; the observed `takeover_unavailable` response exposed an acceptance-only stale-locator reuse bug, which is now fixed by explicit fresh-locator rotation (`old locator -> 404`, `fresh locator -> 200`). The temporary Cloud Run acceptance services were removed after evidence capture. Numeric same-session latency comparison against WebRTC direct/TURN is not recorded; see `experiments/websocket-cloud-run/COMPARISON.md`, which intentionally makes no unsupported numeric performance claim. There is no automatic downgrade from WebRTC to WebSocket.

The exact version number for each item will be chosen when the work is concrete. The project may use `0.5`, `0.6`, `0.10`, and later pre-1.0 releases as needed.

## v1.0 — stable contract milestone

`v1.0` means the security and compatibility contract is mature enough for consumers to rely on without routine breaking changes. It is not tied to a particular calendar date, number of pre-1.0 releases, or npm publication.

Minimum exit criteria:

- core authority/epoch/ownership/resume/checkpoint semantics are documented as stable;
- compatibility and migration policy is documented and exercised;
- at least three real adapters have validated the generic boundary, with more than one application domain represented;
- Target Surface boundaries have been validated with real consumers rather than only synthetic examples;
- MCP-standard alignment has been re-audited so the library is not duplicating protocol features unnecessarily;
- Browser Handoff remains optional; Browser Target Surface and Transport stay separate from the generic core;
- Human completion remains distinct from consequential-action approval;
- automatic replay remains explicitly constrained by consumer policy;
- CI, cross-platform portability gates, dependency review, CodeQL, secret scanning, and security reporting remain operational;
- no unresolved known security issue invalidates a documented invariant.

## npm publication gate

npm publication is a delivery decision, not a maturity signal. A source release may exist without an npm package; `v0.1.0`, `v0.2.0`, and `v0.3.0` use that source-only model.

Before setting `private: false` or publishing any package, verify all of the following:

- package name and public export surface are intentionally final for that release;
- installation from the package reproduces the same checked build used by source consumers;
- provenance/release automation and least-privilege publishing credentials are configured;
- published artifacts contain only intended files and no secrets/private endpoints;
- SemVer impact of the public package API is documented;
- at least two real consumers pass against the exact package artifact;
- rollback/deprecation procedure is documented.

A future npm release may be `0.1.x`, `0.2.0`, or later depending on readiness; the roadmap does not reserve a version for npm.

## Out of scope

The roadmap does not include:

- CAPTCHA/challenge solving or bypass;
- anti-bot evasion, stealth, fingerprint spoofing, or proxy rotation;
- credential/OTP/MFA/payment-data transport through MCP;
- a generic browser automation engine;
- generic remote-desktop/device-wide computer-use infrastructure;
- automatic approval or replay of consequential actions;
- provider-specific policies in generic core.

See [Positioning](docs/positioning.md), [Architecture](docs/architecture.md), and [Security Policy](SECURITY.md).
