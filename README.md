# mcp-execution-handoff

[日本語](README.ja.md)

A small, security-oriented TypeScript runtime for pausing an MCP-driven execution flow when a human must take temporary control, then resuming only after explicit verification and policy checks.

**Status:** validated reusable upstream. `v0.2.0` is the current GitHub/source release baseline; `v0.1.0` was the first source release. The npm-package flag remains `private: true`; this project is not published to npm.

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
- optional Browser Handoff over bounded Human-control transports with short-lived capabilities and a one-client lease,
- credential-safe external Human surface coordination for providers that require a normal non-automated browser.

It does **not** provide a CAPTCHA solver, challenge bypass, credential relay, payment automation, generic browser agent, remote-desktop platform, DOM/network export, or automatic approval of consequential actions. Browser/Window Human-control transports are optional bounded components, not the definition of the product; see [Positioning](docs/positioning.md).

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
- The MCP principal and the identity active inside a target service/browser are separate security domains. Human completion never attests a target-service account; any such identity check is consumer-specific and must be freshly verified without credential/token passthrough.
- Missing ownership cannot be rebound after the initial `awaiting_human` state.
- Durable checkpoints contain bounded control-plane metadata only. Raw action arguments, browser text, credentials, cookies, CAPTCHA/OTP/MFA answers, payment data, and approval receipts are excluded.
- Restart recovery is always `reissue_and_revalidate`; it never restores stale execution authority or silently replays an action.
- Browser Handoff locators (the compatibility takeover URL API) contain locators only; capabilities are returned only after authenticated same-origin bootstrap.
- A capability is scoped to session + intervention + resource epoch + principal + remote-client binding + expiry.
- One remote client generation owns a takeover lease. Reload/new-tab/new-device flows with a new binding cannot implicitly reclaim it. Native reconnect may rotate only after the prior lease is idle. WebRTC browser suspend/disconnect explicitly releases the current generation before reconnect. Both paths require the same authenticated principal plus the generation-bound reconnect handle, rotate to a fresh client generation, and fence old capabilities/handles immediately.
- Takeover responses use `no-store`, `no-referrer`, restrictive CSP with a nonce-bound client asset, and bounded input endpoints.
- Credential-safe external Human control may start only while Human authority is already exclusive; the external session must be revoked before automation authority is restored.
- External Human providers are narrowed to bounded control-plane fields (`providerKind`, intervention/epoch/principal binding, session id, operator locator, optional expiry). Arbitrary provider metadata is discarded.
- Completing Human takeover **does not approve another action**. Consequential actions require a separate explicit approval mechanism owned by the consumer.
- Stateful/consequential actions must not be automatically replayed after handoff unless the consumer has independently established that replay is safe.

See [Architecture](docs/architecture.md), [Recovery & observability](docs/recovery-observability.md), [Positioning](docs/positioning.md), [Roadmap](ROADMAP.md), [Release process](RELEASING.md), [Security Policy](SECURITY.md), and [Changelog](CHANGELOG.md).

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

For a hosted browser execution plane where the target service explicitly permits browser automation infrastructure, `HostedBrowserTakeoverProvider` may still wrap the bounded `TakeoverBroker` for **automation-compatible** Human-control boundaries. It does **not** make CDP invisible or equivalent to a normal browser and must not be substituted for the normal-browser boundary on credential surfaces that reject automation-managed browsers. Human-entered text may transit only the in-memory Human transport/input adapter and must never enter MCP/model results, durable state, diagnostics, logs, or process command lines.

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

For credential-safe browser handoff, the lifecycle above is cross-platform: the Human uses a normal browser process, not the automation-managed browser. macOS and Linux differ only in the OS/window capture-input helper. The Linux host resolves exactly one target-PID X11 window and captures that window through a bounded CPU H.264 pipeline. Window discovery, PID ownership, geometry, activation, and focus remain Node-owned fail-closed policy. Primary pointer motion/down/up is delegated to a small standalone Xlib/libXtst helper that keeps one X11 connection for the Handoff host lifetime and acknowledges each XTEST mutation only after `XSync`; scroll/key/text remain on the existing bounded OS/window path. Editable-region/focus parity uses a separate read-only AT-SPI helper: it reads only process ancestry, accessibility state/role, and component extents, caps traversal/regions, requires the AT-SPI top-level geometry to match the exact X11 target within a small bounded tolerance, and never requests accessible names, descriptions, text, values, credentials, or DOM/CDP data. Cloud/headless-like Chromium deployments must enable the native accessibility bridge when launching the target process (for example `ACCESSIBILITY_ENABLED=1` plus the bounded `--force-renderer-accessibility=form-controls` bundle); if the bridge/tree is unavailable or ambiguous, Handoff emits no editable regions and reports focus as non-editable rather than widening inspection. The same WebRTC generation/TURN/revoke machinery is reused. Browser/profile persistence remains a consumer/deployment responsibility and is not continuity state for Handoff.

