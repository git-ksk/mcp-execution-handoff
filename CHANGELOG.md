# Changelog

All notable source releases are recorded here. npm publication, if introduced later, is a separate delivery channel and will be called out explicitly.

## [0.1.0] - 2026-08-15

First source release.

- Extracted the generic Execution Handoff runtime from `maps-browser-mcp`.
- Validated the generic boundary with Maps and Japan Cinema as two real adapters.
- Established core authority/epoch/resume, principal/invocation ownership binding, signed bounded checkpoints, MCP MRTR request-state binding, and optional browser takeover transport.
- Preserved one-client lease, short-lived capability, stale-epoch rejection, no implicit reload/tab/device transfer, and Human-completion-is-not-approval invariants.
- Kept CAPTCHA solving/bypass, credential relay, payment automation, arbitrary browser automation, and consequential-action automatic replay out of scope.
- Released as GitHub/source only; npm package remains `private: true`.
