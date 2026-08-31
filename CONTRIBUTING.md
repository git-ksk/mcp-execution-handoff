# Contributing

[日本語](CONTRIBUTING.ja.md)

Changes should keep the public contract smaller than the consumer-specific policy surface.

Before opening a PR:

1. run `npm ci --ignore-scripts`, `npm run check`, `npm run build`, and `npm audit --audit-level=moderate`;
2. add deterministic negative tests for security-boundary changes;
3. do not intentionally trigger a live CAPTCHA/challenge for testing;
4. do not add Maps-, Cinema-, provider-, Chrome/CDP-, or product-specific semantics to `core`;
5. keep Browser Handoff optional, with Browser Target Surface and Transport concerns outside the generic core;
6. do not weaken principal binding, epoch fencing, one-client leases, capability expiry/revocation, CSP, or durable checkpoint restrictions;
7. never equate Human completion with approval for another action;
8. never add secrets, tokens, private endpoints, credentials, OTP/MFA values, payment data, or challenge answers to fixtures/logs/docs.

English documentation is canonical. Keep the major Japanese documents synchronized when security or architecture semantics change.

Before removing local branches or linked worktrees, follow [Repository worktree and branch hygiene](docs/repository-hygiene.md) and run `npm run audit:worktrees`. A `[gone]` upstream or merged-looking branch name is never sufficient deletion proof.

Before proposing a new generic public API or widening project scope, review [Positioning](docs/positioning.md) and [Roadmap](ROADMAP.md). A proposal that duplicates an MCP-standard mechanism or exists for only one consumer should remain consumer-local until there is stronger evidence for a generic contract.
