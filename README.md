# mcp-execution-handoff

[日本語](README.ja.md)

A small, security-oriented TypeScript runtime for pausing an MCP-driven execution flow when a human must take temporary control, then resuming only after explicit verification and policy checks.

**Status:** pre-release extraction candidate. The repository is intentionally `private: true` at the npm-package level. No npm package or release has been published.

## Why this exists

The runtime originated in `git-ksk/maps-browser-mcp`. It is being extracted only after a second real adapter, `git-ksk/japan-cinema-browser-mcp`, can exercise the same contract without importing Maps-specific concepts.

The public contract is deliberately narrow:

- exclusive Agent / Human execution authority,
- monotonically increasing resource epochs,
- explicit resume policy,
- generic execution-adapter contract,
- signed durable control-plane checkpoints,
- MCP MRTR `input_required` request-state binding,
- principal + invocation + canonical-arguments ownership binding,
- optional browser takeover transport with short-lived capabilities and a one-client lease.

It does **not** provide a CAPTCHA solver, challenge bypass, credential relay, payment automation, generic browser agent, DOM/network export, or automatic approval of consequential actions.

## Packages / modules

```text
src/core/
  lifecycle.ts     Agent/Human authority, resource epoch, resume policy
  adapter.ts       minimal execution adapter contract
  invocation.ts    canonical invocation digest
  owner.ts         principal + invocation ownership binding
  checkpoint.ts    signed durable control-plane metadata only
  runtime.ts       checkpoint/recovery coordinator
  audit.ts         bounded metadata audit contract

src/mcp/
  mrtr.ts          requestState helpers + input_required schema/prompt

src/browser-takeover/
  session.ts       locator, short-lived capability, one-client lease
  broker.ts        optional bounded remote browser-control surface
```

## Security invariants

- Agent and Human never own execution authority at the same time.
- A Human handoff advances the resource epoch; stale state must fail closed.
- Handoff ownership is bound to the authenticated logical principal and exact invocation arguments.
- Missing ownership cannot be rebound after the initial `awaiting_human` state.
- Durable checkpoints contain bounded control-plane metadata only. Raw action arguments, browser text, credentials, cookies, CAPTCHA/OTP/MFA answers, payment data, and approval receipts are excluded.
- Restart recovery is always `reissue_and_revalidate`; it never restores stale execution authority or silently replays an action.
- Browser takeover URLs are locators only; capabilities are returned only after authenticated same-origin bootstrap.
- A capability is scoped to session + intervention + resource epoch + principal + remote-client binding + expiry.
- One remote client owns a takeover lease. Reload/new-tab/new-device flows with a new in-memory binding cannot implicitly reclaim it.
- Takeover responses use `no-store`, `no-referrer`, restrictive CSP with a nonce-bound client asset, and bounded input endpoints.
- Completing Human takeover **does not approve another action**. Consequential actions require a separate explicit approval mechanism owned by the consumer.
- Stateful/consequential actions must not be automatically replayed after handoff unless the consumer has independently established that replay is safe.

See [Architecture](docs/architecture.md) and [Security Policy](SECURITY.md).

## Resume policy

The core records one of:

- `replay_safe` — the consumer may decide to re-run the same validated operation after verification.
- `revalidate` — resume requires current semantic/resource validation before any execution.
- `confirm_before_execute` — a separate explicit approval flow is required before a consequential action.
- `never_replay` — the interrupted action must not be automatically re-run.

The MCP bridge also records a call-site strategy:

- `retry_original`
- `require_fresh_semantic_action`

A consumer must apply the stricter effective result. In particular, `require_fresh_semantic_action` and `never_replay` never become automatic replay simply because a Human marked the manual step complete.

## Browser takeover

`browser-takeover` is optional. The broker deliberately knows only `{ id, epoch }` for an intervention plus a consumer-supplied principal binding and browser adapter. It does not know Maps, Cinema, Chrome URLs, CAPTCHA classifications, or provider policies.

Consumers remain responsible for:

- deciding which surfaces are eligible for Human takeover,
- restricting native browser/device operations,
- postcondition verification,
- authentication and logical-principal derivation,
- preventing sensitive data from crossing into MCP/tool arguments/logs.

## Development

Requires Node.js 20 or newer.

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm audit --audit-level=moderate
```

The test suite is deterministic and must not intentionally trigger a live CAPTCHA/challenge.

## Upstream readiness

The extraction is considered ready for a first version only after both real consumers are green and the contract contains no Maps- or Cinema-specific concepts. Until then, there is no `v0.1.0` release and no npm publication.

## License

MIT
