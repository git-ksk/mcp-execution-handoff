# Roadmap

[日本語](ROADMAP.ja.md)

This roadmap describes product and contract direction, not a release schedule. Version numbers are milestones with exit criteria; the project may insert additional pre-1.0 versions when needed. There is no requirement that `0.9` be followed by `1.0`.

## Current baseline: v0.1.0

`v0.1.0` is the first source release. It established the repository as the upstream source of truth after validation with two real adapters:

- `git-ksk/maps-browser-mcp`
- `git-ksk/japan-cinema-browser-mcp`

The npm package remains `private: true`. npm publication is not required for the roadmap and is governed by a separate publication gate below.

### Current working state — 2026-08-25

The post-v0.1.0 validation now has three first-class consumer-facing Handoff components backed by real consumer evidence, while final Target Surface terminology remains deliberately unfrozen until #45/#46 close:

- `BrowserHandoffAdapter` is complete (#70) and remains the canonical high-level Browser WebRTC composition;
- `WindowHandoffAdapter` is implemented and consumed by CUMG instead of consumer-local `TakeoverBroker`/runtime assembly. Its merged-code iPhone Cloudflare Tunnel/TURN acceptance passed, including stale-locator rejection; #85 remains open only for the same-LAN direct rerun on the first-class adapter;
- `TerminalHandoffAdapter` is complete (#86). CUMG no longer composes the experimental PTY authority and Terminal WebRTC transport as unrelated pieces; merged-code real-PTY cross-repo E2E and physical iPhone Human acceptance passed;
- #47 completed reusable bounded macOS/Linux exact-window primitives without adding whole-desktop fallback;
- #48 completed the bounded Terminal/PTY semantic dogfood that established staged Agent/Human drain fences, explicit resume, mandatory post-Human state synchronization, and no Human-period output replay to Agent;
- CUMG is the proven non-browser consumer for both Window and Terminal integration boundaries.

The three proven **surface shapes** are therefore Browser, bounded OS Window, and bounded Terminal/PTY. This does **not** imply a frozen public `TargetSurfaceKind` enum or final naming. #46 records the semantic admission criteria and #45 is the convergence point for terminology/public API after #85's remaining direct acceptance evidence is closed.

Known follow-up work is intentionally narrow: #85 still needs the first-class Window same-LAN direct physical rerun, and #91 tracks a Terminal mobile UI/status ambiguity where the backend lifecycle completed successfully while Safari could appear to remain on “Connecting”. Neither issue weakens authority, epoch, replay, or privacy boundaries.

## Guiding principles

1. **Standards first.** Prefer MCP-native MRTR, elicitation, Tasks, and related protocol mechanisms instead of inventing parallel protocol semantics.
2. **Security invariants before convenience.** Principal/invocation binding, epoch fencing, authority exclusivity, bounded checkpoints, capability lifetime, one-client lease, and replay restrictions are compatibility requirements.
3. **Keep the generic contract smaller than consumer policy.** Domain detection, provider policy, postcondition verification, native execution, and consequential-action approval remain consumer responsibilities.
4. **Prove abstractions with real adapters.** Do not freeze a new public abstraction based only on synthetic examples.
5. **Handoff is not approval.** Human completion never implicitly authorizes another consequential action.
6. **Browser takeover stays optional.** The core must remain useful without a browser transport.
7. **No bypass product.** CAPTCHA solving, anti-bot evasion, credential relay, stealth/fingerprint spoofing, and payment automation remain explicit non-goals.

## v0.1.x — hardening the established baseline

Focus:

- bug and security fixes;
- specification-alignment fixes that preserve the current contract;
- documentation and diagnostics improvements;
- regression coverage from Maps and Japan Cinema;
- maintain cross-platform portability gates and real-browser acceptance while target-surface internals are refactored;
- migration notes for any unavoidable pre-1.0 breaking fix.

Exit condition: each patch must preserve the documented security invariants and remain green in both established real consumers.

## v0.2 — third-adapter and Target Surface contract validation

Current scope and closeout:

- keep Browser, Window, and Terminal as first-class consumer-facing components without forcing their distinct media/stream mechanics behind one premature generic surface interface;
- finish #85's merged-code same-LAN direct Window acceptance while retaining the already-passed public Tunnel/TURN physical evidence;
- keep CUMG on `WindowHandoffAdapter` and `TerminalHandoffAdapter`, with Handoff owning canonical authority/session/transport ordering and CUMG retaining authorization, PTY/process containment, quarantine, and semantic verification;
- formalize compatibility fixtures for authority, epoch, ownership, resume policy, request-state binding, and stale surface/session fencing;
- use #46/#45 to decide the stable terminology and whether any public Target Surface discriminator is justified. A public enum is not required merely because the three component adapters exist.

Target Surface admission remains evidence-based: a new shape should be recognized only when its authority boundary, capture/input model, lifecycle, or postcondition handling is materially different from the proven Browser / bounded OS Window / bounded Terminal-PTY shapes. A different app, OS, device, transport, or deployment path alone is not sufficient.

Exit criteria:

- the Browser, Window, and Terminal components remain green in deterministic tests and real consumer integration;
- bounded OS-window dogfood demonstrates Agent → Human → verifying → Agent over one exact target on the first-class Window adapter for both required connectivity baselines;
- Terminal/PTY remains a bounded session/stream component rather than becoming a shell/process runner, and its real-PTY/iPhone evidence remains reproducible;
- CUMG depends only on the first-class Window/Terminal components rather than Handoff experimental internals;
- #46/#45 document the final semantic-domain/terminology decision without weakening security invariants;
- any later generic surface API has a documented compatibility strategy and evidence that it is smaller than the target-specific mechanics it coordinates.

npm publication is **not** an exit criterion for v0.2.

## v0.3 — persistence and observability boundaries

Candidate scope:

- evaluate a pluggable durable-checkpoint storage interface while retaining bounded control-plane metadata only;
- make audit/observability hooks easier to integrate without logging sensitive execution content;
- define stable event/diagnostic shapes suitable for operators and tests;
- improve crash/restart conformance coverage.

Exit criteria:

- storage abstraction cannot persist raw action arguments, credentials, browser content, challenge answers, or payment data through the generic API;
- recovery continues to require reissue-and-revalidate rather than restoring stale execution authority;
- observability additions do not create a new secret/content exfiltration path.

## v0.4+ — MCP interoperability and transport maturity

Candidate scope:

- track MCP MRTR, elicitation, and Tasks evolution and remove redundant project-specific plumbing when the standard subsumes it;
- test against multiple MCP client/server implementations where practical;
- maintain the first-class Browser / Window / Terminal component family so consumers depend on bounded lifecycle/target semantics instead of assembling low-level broker, WebRTC, or PTY-authority internals themselves;
- add transport conformance tests for capability, lease, origin, expiry, revocation, reconnect-handle rotation, and client-generation fencing;
- validate a low-latency push/latest-frame transport and a minimal native Human Takeover reference client without turning the project into a generic remote-desktop product.

### Transport family direction

Human takeover transports should remain replaceable siblings behind the same broker authority/lifecycle contract rather than becoming consumer-specific forks. The intended family is:

- **Native** — dedicated native operator client; highest control/performance potential, but requires an installed app.
- **WebRTC** — primary browser low-latency transport. Prefer direct ICE when reachable and use an optional TURN provider only as WAN/NAT fallback. TURN is infrastructure, not a core Handoff requirement.
- **WebSocket** — first candidate for an HTTPS-only managed-runtime path (including Cloud Run-style deployments) that can avoid TURN entirely. It should reuse the existing exact-window host helpers, one-client lease, generation fencing, revoke semantics, and bounded latest-frame policy.
- **HTTP streaming + bounded input requests** — a simpler correctness/deployability fallback or diagnostic path if it proves useful; not the performance target.
- **WebTransport / HTTP/3** — a future low-latency browser candidate when the deployment platform exposes a suitable end-to-end path. It must remain an optional transport rather than changing core semantics.

Transport-specific mechanisms such as ICE/SDP/RTP/DataChannel, WebSocket framing/backpressure, or future WebTransport streams/datagrams must stay inside the transport implementation. Consumers should continue to depend on locator/start/reconnect/revoke-style lifecycle semantics, not the underlying network protocol.

For the WebSocket experiment, the key acceptance question is whether an HTTPS-only managed runtime can provide usable physical-mobile Human takeover without unbounded TCP/video backlog. A slow client must preserve bounded memory and latest-frame/drop semantics, and reconnect must rotate generation rather than revive stale authority. Track this work in Issue #40.

The exact version number for each item will be chosen when the work is concrete. The project may use `0.5`, `0.6`, `0.10`, and later pre-1.0 releases as needed.

## v1.0 — stable contract milestone

`v1.0` means the security and compatibility contract is mature enough for consumers to rely on without routine breaking changes. It is not tied to a particular calendar date, number of pre-1.0 releases, or npm publication.

Minimum exit criteria:

- core authority/epoch/ownership/resume/checkpoint semantics are documented as stable;
- compatibility and migration policy is documented and exercised;
- at least three real adapters have validated the generic boundary, with more than one application domain represented;
- Target Surface boundaries have been validated with real consumers rather than only synthetic examples;
- MCP-standard alignment has been re-audited so the library is not duplicating protocol features unnecessarily;
- browser takeover remains optional and transport-only;
- Human completion remains distinct from consequential-action approval;
- automatic replay remains explicitly constrained by consumer policy;
- CI, cross-platform portability gates, dependency review, CodeQL, secret scanning, and security reporting remain operational;
- no unresolved known security issue invalidates a documented invariant.

## npm publication gate

npm publication is a delivery decision, not a maturity signal. A source release may exist without an npm package, as `v0.1.0` does.

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
