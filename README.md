# mcp-execution-handoff

[日本語](README.ja.md)

A small, security-oriented TypeScript runtime for pausing an MCP-driven execution flow when a human must take temporary control, then resuming only after explicit verification and policy checks.

**Status:** validated reusable upstream. `v0.1.0` is the first source release, validated by Maps and Japan Cinema as two real adapters. The npm-package flag remains `private: true`; this project is not published to npm.

## Why this exists

The runtime originated in `git-ksk/maps-browser-mcp`. It was extracted after a second real adapter, `git-ksk/japan-cinema-browser-mcp`, demonstrated the same contract without importing Maps-specific concepts.

The public contract is deliberately narrow:

- exclusive Agent / Human execution authority,
- monotonically increasing resource epochs,
- explicit resume policy,
- generic execution-adapter contract,
- signed durable control-plane checkpoints,
- MCP MRTR `input_required` request-state binding,
- principal + invocation + canonical-arguments ownership binding,
- optional browser takeover transport with short-lived capabilities and a one-client lease,
- credential-safe external Human surface coordination for providers that require a normal non-automated browser.

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
  human-surface.ts credential-safe external Human provider contract

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
- One remote client generation owns a takeover lease. Reload/new-tab/new-device flows with a new binding cannot implicitly reclaim it. Native reconnect may rotate only after the prior lease is idle. WebRTC browser suspend/disconnect explicitly releases the current generation before reconnect. Both paths require the same authenticated principal plus the generation-bound reconnect handle, rotate to a fresh client generation, and fence old capabilities/handles immediately.
- Takeover responses use `no-store`, `no-referrer`, restrictive CSP with a nonce-bound client asset, and bounded input endpoints.
- Credential-safe external Human control may start only while Human authority is already exclusive; the external session must be revoked before automation authority is restored.
- External Human providers are narrowed to bounded control-plane fields (`providerKind`, intervention/epoch/principal binding, session id, operator locator, optional expiry). Arbitrary provider metadata is discarded.
- Completing Human takeover **does not approve another action**. Consequential actions require a separate explicit approval mechanism owned by the consumer.
- Stateful/consequential actions must not be automatically replayed after handoff unless the consumer has independently established that replay is safe.

See [Architecture](docs/architecture.md), [Positioning](docs/positioning.md), [Roadmap](ROADMAP.md), [Security Policy](SECURITY.md), and [Changelog](CHANGELOG.md).

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

## Credential-safe external Human surface

Some identity providers reject or forbid credential entry in software-controlled or embedded browser contexts. In that case, consumers must not make an automation-adjacent transport more evasive. `CredentialSafeHumanSurfaceRuntime` coordinates a pluggable Human-only surface, but the concrete provider determines the browser trust boundary.

For providers that require a normal non-automated browser, the consumer must suspend automation completely, launch the same dedicated non-default profile without CDP/remote-debugging attachment, and refuse to restore automation until the external session is revoked and the profile lock is released.

For a hosted browser execution plane where the target service permits browser automation infrastructure, `HostedBrowserTakeoverProvider` can instead wrap the existing bounded `TakeoverBroker` as an `ExternalHumanSurfaceProvider`. It does **not** make CDP invisible or equivalent to a normal browser: the consumer must fence Agent authority, expose only its narrow Human frame/input adapter, and validate the real target-service sign-in flow before relying on this mode. Human-entered credential text may transit the consumer's in-memory Human transport/input adapter, but it must never enter MCP/model results, durable state, diagnostics, or logs.

The normal-browser lifecycle is:

```text
automation profile + CDP
  -> identity-sensitive intervention
  -> Human authority becomes exclusive
  -> stop automation browser completely
  -> open same dedicated profile in normal browser (no CDP)
  -> Human authenticates through an external provider
  -> revoke/close external provider session
  -> close normal browser and verify profile lock release
  -> relaunch automation browser
  -> fresh readiness / semantic validation
  -> never replay stale pre-auth state
```

