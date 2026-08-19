# Changelog

All notable source releases are recorded here. npm publication, if introduced later, is a separate delivery channel and will be called out explicitly.

## [Unreleased]

- Add low-latency push-frame revocation fencing: consumer-owned same-session Thin Takeover runtimes may keep a separate Human capture/input attachment while Agent authority is fenced, and revoking an intervention now aborts all active broker frame streams before automation restoration. Capture/encoding/WebRTC remain consumer-owned rather than generic-core dependencies.
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
