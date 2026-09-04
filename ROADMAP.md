# Roadmap

[日本語](ROADMAP.ja.md)

This roadmap describes product and contract direction, not a release schedule. Version numbers are milestones with exit criteria; the project may insert additional pre-1.0 versions when needed. There is no requirement that `0.9` be followed by `1.0`.

## Current baseline: v0.4.2

`v0.4.2` is the current GitHub/source-release baseline. It retains the v0.4.1 Desktop Session / Display Backend boundary and fixes credential-safe external Human-surface expiry (#226): expired cached locators are never returned as active, fresh provider issuance is explicit, and expiry cleanup cannot restore authority or replay Human input. No Target Surface, Desktop authority, OS-support, transport-provider, Browser/Terminal semantic, virtual/remote backend, or physical dynamic-resize scope is added.

The npm package remains `private: true`. npm publication is not required for the roadmap and is governed by a separate publication gate below.

### Current working state — 2026-09-04

The post-v0.1.0 validation now has three first-class consumer-facing Handoff components backed by real consumer evidence. #46 documents the semantic-domain/Target Surface admission contract, and the v0.2 terminology convergence adds canonical Human Interaction Policy aliases without freezing a `TargetSurfaceKind` enum:

- `BrowserHandoffAdapter` is complete (#70) and remains the canonical high-level Browser WebRTC composition. Browser completion is now immediate and one-shot on the Browser Human-control session (#84).
- `WindowHandoffAdapter` is complete (#85) and consumed by CUMG instead of consumer-local `TakeoverBroker`/runtime assembly. Merged-code physical iPhone acceptance has passed both public Tunnel/TURN relay and same-LAN direct paths, including stale-locator rejection.
- `TerminalHandoffAdapter` is complete (#86). CUMG no longer composes the experimental PTY authority and Terminal WebRTC transport as unrelated pieces; merged-code real-PTY cross-repo E2E and physical iPhone Human acceptance passed. Mobile connection/authority/verifying state is now explicit and fail-closed (#91).
- Browser WebRTC reconnect after Safari suspend/disconnect is deterministic (#104): generation release is single-flight, overlapping lifecycle triggers coalesce to one reconnect, active-lease conflicts are bounded/observable, and a physical same-LAN iPhone run recovered through three background/foreground cycles without a 409 loop or black-frame stall. Full app termination still requires a fresh authorized flow rather than implicit lease reclamation.
- The HTTPS/WSS managed-runtime evaluation from #40 has been promoted through #152/#155/#156 into the Handoff-owned Browser/Window fallback sequence `WebRTC direct -> WebSocket relay -> optional WebRTC/TURN relay`. Production-shaped Cloud Run `run.app` physical iPhone Safari acceptance passed with TURN absent, including bounded Human input, Done, verification/teardown, and stale direct/WSS fencing. Maps consumer adoption is tracked separately in `git-ksk/maps-browser-mcp#147`.
- The macOS managed Window/WSS line is complete for the v0.4.0 boundary: #183 provides the reusable exact-window WSS surface including physical iPhone Safari LocalAuthentication Cancel/benign-Approve acceptance, #185 completed OS-neutral managed exact-window transport composition, #186 completed bounded same-process successor-window lineage parity, and #184 completed the executable Target Surface × OS × transport support matrix, acceptance-evidence index, and content-free failure/auth-UX conformance gates.
- #188 completed mobile input normalization across WebRTC/WSS, and #143/#210 completed the remaining mobile composition/precision parity: Japanese IME replacement semantics, explicit software-keyboard persistence, Backspace/Enter handling, generated-client syntax gating, physical iPhone scroll direction, and client-local WSS Aim/precise Tap are revalidated without widening server authority. The separately bounded System Settings authorization-to-successor authority investigation remains #211.
- #47 completed reusable bounded macOS/Linux exact-window primitives without adding whole-desktop fallback.
- #48 completed the bounded Terminal/PTY semantic dogfood that established staged Agent/Human drain fences, explicit resume, mandatory post-Human state synchronization, and no Human-period output replay to Agent.
- CUMG is the proven non-browser consumer for both Window and Terminal integration boundaries.

The three proven **surface shapes** are Browser, bounded OS Window, and bounded Terminal/PTY. This does **not** imply a frozen public `TargetSurfaceKind` enum. #46 remains the semantic-domain/admission baseline; the v0.2 terminology gate is complete with compatibility aliases for the policy axis and documentation-first Target Surface labels.

Documentation/design closeout is complete for #42 (positioning), #46 (semantic domains/Target Surface admission), and #5 (MCP-principal vs target-service identity separation). Historical umbrella issues #11 and #13 are also closed as superseded: supported work now lives in first-class bounded Window/WebRTC/WSS evidence, v0.2.x bounded hardening (#124/#56/#34 completed), v0.3 recovery/observability (#127–#130), post-release v0.3.x maintenance, the completed v0.4.1 Desktop Session boundary (#161), the concrete v0.5.0 connectivity line (#19), the sequenced v0.6.0 hosted line (#12), and separate authority research (#211/#125). Whole-desktop and mandatory custom Native-client directions are not retained as default product scope.

Issues #94 and #124 are complete. #94 proved the existing exact-window stateful macOS pointer backend can operate the tested System Settings secure control without a privileged Screen Sharing/Remote Management fallback. #124 then added explicit opt-in successor-window lineage: a Human session may rotate from one exact window to one uniquely proven newly observed same-process successor, with the old mutable target fenced and ambiguity failing closed. Physical iPhone acceptance rotated `Accessibility -> Add (+) -> Open` within the same WebRTC session; the chooser was a same-PID focused `AXDialog`/modal at WindowServer layer 8, admitted only through the lineage-only rule. Ordinary exact-one-window behavior remains unchanged and layer-zero bounded. #211 is now the narrow bounded secure-flow research step; broader Desktop authority remains a separate #125 research escalation only if bounded authority is physically proven insufficient, and never a hidden fallback.

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
| #172 | v0.3.x recoverable WSS input | **Complete.** Recoverable helper/ACK failures end the bound use but retain the valid WSS session, report `dispatch_rejected`, never replay failed Human input, and still revoke on exact authority loss. |
| #143 | v0.3.x mobile composition | **Complete.** Explicit user-gesture keyboard/composition remains first-class across mobile WebRTC/WSS without credential/content inspection. |
| #150 | v0.3.x lifecycle presentation | **Complete.** Physical LocalAuthentication OK/Cancel acceptance proved stale-frame clearing, input fencing, neutral `Verifying…`, and consumer-verification-only terminal success. |
| #188 | v0.3.x mobile input normalization | **Complete.** WebRTC/WSS now share the reviewed IME/keyboard/gesture semantics; physical iPhone acceptance also caught and fixed WebRTC scroll-direction drift. |
| #189 | v0.3.x auth UX feedback | **Complete.** Responsibility boundaries and synthetic no-secret auth lifecycle conformance are fixed without credential brokerage or Target Surface widening. |
| #210 | v0.3.x WSS mobile-control parity | **Complete.** WSS client-local Aim/pan/zoom parity is physically accepted; only explicit mapped Tap emits remote input and the server authority boundary is unchanged. |
| #183 | v0.4 macOS WSS surface | **Complete.** Reusable macOS exact-window WSS-only path is physically accepted for ordinary Window and LocalAuthentication Cancel/benign Approve, with no WebRTC/ICE/STUN/TURN construction or desktop fallback. |
| #184 | v0.4 component baseline | **Complete.** Executable support/acceptance matrix and P0 failure-injection/auth-UX gates are checked in; unsupported combinations remain explicit/fail-closed. |
| #185 | v0.4 managed composition | **Complete.** Managed exact-window transport composition is OS-neutral and consumer code no longer selects concrete Linux/macOS WSS construction. |
| #186 | v0.4 WSS successor lineage | **Complete.** Physical iPhone Safari acceptance proved bounded same-process successor rotation over WSS with stale-generation fencing. |
| #211 | Authority Research — Bounded Secure Flow | **Open.** Investigate a narrowly proven System Settings authorization → independently admitted successor flow; no generic secure-UI or desktop fallback. |
| #161 | v0.4.1 Desktop Session / Display Backend | **Complete / v0.4.1 boundary.** Internal Window-only physical backend boundary separates persistent session/display continuity from viewer/transport generations; viewer scaling is distinct from unsupported physical display resize. No Desktop authority/public subpath/virtual or remote backend is added. |
| #226 | v0.4.2 maintenance | **Complete / v0.4.2 gate.** Expired credential-safe Human surfaces are fenced, matching stale retries fail explicitly, fresh issuance requires a separate `begin()`, and no Human input/authority is replayed or restored. |
| #227 | Host Parity Backlog — Windows Browser | **Open / version uncommitted.** Future bounded Windows Browser Handoff parity; requires dedicated Windows + mobile physical acceptance before support claim. |
| #228 | Host Parity Backlog — Linux successor lineage | **Open / version uncommitted.** Future Linux-native successor-window lineage parity; does not block current Linux exact-window support. |
| #125 | Authority Research — Desktop Escalation | Design broader explicit Human-only Desktop Handoff only if #211 or another physical workflow proves bounded Window/successor authority insufficient; no silent Window-to-Desktop fallback. |
| #19 | v0.5.0 provider-neutral connectivity | Finish provider-neutral Handoff-owned relay/connectivity configuration around the existing Cloudflare/coturn seams. |
| #12 | v0.6.0 hosted topology | Define provider-neutral hosted control plane + stateful execution-worker topology with bounded durable state and outbound worker connectivity. |

## Product Readiness — independent cross-cutting track

Product Readiness is separate from Transport/Hosted maturity and from npm publication. The current
source-release JavaScript artifact is consumer-ready through the clean committed-`dist/` gate (#159),
and the executable Target Surface/transport support inventory, acceptance-evidence index, failure injection, and synthetic auth-UX lifecycle gates are machine-checked under completed #184. Release-significant
consumer evidence must now record exact consumer + Handoff revisions and distinguish deterministic,
consumer-integration, physical-component, and physical-dogfood evidence.

Native-helper delivery remains source/deployment-owned until explicit provenance/integrity gates exist:
macOS deployments own reviewed Swift/Xcode builds, stable code-sign identity where persistent TCC is
required, and controlled-device permissions; Linux deployments own the pinned OS/runtime dependency
baseline and appropriate exact-window acceptance. Prebuilt binaries, if introduced later, require
explicit signing/notarization or distro/ABI/provenance/rollback gates before product-ready claims.

Upgrade/rollback never restores stale locator/capability/generation/media/input authority. Durable
recovery remains `reissue_and_revalidate`, and consumer semantic verification/replay policy remains
consumer-owned. Human-visible lifecycle quality is also part of this track: #150 is complete, with physical OK/Cancel evidence that stale LocalAuthentication presentation is cleared as soon as the exact target disappears while semantic success remains consumer-owned.

See [Product readiness and consumer compatibility](docs/product-readiness.md).

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

## v0.4.2 source release

`v0.4.2` is the current **GitHub source release**. It is a bounded v0.4.x maintenance patch owned by #226: credential-safe external Human surfaces now treat declared expiry as a hard cached-surface cutoff, never return stale locators as active, reject already-expired provider grants, and require a separate explicit `begin()` for fresh provider issuance. Best-effort stale-provider cleanup cannot complete the Human intervention, restore Agent authority, replay Human input, or attest target-service authentication.

The release is tracked by milestone `v0.4.2 — Maintenance` (#13). #227 (Windows Browser Handoff parity) and #228 (Linux successor-window lineage parity) remain version-uncommitted and non-blocking. No new Target Surface, OS-support claim, Desktop authority, transport-provider claim, public package subpath, or npm publication is introduced.

## v0.4.1 source release

`v0.4.1` is the previous **GitHub source release**. It is a compatible v0.4.x architecture patch: #161 places the existing Physical Window path behind an internal Desktop Session / Display Backend boundary so application/session continuity, physical display attachment, Human viewer attachment generation, and transport/client generation are distinct. Viewer disconnect/reconnect does not destroy the application/Desktop Session; viewer scaling is not physical display resize; stale generation/retargeting fails closed; Human input is never replayed; disconnect is not Done; and consumer verification still owns semantic success.

The release is tracked by milestone `v0.4.1 — Desktop Session Boundary` (#8). #220 only raises the WSS container acceptance job timeout from 20 to 40 minutes while preserving every acceptance step. No Desktop authority, public package subpath, virtual/remote backend, Browser/Terminal semantic change, or physical dynamic-resize support is introduced. npm publication remains separate and `private: true` stays required.

See [Release process](RELEASING.md) for the repeatable source-release checklist and the separate npm publication boundary.

## v0.4.0 source release

`v0.4.0` is the previous **GitHub source release**. It carries forward the v0.3 Recovery & Observability boundary and promotes the completed post-v0.3 bounded transport/component work: macOS exact-window WSS and LocalAuthentication WSS, managed recoverable WSS semantics without Human-input replay, mobile keyboard/Aim/scroll parity, executable Target Surface × OS × transport plus auth-UX conformance, and stale secure-frame fencing while consumer verification is pending.

The release was tracked by milestone `v0.4.0 — Source Release` and Issue #213. At that release boundary, provider-neutral relay/connectivity (#19), hosted topology (#12), Desktop Session / Display Backend (#161), explicit Desktop authority (#125), and bounded System Settings successor investigation (#211) remained later work; #161 is now completed in v0.4.1 without widening authority. npm publication remains a separate gate and `private: true` stays required.

See [Release process](RELEASING.md) for the repeatable source-release checklist and the separate npm publication boundary.

## v0.3.0 source release

`v0.3.0` is the previous **GitHub source release**. It promotes the completed v0.3 Recovery & Observability contract into the source baseline while also carrying the bounded hardening merged after v0.2.0: secure-system Window admission, same-process successor-window lineage, Window media quality, Linux editable-region parity, and the current Cloudflare TURN credential contract.

The release was tracked by milestone `v0.3.0 — Source Release` and Issue #145. Its non-blocking `v0.3.x — Maintenance & Durability` follow-up supplied lifecycle/product UX, recoverable WSS, mobile input/composition, and repository/package hardening that is now incorporated into the v0.4.0 source boundary. npm publication remains a separate gate and `private: true` remains required.

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
- keep #125 as a separate explicit Human-only Desktop authority investigation after #211 or equivalent narrow authority research proves a concrete workflow cannot be represented by bounded Window/successor authority;
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

## v0.3.x — Maintenance & Durability

Milestone `v0.3.x — Maintenance & Durability` is the completed non-blocking post-v0.3 line. All eight tracked issues are closed as of 2026-09-04. The line preserved the v0.3.0 authority/recovery contract and did **not** silently introduce broader Human-control authority or become a release gate.

The release-significant maintenance set carried into v0.4.0 is complete: recoverable WSS input (#172), mobile keyboard/composition (#143), stale LocalAuthentication presentation (#150), auth-UX responsibility/conformance (#189), and WSS Aim/precise-tap parity (#210).

Completed maintenance also includes signed-file durability (#141), roadmap/worktree hygiene (#142/#144), bounded initial LocalAuthentication admission (#147), product-readiness and clean consumer-artifact gates (#151/#159), managed WSS keyboard observability (#181), and cross-transport mobile input normalization (#188).

Exit discipline for this line:

- each change preserves existing principal/epoch/lease/generation and target-surface authority invariants;
- UX fixes may improve Human observability/interaction but cannot infer `Done`, replay Human input, expose credential/content data, or widen Window/Desktop authority;
- deterministic and relevant physical acceptance stays attached to the exact revision being claimed;
- source release/tagging and npm publication remain separate decisions.

As of 2026-09-04, the `v0.3.x — Maintenance & Durability` milestone is closed with 0 open / 8 closed issues. The former `v0.4+ — Transport & Hosted Maturity` catch-all is also closed. Six Issues are currently open and are classified explicitly: `v0.5.0 — Provider-Neutral Connectivity` (#19), `v0.6.0 — Hosted Worker Topology` (#12), `Authority Research — Bounded Secure Flow` (#211), `Authority Research — Desktop Escalation` (#125), plus version-uncommitted host-parity backlog #227 (Windows Browser Handoff) and #228 (Linux successor-window lineage). #226 is complete in the v0.4.2 maintenance line. New work must be classified when the Issue is created rather than left outside roadmap accounting.

## v0.4.2 — Maintenance

`v0.4.2` is the completed bounded maintenance source release after `v0.4.1`. Its release-significant scope is intentionally limited to #226, the credential-safe external Human-surface lifecycle bug found during Maps Browser MCP dogfooding.

Goal: ensure an expired or provider-stale cached Human surface is never returned as if it were still active, without widening authority or changing the transport roadmap.

Scope:

- #226 — **complete:** reject expired credential-safe external surfaces under the existing intervention / epoch / principal / generation contract and require a separate explicit fresh issuance;
- preserve no-replay, stale-authority fencing, fail-closed target/window loss, and content-free diagnostics;
- document deterministic consumer recovery behavior for stale/expired provider surfaces.

Explicitly triaged out of `v0.4.2`:

- #227 — Windows Browser Handoff parity is useful future host coverage, but it adds a new physical OS support claim and requires dedicated Windows + mobile acceptance; it is not a patch-release gate.
- #228 — Linux successor-window lineage parity broadens Linux Window capability and requires Linux-native lineage evidence plus physical acceptance; it is not a patch-release gate.

Exit criteria:

- #226 deterministic expiry/staleness coverage is green on the exact release revision;
- no expired cached locator can be returned as active and no Human input/authority is replayed or resurrected;
- relevant consumer regression evidence is attached;
- `v0.4.2` introduces no new Target Surface, OS-support, Desktop-authority, or transport-provider claim;
- npm publication remains a separate decision.

## Host Parity Backlog — version uncommitted

#227 and #228 are classified roadmap work but remain version-uncommitted until concrete consumer need and the required physical acceptance justify scheduling them. They do not block `v0.4.2`, `v0.5.0`, or `v0.6.0`.

## v0.5.0 — Provider-Neutral Connectivity

`v0.5.0` is the next planned feature source-release line after the bounded `v0.4.2` maintenance release. Milestone `v0.5.0 — Provider-Neutral Connectivity` is intentionally narrow and is owned by #19.

Goal: make WebRTC discovery/relay connectivity an explicit **Handoff-owned, provider-neutral deployment boundary** without changing the consumer-facing Browser / Window lifecycle or widening Human-control authority.

Scope:

- evolve the existing ICE credential/provider seam into a provider-neutral connectivity/relay boundary;
- keep direct-first behavior and deliberate browser/server gathering policy under Handoff control;
- retain Cloudflare Realtime TURN as one implementation rather than the product abstraction;
- make a coturn/self-hosted provider implementable without changing consumer APIs;
- keep relay secrets, provider choice, STUN/TURN details, and candidate policy out of MCP tool arguments/results, model context, consumer configuration, logs, and durable checkpoints;
- prohibit silent cross-vendor failover; provider changes remain explicit deployment/security decisions;
- keep bounded identifier/content-free connectivity diagnostics;
- preserve existing generation fencing, one-client ownership, revoke semantics, no Human-input replay, and consumer-owned semantic verification.

Exit criteria:

- #19 acceptance criteria are complete against the exact release candidate revision;
- established consumers contain no provider-selection or TURN-credential handling logic;
- direct-only and relay-enabled paths remain deterministic and fail closed under provider failure;
- Cloudflare and at least one provider-neutral/self-hosted implementation shape are proven through the same Handoff-owned seam;
- documentation clearly separates hosted ingress/tunnel concerns from WebRTC relay/TURN;
- relevant deterministic, consumer-integration, and physical evidence is attached to the exact candidate revision;
- npm publication remains a separate decision and `private: true` is preserved unless its independent gate is explicitly completed.

## v0.6.0 — Hosted Worker Topology

`v0.6.0` is the planned hosted-architecture line after the v0.5.0 connectivity boundary. Milestone `v0.6.0 — Hosted Worker Topology` is owned by #12 and must consume, rather than redefine, the provider-neutral connectivity contract established by #19.

Goal: separate a hosted Handoff/MCP control plane from a stateful browser/desktop execution worker while preserving the same intervention, authority, reconnect, revoke, and semantic-verification contract.

Scope:

- define provider-neutral hosted control-plane + stateful execution-worker topology;
- prefer authenticated **outbound** worker connectivity so private/local workers do not require public inbound listeners;
- bind worker registration and intervention routing to authenticated worker identity, principal, epoch, and current generation;
- persist only bounded control-plane metadata; frames, typed secrets, credentials, cookies, and arbitrary target content remain non-durable;
- define duplicate ownership, stale reconnect, worker liveness, reassignment, revocation propagation, and latest-frame/backpressure semantics fail closed;
- keep persistent browser/profile/session storage outside disposable control-plane instances;
- document reference shapes for local-only, hosted-control-plane + local worker, and hosted-control-plane + remote/stateful worker deployment.

Exit criteria:

- #12 acceptance direction passes for both hosted-control-plane + local worker and hosted-control-plane + remote/stateful worker references;
- the worker requires no inbound public listener in the reference topology;
- disconnect/reconnect preserves epoch, one-client ownership, and stale-generation fencing;
- Done/Cancel/expiry revokes relay and local execution capability before Agent resume;
- fresh Agent readiness/revalidation remains mandatory after Human completion;
- v0.6.0 introduces no implicit Desktop authority and does not make #125 a prerequisite.

## Authority Research — version uncommitted

Authority expansion is intentionally separated from the v0.5.0 → v0.6.0 transport/hosted release line. These milestones are research/decision gates, not promised release versions.

### #211 — Bounded Secure Flow

Milestone `Authority Research — Bounded Secure Flow` narrowly investigates the exact System Settings authorization → independently admitted successor flow. The preferred outcome is to prove or reject a bounded Window-authority rule without generic secure-UI authority or Desktop fallback.

- preserve existing LocalAuthentication and same-process successor-lineage contracts unless a reviewed narrow extension is required;
- keep credential contents transient and out of logs/checkpoints/model context;
- unknown, ambiguous, stale, cancelled, timed-out, or identity-changed transitions fail closed;
- successful authorization may continue only to an independently proven successor, not arbitrary UI;
- this research does not block v0.5.0 or v0.6.0.

### #125 — Desktop Escalation

Milestone `Authority Research — Desktop Escalation` remains a design/research gate. A broader Human-only Desktop Handoff must **not** be scheduled into a release merely because the internal Desktop Session / Display Backend boundary exists.

Proceed beyond design only if #211 or another concrete physical workflow proves that an important Human workflow cannot be represented safely by bounded Window/successor authority. Any future Desktop authority must be explicit, separately requested, Human-only, fail closed across display/session changes, revoked before Agent resume, and never an automatic Window recovery path.

The authority sequence is therefore **#161 complete → #211 narrow proof/rejection → #125 only with concrete physical necessity**.

## Later pre-1.0 interoperability and transport direction

Beyond the concrete v0.5.0/v0.6.0 lines, continue to:

- track MCP MRTR, elicitation, Tasks, and related protocol evolution, removing project-specific plumbing when the standard subsumes it;
- test against multiple MCP client/server implementations where practical;
- maintain first-class Browser / Window / Terminal components so consumers depend on bounded lifecycle/target semantics instead of low-level transport internals;
- extend transport conformance for capability, lease, origin, expiry, revocation, reconnect-handle rotation, and client-generation fencing;
- retain the historical #11/#13 closeout decisions: whole-desktop control and mandatory custom Native-client paths are not default product scope;
- validate additional low-latency/native/WebTransport paths only when they add evidence not already covered by current WebRTC/WSS acceptance.

### Transport family direction

Human takeover transports should remain replaceable siblings behind the same broker authority/lifecycle contract rather than becoming consumer-specific forks. The intended family is:

- **Native** — dedicated native operator client; highest control/performance potential, but requires an installed app.
- **WebRTC** — primary browser low-latency transport. Prefer direct ICE when reachable and use an optional TURN provider only as WAN/NAT fallback. TURN is infrastructure, not a core Handoff requirement.
- **WebSocket** — supported HTTPS/WSS managed-runtime transport. The historical accepted deployment used it after direct WebRTC, while current managed policy may place it first, later, or alone. It can avoid TURN entirely for the WSS leg while reusing exact-window helpers, one-client lease, generation fencing, revoke semantics, and bounded latest-frame policy.
- **HTTP streaming + bounded input requests** — a simpler correctness/deployability fallback or diagnostic path if it proves useful; not the performance target.
- **WebTransport / HTTP/3** — a future low-latency browser candidate when the deployment platform exposes a suitable end-to-end path. It must remain an optional transport rather than changing core semantics.

Transport-specific mechanisms such as ICE/SDP/RTP/DataChannel, WebSocket framing/backpressure, or future WebTransport streams/datagrams must stay inside the transport implementation. Consumers should continue to depend on locator/start/reconnect/revoke-style lifecycle semantics, not the underlying network protocol.

Issue #40 completed the initial WebSocket managed-runtime evaluation: physical iPhone Safari WSS control, bounded latest-frame/drop behavior, and Cloud Run application reachability were demonstrated. Issues #155 and #156 then promoted those proven primitives into the Handoff-owned Browser/Window managed fallback without duplicating the authority/session stack. This is not a transparent socket downgrade: each transition revokes/fences the abandoned transport before a fresh generation/capability can admit Human input.

The production-proven default remains `WebRTC direct -> WebSocket relay -> optional relay-capable WebRTC`, while managed Browser/Window composition represents transport selection as an exact finite ordered policy. Deployments may intentionally choose WSS-only, direct-only, relay-capable-WebRTC-only, or another reviewed unique order without consumer-side transport branching. Stale direct-WebRTC and WSS generations fail closed, admitted input is never replayed across transports, disconnect is not Done, and exact process/window plus Human input policy remain unchanged across fallback. #152 remains the production-shaped Cloud Run physical evidence baseline; unsupported numeric latency claims remain excluded from `experiments/websocket-cloud-run/COMPARISON.md`.

Later pre-1.0 versions remain evidence-driven. `v0.7`, `v0.8`, `v0.10`, or other pre-1.0 releases may be introduced when a concrete compatibility or maturity boundary exists; version numbers are not reserved merely to fill a sequence.

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
