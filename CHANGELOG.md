# Changelog

All notable source releases are recorded here. npm publication, if introduced later, is a separate delivery channel and will be called out explicitly.

## [Unreleased]

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