`selectHumanInteractionPolicy()` is the canonical policy helper for consumers to route configured reasons such as sign-in/consent to `credential_safe_external` while leaving other interventions on `automation_adjacent`. `selectHumanSurface()` remains a source/runtime-compatible alias for existing consumers. The core does not decide which reasons are identity-sensitive.

## First-class surface components

The consumer-facing component family is now explicit. These components share Handoff semantics where appropriate but do not force different target mechanics behind one generic runner:

| Component | Boundary | Current evidence |
| --- | --- | --- |
| `BrowserHandoffAdapter` | exact browser/window + bounded Human input over WebRTC | Complete in #70; established browser consumers and physical mobile transport acceptance remain the baseline. |
| `WindowHandoffAdapter` | exact bounded OS application window; no desktop fallback | Complete in #85 and consumed by CUMG. Merged-code physical iPhone acceptance passed on both public Tunnel/TURN relay and same-LAN direct paths, including stale-locator rejection. |
| `TerminalHandoffAdapter` | one consumer-owned bounded PTY/session + DataChannel WebRTC | Complete in #86. CUMG migrated off direct experimental composition; merged-code real-PTY E2E and physical iPhone Human acceptance passed. #91 made mobile connection, Human-authority, and verifying state explicit and fail-closed. |

These adapters do not freeze a generic public Target Surface enum. The proven surface shapes are Browser, bounded OS Window, and bounded Terminal/PTY; #46 documents the semantic-domain/Target Surface admission baseline, and the v0.2 terminology convergence keeps those labels documentation-first while adding only compatibility-safe Human Interaction Policy names. A component's Human `Done` remains transport/lifecycle completion evidence only, never semantic success or consequential-action approval.

## Browser Handoff (compatibility module: `browser-takeover`)

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

`BrowserHandoffAdapter` and `WindowHandoffAdapter` share the same internal bounded-window WebRTC/session core. Browser remains a browser-policy facade; the shared core owns only exact target binding, WebRTC/session/reconnect/revoke and bounded diagnostics.

## Window handoff

For non-browser application windows, `WindowHandoffAdapter` is the first-class high-level component. It requires a positive target process and optionally an exact window id, plus an explicit bounded Human input policy. The adapter never exposes display-wide/desktop fallback. If only `processId` is supplied, the host must resolve exactly one eligible owned window; if `windowId` is supplied, that exact ownership is revalidated by the existing host boundary. Target disappearance, ambiguity or ownership mismatch fails closed.

On macOS, pointer input remains the bounded stateful `CGEvent` / `cghidEventTap` path after exact-window revalidation. #94 verified that this current path can activate the System Settings Accessibility **Add** control on macOS 26.5, so Handoff does not add Screen Sharing/Remote Management as a privileged or desktop-wide fallback. See the architecture input-backend contract for the fail-closed boundary.

#124 adds an **optional Human-only successor-window lineage policy** to `WindowHandoffAdapter`; exact-one-window behavior remains the default. When enabled, the host may rotate capture/input only to one newly observed successor from the same exact process after a Human action. The old target is input-fenced during bounded successor admission, pre-existing siblings and unrelated/frontmost processes are ineligible, multiple plausible successors fail closed, and there is still no desktop/display fallback. Physical iPhone acceptance on macOS 26.5 proved `Accessibility -> Add (+) -> Open`: the file chooser was a same-process focused `AXDialog`/modal presented at a non-zero WindowServer layer, and the same Handoff session rotated to that exact chooser without selecting a file or changing TCC/permission state.

```ts
import { WindowHandoffAdapter } from "mcp-execution-handoff/window-takeover";

const windowHandoff = new WindowHandoffAdapter({
  takeover: { enabled: true, publicBaseUrl, ttlMs: 60_000 },
  runtime: { hostExecutable, displayName },
  onComplete: async ({ interventionId, epoch }) => {
    // Human transport is fenced. Verify the application state freshly in the consumer.
    await beginFreshWindowVerification(interventionId, epoch);
  }
});

const locator = windowHandoff.start({
  intervention: { id: interventionId, epoch },
  principalBinding,
  target: { processId, windowId },
  inputPolicy: { tap: true, scroll: true, text: false, key: false }
});
```