A hosted browser consumer may keep the browser process alive only if Agent CDP authority is fully detached/fenced while Human authority owns the intervention. After `Done`, it revokes the broker generation, detaches Human CDP authority, establishes a fresh Agent connection, and performs fresh readiness/semantic validation. Browser/profile persistence remains a consumer/deployment responsibility and is not continuity state for Handoff.

`selectHumanSurface()` is a small policy helper for consumers to route configured reasons such as sign-in/consent to `credential_safe_external` while leaving other interventions on `automation_adjacent`. The core does not decide which reasons are identity-sensitive.

## Browser takeover

`browser-takeover` is optional. The broker deliberately knows only `{ id, epoch }` for an intervention plus a consumer-supplied principal binding and browser adapter. It does not know Maps, Cinema, Chrome URLs, CAPTCHA classifications, or provider policies.

For native operator clients, the broker also exposes an explicit claim/reconnect path. Reconnect is **not** implicit lease transfer: the previous client must be idle, the authenticated principal must match, and a short-lived generation-bound reconnect handle must match. Successful recovery rotates the client generation and invalidates the previous capability and reconnect handle. The reconnect handle is continuity metadata only; it is not a target-service credential and must never contain browser/session content.

The optional WebRTC browser transport keeps signaling, H.264/RTP, DataChannel input, Safari lifecycle handling, and reconnect fencing inside Handoff. Its initial Safari acceptance profile is 1280×720 / 30 fps Constrained Baseline H.264. A WebRTC locator renders the selected host capture surface directly into a `playsinline` video surface; tap/swipe operate directly on that surface and a hidden browser input bridge uses the iOS keyboard for text/Backspace. On touch-capable Safari, Touch Events are the authoritative swipe path and touch Pointer Events are ignored to prevent duplicate input. Consumers may bind the runtime to a target process; that mode requires exactly one eligible on-screen window, crops ScreenCaptureKit to that window, and maps input to the same bounds instead of exposing the desktop. It never falls back to the legacy HTTP frame/input controls. Backgrounding, peer disconnect, or explicit suspend tears down the peer and releases that exact client generation; foreground recovery requires a fresh generation before a new peer is created. `Done` revokes the broker generation before transport teardown and is not authentication success.

Physical iPhone Safari acceptance has passed on both same-LAN direct WebRTC and cellular/4G TURN relay. The accepted path covered window-scoped video, target-window re-activation when another Mac app was frontmost, tap/focus, text, Backspace, scrolling, and Done/revoke with stale-locator rejection. Mobile viewport/keyboard composition and explicit reload/reconnect UX remain follow-up work rather than prerequisites for the accepted transport baseline.

Direct-first ICE is explicit on both peers. The Safari/browser peer stays host-only (`iceServers: []`) so an unavailable STUN service cannot add a non-trickle browser gathering stall. The Node/werift peer uses `stun:stun.cloudflare.com:3478` explicitly, replacing werift's implicit default STUN with a reviewed Cloudflare network-metadata trust boundary. This STUN request may expose the server-side public network address to Cloudflare, but Handoff sends no principal/intervention/client identifier with it. Optional Cloudflare Realtime TURN uses short-lived, peer-specific credentials and remains fallback-only (`iceTransportPolicy: all`), never relay-only. Raw candidate strings, IP addresses, SDP, credentials, framebuffer bytes, and Human input are not diagnostics or durable control-plane artifacts; diagnostics are limited to candidate type/count, peer state, and bounded timing.

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

## Upstream validation result

The two-real-adapter extraction gate is now satisfied:

- `git-ksk/maps-browser-mcp` is green as the first real consumer.
- `git-ksk/japan-cinema-browser-mcp` is green as the second real consumer.
- the generic `src/` contract contains no Maps-, Google-, Cinema-, provider-, Chrome-, or CDP-specific concept.
- authority, epoch, ownership, checkpoint, takeover-lease, capability, CSP, and replay invariants remain covered by deterministic tests.
- both consumers pin an immutable commit from this repository and pass clean-install CI.

This repository is the upstream source of truth. `v0.1.0` is a **source release only**: it establishes the first versioned repository baseline after validation with two real adapters. npm publication is a separate decision and has not been performed; `private: true` remains in effect.

## License

MIT
