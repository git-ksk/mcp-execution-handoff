# Changelog

All notable source releases are recorded here. npm publication, if introduced later, is a separate delivery channel and will be called out explicitly.

## [Unreleased]

- Added canonical Human Interaction Policy API names (`HumanInteractionPolicyKind`, `HUMAN_INTERACTION_POLICY_KINDS`, `selectHumanInteractionPolicy`) while retaining the historical Human-surface names as source/runtime-compatible aliases; documented Browser/OS Window/Terminal as Target Surface labels without freezing a public `TargetSurfaceKind`.
- Document a repeatable GitHub source-release process, explicitly separate npm publication, and establish the v0.2.0 / v0.2.x / v0.4+ milestone split so optional hardening does not become an accidental source-release blocker.
- Retire historical umbrella issues #11 and #13 as superseded: bounded Window/WebRTC/WSS acceptance now carries the supported path, while secure-system-UI input, media quality, provider-neutral relay, and hosted topology remain in narrower issues; whole-desktop and mandatory custom Native-client scope are not restored by default.
- Clarify the generic architecture/positioning boundary (#5/#42/#46): separate MCP principal from target-service identity, define the four Handoff semantic domains and Takeover Session layer, make Target Surface admission evidence-based/documentation-first, and compare responsibility boundaries without claiming remote-desktop/browser/HITL superiority.
- Stabilize Safari WebRTC reconnect lifecycle (#104): generation release is single-flight, overlapping background/foreground/failure triggers coalesce to one reconnect, active-lease conflicts are bounded/observable, Human input is never replayed across generations, and a physical same-LAN iPhone run recovered through three background/foreground cycles without a 409 loop or black-frame stall.
- Make Terminal Handoff mobile state explicit (#91): the Human surface now distinguishes connecting, connected/waiting for Human authority, Human authority active, Done/verifying, and fail-closed unavailable states without weakening backend authority semantics.
- Make Browser Handoff `Done` immediate and one-shot (#84): local Human controls fence before completion delivery, duplicate gestures are no-ops, and completion failure does not restore authority.
- Complete first-class bounded Window Handoff acceptance (#85): CUMG consumes `WindowHandoffAdapter`, and merged-code physical iPhone acceptance passed both public Tunnel/TURN relay and same-LAN direct paths with stale-locator rejection.
- Complete the HTTPS/WSS managed-runtime evaluation (#40): physical iPhone Safari WSS control, bounded latest-frame/drop behavior, and Cloud Run application reachability were demonstrated without adding a silent WebRTC-to-WebSocket downgrade.
- Add a client-only mobile precision Aim mode for dense Browser Handoff targets: enabling Aim jumps to bounded 4x view, one-finger/two-finger adjustment stays local, a fixed center crosshair is mapped back through the rendered video transform, and only the explicit `Tap` control emits one ordinary policy-gated remote tap. Aim resets on reconnect/orientation/teardown and does not widen server-side input authority.
- Add bounded mobile precision controls to the WebRTC Browser Handoff surface: local 1×–4× zoom, two-finger pinch/pan, and local one-finger pan while zoomed. View gestures never dispatch target tap/scroll input, transformed taps still map through the exact captured window, and reconnect/orientation resets the local transform without mutating browser/page zoom or target-window identity.
- Add bounded relay credential failure diagnostics (`generation_expired`, provider auth/rate-limit/rejection/unavailable, invalid response, unknown) so Handoff can explain `relay unavailable` without logging provider payloads, TURN credentials, network identifiers, or consumer identity; direct fallback semantics remain fail-closed and unchanged.
- Add a first-class `BrowserHandoffAdapter` that composes the canonical WebRTC browser handoff path for standalone MCP consumers, requires an exact process/window target plus explicit bounded input policy, keeps browser/profile/authentication lifecycle consumer-owned, exposes bounded diagnostics, and prevents accidental downgrade to the legacy HTTP frame transport.
- Harden Browser Handoff completion and target authority: WebRTC `Done` now uses a principal/intervention/epoch/expiry-bound completion-only capability that survives media disconnect/reload without reviving stale input generations, consumer completion callbacks run only after transport fencing, and Linux honors/revalidates explicit PID/window ownership before every Human mutation.
- Add an explicit native takeover claim/reconnect protocol: reconnect requires the same authenticated principal, an idle prior lease, and a generation-bound reconnect handle; successful recovery rotates client generation, capability, and reconnect handle so stale clients fail closed.
- Allow browser-takeover adapters to return bounded PNG or JPEG frames so native/OS-level Human transports do not need lossy consumer-side conversion; existing adapters default to JPEG for compatibility.
- Separate browser-takeover capability transport from outer HTTP authentication: new takeover clients send the short-lived capability in `X-MCP-Takeover-Capability`, allowing an authenticated reverse proxy/private hop to keep using `Authorization: Bearer ...`; legacy `Authorization: Takeover ...` remains accepted for compatibility.
- Added a credential-safe external Human surface provider contract and coordinator, separate from automation-adjacent browser takeover.
- Added principal + intervention + resource-epoch binding, one-active-session enforcement, bounded provider metadata retention, and mandatory external-session revocation before automation restoration.
- Added consumer policy selection for identity-sensitive intervention reasons without making provider-specific policy part of the generic core.
- Documented the normal-browser credential lifecycle and the rule that automation/browser stealth must not be used to bypass provider login restrictions.

## [0.1.0] - 2026-08-15

First source release.

- Extracted the generic Execution Handoff runtime from `maps-browser-mcp`.
- Validated the generic boundary with Maps and Japan Cinema as two real adapters.
- Established core authority/epoch/resume, principal/invocation ownership binding, signed bounded checkpoints, MCP MRTR request-state binding, and optional browser takeover transport.
- Preserved one-client lease, short-lived capability, stale-epoch rejection, no implicit reload/tab/device transfer, and Human-completion-is-not-approval invariants.
- Kept CAPTCHA solving/bypass, credential relay, payment automation, arbitrary browser automation, and consequential-action automatic replay out of scope.
- Released as GitHub/source only; npm package remains `private: true`.
