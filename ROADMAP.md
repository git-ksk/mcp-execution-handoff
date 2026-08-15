# Roadmap

[日本語](ROADMAP.ja.md)

This roadmap describes product and contract direction, not a release schedule. Version numbers are milestones with exit criteria; the project may insert additional pre-1.0 versions when needed. There is no requirement that `0.9` be followed by `1.0`.

## Current baseline: v0.1.0

`v0.1.0` is the first source release. It established the repository as the upstream source of truth after validation with two real adapters:

- `git-ksk/maps-browser-mcp`
- `git-ksk/japan-cinema-browser-mcp`

The npm package remains `private: true`. npm publication is not required for the roadmap and is governed by a separate publication gate below.

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
- migration notes for any unavoidable pre-1.0 breaking fix.

Exit condition: each patch must preserve the documented security invariants and remain green in both real consumers.

## v0.2 — third-adapter contract validation

Candidate scope:

- validate the contract with a third real adapter, preferably from a materially different workflow/domain;
- record adapter friction before adding new public APIs;
- formalize compatibility fixtures for authority, epoch, ownership, resume policy, and request-state binding;
- clarify which extension points are stable enough to expose without leaking consumer semantics.

Exit criteria:

- three real adapters pass deterministic consumer tests;
- the third adapter demonstrates reuse without product-specific concepts entering generic `src/`;
- no security invariant is weakened to accommodate an adapter;
- any new public surface has at least two independent real use cases.

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
- further separate browser-takeover transport mechanics from core lifecycle semantics;
- add transport conformance tests for capability, lease, origin, expiry, and revocation behavior.

The exact version number for each item will be chosen when the work is concrete. The project may use `0.5`, `0.6`, `0.10`, and later pre-1.0 releases as needed.

## v1.0 — stable contract milestone

`v1.0` means the security and compatibility contract is mature enough for consumers to rely on without routine breaking changes. It is not tied to a particular calendar date, number of pre-1.0 releases, or npm publication.

Minimum exit criteria:

- core authority/epoch/ownership/resume/checkpoint semantics are documented as stable;
- compatibility and migration policy is documented and exercised;
- at least three real adapters have validated the generic boundary, with more than one application domain represented;
- MCP-standard alignment has been re-audited so the library is not duplicating protocol features unnecessarily;
- browser takeover remains optional and transport-only;
- Human completion remains distinct from consequential-action approval;
- automatic replay remains explicitly constrained by consumer policy;
- CI, dependency review, CodeQL, secret scanning, and security reporting remain operational;
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
- automatic approval or replay of consequential actions;
- provider-specific policies in generic core.

See [Positioning](docs/positioning.md), [Architecture](docs/architecture.md), and [Security Policy](SECURITY.md).