The consumer still owns why the intervention is needed, application/process lifecycle, semantic verification and replay/resume policy. Handoff owns the short-lived locator, one-client session, exact bounded window media/input transport, direct-first WebRTC/TURN behavior, reconnect generation fencing and revoke. Human `Done` is only the end of the Human transport step; it is not application success or approval.

## Terminal / PTY handoff

`TerminalHandoffAdapter` is the first-class component for one bounded, consumer-owned PTY/session. Handoff does **not** spawn a shell or own cwd/env/job-control semantics. It composes the accepted PTY authority state machine with the DataChannel-only WebRTC/TURN transport, while the consumer keeps the actual PTY/process and content-free postcondition verification.

The adapter is intentionally process-boundary friendly. `begin()` fences Agent authority before returning the Human locator. The consumer drains Agent writes that were already admitted before that fence, then calls `claimHumanAfterAgentDrain()` only after the physical drain completes. An ordered Human `Done` is transport-fenced before `nextHumanEvent()` returns it and immediately moves Handoff authority to `verifying`; the consumer drains already-admitted Human writes and calls `confirmHumanDrain()` before verification can succeed.

```ts
import { TerminalHandoffAdapter } from "mcp-execution-handoff/terminal-takeover";

const terminalHandoff = new TerminalHandoffAdapter({
  binding: { sessionId, sessionGeneration, principalBinding },
  takeover: { enabled: true, publicBaseUrl, ttlMs: 60_000 }
});

const { intervention: awaiting, locator } = terminalHandoff.begin();
await pty.drainAgentWrites();
// Serve authenticated /takeover/terminal/* through terminalHandoff.handle(request, boundPrincipal).
await waitUntil(() => terminalHandoff.transportStatus(awaiting).transportReady);
const human = terminalHandoff.claimHumanAfterAgentDrain(awaiting);

const event = terminalHandoff.nextHumanEvent(human);
if (event?.kind === "input") await pty.writeHuman(event.data);
if (event?.kind === "resize") await pty.resize(event.rows, event.cols);
if (event?.kind === "done") {
  await pty.drainHumanWrites();
  const drained = terminalHandoff.confirmHumanDrain(event.verifying);
  const ready = terminalHandoff.reportVerification(drained, await verifyPtyPostcondition());
  const resume = terminalHandoff.resume(ready);
  if (resume.sessionAlive && resume.agentStateSynchronizationRequired) {
    await invalidateAndReloadAgentPtyState();
    terminalHandoff.acknowledgeAgentStateSynchronization();
  }
}
```

Human-visible PTY output is sent with `pushHumanOutput()` only while the exact Human intervention owns authority. Input/output bytes exist only in ephemeral method/DataChannel buffers; they are not generic Handoff checkpoint, audit, diagnostics, or model content. Disconnect is not `Done` and does not restore Agent authority. Exact PTY exit is terminal for that adapter instance and never synthesizes a replacement session. After explicit resume, Agent input/observation/resize remain fenced until the consumer acknowledges fresh state synchronization, which is also where the consumer must discard or re-read Human-period output/cwd/env/job/prompt assumptions as applicable.

Direct-first ICE, TURN fallback, one-client lease and stale generation/capability rejection remain Handoff-owned. PTY allocation, descendant containment, process exit truth, shell/program policy, and semantic verification remain consumer-owned; Handoff does not claim Windows ConPTY descendant containment parity merely by exposing this adapter.

`TakeoverBroker` remains the lower-level transport/session primitive for consumers that deliberately need the HTTP frame mode, Native composition, or custom transport assembly. The broker deliberately knows only `{ id, epoch }` for an intervention plus a consumer-supplied principal binding and browser adapter. It does not know Maps, Cinema, Chrome URLs, CAPTCHA classifications, or provider policies.

For native operator clients, the broker also exposes an explicit claim/reconnect path. Reconnect is **not** implicit lease transfer: the previous client must be idle, the authenticated principal must match, and a short-lived generation-bound reconnect handle must match. Successful recovery rotates the client generation and invalidates the previous capability and reconnect handle. The reconnect handle is continuity metadata only; it is not a target-service credential and must never contain browser/session content.

