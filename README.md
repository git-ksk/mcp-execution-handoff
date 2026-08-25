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

For a hosted browser execution plane where the target service explicitly permits browser automation infrastructure, `HostedBrowserTakeoverProvider` may still wrap the bounded `TakeoverBroker` for **automation-compatible** Human surfaces. It does **not** make CDP invisible or equivalent to a normal browser and must not be substituted for the normal-browser boundary on credential surfaces that reject automation-managed browsers. Human-entered text may transit only the in-memory Human transport/input adapter and must never enter MCP/model results, durable state, diagnostics, logs, or process command lines.

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

For credential-safe browser handoff, the lifecycle above is cross-platform: the Human uses a normal browser process, not the automation-managed browser. macOS and Linux differ only in the OS/window capture-input helper. The Linux helper resolves exactly one target-PID X11 window, captures that window through a bounded CPU H.264 pipeline, and delivers tap/scroll/key/text at the OS/window layer while reusing the same WebRTC generation/TURN/revoke machinery. Human text is delivered through private stdin/clipboard IPC and the transient clipboard is cleared immediately. Browser/profile persistence remains a consumer/deployment responsibility and is not continuity state for Handoff.

`selectHumanSurface()` is a small policy helper for consumers to route configured reasons such as sign-in/consent to `credential_safe_external` while leaving other interventions on `automation_adjacent`. The core does not decide which reasons are identity-sensitive.

## Browser takeover

For standalone browser MCP consumers, `BrowserHandoffAdapter` is the canonical high-level WebRTC composition. A consumer supplies the intervention/principal binding, an exact target process/window, an explicit bounded Human input policy, and its own browser/profile lifecycle; Handoff constructs the WebRTC runtime and broker internally, exposes only `start()` / `revoke()` / HTTP routing plus bounded diagnostics, and never silently downgrades that canonical path to the legacy HTTP frame/input transport. Locator issuance is control-plane setup only: WebRTC readiness still passes the host-window and first-media-frame gates before the media/input path becomes usable. Browser-profile persistence, target-service authentication, and post-Human checkpoint/verification remain consumer responsibilities.

```ts
import { BrowserHandoffAdapter } from "mcp-execution-handoff/browser-takeover";

const browserHandoff = new BrowserHandoffAdapter({
  takeover: { enabled: true, publicBaseUrl, ttlMs: 60_000 },
  runtime: { hostExecutable, displayName }, // displayName is used by Linux/X11 hosts
  onComplete: async ({ interventionId, epoch }) => {
    // Human authority is already fenced here. Start consumer-owned fresh verification only.
    await beginFreshVerification(interventionId, epoch);
  }
});

const locator = browserHandoff.start({
  intervention: { id: interventionId, epoch },
  principalBinding,
  target: { processId, ...(windowId ? { windowId } : {}) },
  inputPolicy: { tap: true, scroll: true, text: false, key: false }
});
```

Route authenticated `/takeover/*` HTTP requests to `browserHandoff.handle(...)`. `inputPolicy` is bound to the takeover session and enforced server-side before OS input; the browser UI also suppresses disallowed keyboard/input controls as defense in depth. The optional `onComplete` callback runs only after Human transport authority is fenced and is a signal to begin consumer-owned fresh verification, never evidence that authentication or a consequential action succeeded. ICE/STUN/TURN provider selection and relay credentials are not part of `start()`; they remain Handoff deployment/runtime concerns.

`TakeoverBroker` remains the lower-level transport/session primitive for consumers that deliberately need the HTTP frame mode, Native composition, or custom transport assembly. The broker deliberately knows only `{ id, epoch }` for an intervention plus a consumer-supplied principal binding and browser adapter. It does not know Maps, Cinema, Chrome URLs, CAPTCHA classifications, or provider policies.

For native operator clients, the broker also exposes an explicit claim/reconnect path. Reconnect is **not** implicit lease transfer: the previous client must be idle, the authenticated principal must match, and a short-lived generation-bound reconnect handle must match. Successful recovery rotates the client generation and invalidates the previous capability and reconnect handle. The reconnect handle is continuity metadata only; it is not a target-service credential and must never contain browser/session content.

The optional WebRTC browser transport keeps signaling, H.264/RTP, DataChannel input, Safari lifecycle handling, and reconnect fencing inside Handoff. The macOS host uses ScreenCaptureKit/CoreGraphics; the Linux host uses an isolated X11 display, exact target-window capture, bounded CPU H.264, and OS/window input. Both hosts honor an explicit process/window binding; Linux also revalidates that exact X11 window's PID ownership and bounded geometry immediately before each Human mutation, fencing the transport if the target disappears or ownership changes. Its Safari transport profile is bounded to at most 1280×720; macOS acceptance currently runs at 30 fps while the Linux CPU host defaults to 15 fps. A WebRTC locator renders the selected host capture surface directly into a `playsinline` video surface. At 1×, tap/swipe operate directly on that surface. For precision targets on small mobile screens, Handoff also owns a bounded local 1×–4× view transform: the Human can use the zoom control or two-finger pinch/pan, and while zoomed a one-finger drag pans only the local view. Those view gestures never dispatch target tap/scroll input; a stationary tap is mapped back through the transformed video bounds to the same exact captured window. The transform never changes browser/page zoom or target-window identity and resets on reconnect/orientation change. A hidden browser input bridge uses the iOS keyboard for text/Backspace only when allowed by the session input policy. It never falls back to the legacy HTTP frame/input controls. Backgrounding, peer disconnect, or explicit suspend tears down the peer and releases that exact client generation; foreground media recovery requires a fresh generation before a new peer is created. A separate principal/intervention/epoch/expiry-bound completion-only capability lets the same authorized locator be reloaded and `Done` be delivered without reviving stale media/input authority. `Done` fences transport before invoking the consumer completion callback and is not authentication success or approval.

Physical iPhone Safari acceptance has passed on both same-LAN direct WebRTC and cellular/4G TURN relay. The accepted path covered window-scoped video, target-window re-activation when another Mac app was frontmost, tap/focus, text, Backspace, scrolling, and Done/revoke with stale-locator rejection. Completion-only reload recovery is covered deterministically. Bounded client-side precision zoom/pan is implemented and covered by transform/gesture regressions; physical portrait precision acceptance remains the next mobile UX gate, while target-window resize and broader keyboard composition remain follow-up work rather than prerequisites for the accepted transport baseline.

Direct-first ICE is explicit on both peers. With no relay provider, the Safari/browser peer stays host-only (`iceServers: []`) and the Node/werift peer uses one explicit STUN server instead of Werift's implicit third-party default. Optional TURN remains fallback-only (`iceTransportPolicy: all`), never relay-only. Handoff currently supports Cloudflare Realtime TURN and self-hosted coturn TURN REST credentials. Both issue independent short-lived browser/server credentials only after generation binding and never encode principal/intervention/client identity into TURN usernames or metadata. The coturn adapter uses `timestamp:random` usernames and `base64(HMAC-SHA1(shared-secret, username))`, matching coturn `use-auth-secret`; because coturn has no per-credential revoke API, those relay credentials expire at the bound Handoff generation deadline while Handoff authority itself is revoked immediately. Raw candidate strings, IP addresses, SDP, credentials, framebuffer bytes, and Human input are not diagnostics or durable control-plane artifacts; diagnostics are limited to candidate type/count, peer state, and bounded timing.

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