The optional WebRTC transport for the Browser Target Surface keeps signaling, H.264/RTP, DataChannel input, Safari lifecycle handling, and reconnect fencing inside Handoff. The macOS host uses ScreenCaptureKit/CoreGraphics; the Linux host uses an isolated X11 display, exact target-window capture, bounded CPU H.264, and OS/window input. Both hosts honor an explicit process/window binding; Linux also revalidates that exact X11 window's PID ownership and bounded geometry immediately before each Human mutation, fencing the transport if the target disappears or ownership changes. The Linux XTEST helper is mechanism-only: it receives bounded root coordinates/button lifecycle commands, holds no PID/XID/title/session authority, never uses `XSendEvent`, and has no automatic xdotool fallback for a failed primary gesture. The Browser compatibility profile remains bounded to at most 1280×720; first-class macOS `WindowHandoffAdapter` sessions opt into an internal text/UI profile that never upscales the source, raises only the ceiling to 1920×1080 at 5 Mbps / 30 fps, and prefers encoder quality over speed. The one-in-flight + newest-pending backpressure rule is unchanged. macOS acceptance currently runs at 30 fps while the Linux CPU host defaults to 15 fps. A WebRTC locator renders the selected host capture surface directly into a `playsinline` video surface. At 1×, tap/swipe operate directly on that surface. For precision targets on small mobile screens, Handoff also owns a bounded local 1×–4× view transform: the Human can use the zoom control or two-finger pinch/pan, and while zoomed a one-finger drag pans only the local view. Those view gestures never dispatch target tap/scroll input; a stationary tap is mapped back through the transformed video bounds to the same exact captured window. The transform never changes browser/page zoom or target-window identity and resets on reconnect/orientation change. A hidden browser input bridge uses the iOS keyboard for text/Backspace only when allowed by the session input policy. It never falls back to the legacy HTTP frame/input controls. Backgrounding, peer disconnect, or explicit suspend tears down the peer and releases that exact client generation; foreground media recovery requires a fresh generation before a new peer is created. Reconnect is single-flight across overlapping Safari lifecycle/failure triggers, waits for the exact generation release, bounds active-lease conflict retries, and never queues/replays Human input across generations. A physical same-LAN iPhone run recovered through three background/foreground cycles without a 409 loop or black-frame stall. Full browser-app termination intentionally loses memory-only reconnect state and therefore requires a fresh authorized flow rather than implicit lease transfer. A separate principal/intervention/epoch/expiry-bound completion-only capability lets the same authorized locator be reloaded and `Done` be delivered without reviving stale media/input authority. `Done` fences transport before invoking the consumer completion callback and is not authentication success or approval.

Physical iPhone Safari acceptance has passed on both same-LAN direct WebRTC and cellular/4G TURN relay. The accepted path covered window-scoped video, target-window re-activation when another Mac app was frontmost, tap/focus, text, Backspace, scrolling, and Done/revoke with stale-locator rejection. Completion-only reload recovery is covered deterministically. Bounded client-side precision zoom/pan is implemented and covered by transform/gesture regressions; physical portrait precision acceptance remains the next mobile UX gate, while target-window resize and broader keyboard composition remain follow-up work rather than prerequisites for the accepted transport baseline.

Direct-first ICE is explicit on both peers. With no relay provider, the Safari/browser peer stays host-only (`iceServers: []`) and the Node/werift peer uses one explicit STUN server instead of Werift's implicit third-party default. Optional TURN remains fallback-only (`iceTransportPolicy: all`), never relay-only. Handoff currently supports Cloudflare Realtime TURN and self-hosted coturn TURN REST credentials. Both issue independent short-lived browser/server credentials only after generation binding and never encode principal/intervention/client identity into TURN usernames or metadata. The coturn adapter uses `timestamp:random` usernames and `base64(HMAC-SHA1(shared-secret, username))`, matching coturn `use-auth-secret`; because coturn has no per-credential revoke API, those relay credentials expire at the bound Handoff generation deadline while Handoff authority itself is revoked immediately. Raw candidate strings, IP addresses, SDP, credentials, framebuffer bytes, and Human input are not diagnostics or durable control-plane artifacts; diagnostics are limited to candidate type/count, peer state, and bounded timing.

For dense mobile UIs, the client also provides a client-side **Aim mode**. Enabling Aim moves the view to a bounded 4× scale; video drag/pinch remains local pan/zoom and emits no remote input. The Human aligns the target under a fixed center crosshair and only the explicit `Tap` control emits one ordinary server-policy-gated remote tap. Reconnect, orientation change, and teardown reset Aim/view state, and this does not widen consumer semantics or server-side input authority.

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

This repository is the upstream source of truth. `v0.2.0` is the current **GitHub/source release only** baseline. It establishes Browser, bounded OS Window, and bounded Terminal/PTY as first-class source components while keeping Target Surface labels documentation-first and preserving compatibility-safe Human Interaction Policy aliases. npm publication is a separate decision and has not been performed; `private: true` remains in effect. See [Release process](RELEASING.md).

## License

MIT
