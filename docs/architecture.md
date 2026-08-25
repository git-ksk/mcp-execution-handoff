# Architecture

[日本語](architecture.ja.md)

## Boundary

`mcp-execution-handoff` is a control-plane library, not an execution engine. Native browser, desktop, terminal, device, or provider operations remain inside consumer adapters.

```text
MCP / Agent
   |
   v
MCP bridge ---------------- principal + invocation + args binding
   |
   v
Execution Handoff core ---- authority / epoch / resume policy / checkpoint
   |
   +---- consumer adapter: browser.maps
   |
   +---- consumer adapter: browser.cinema
   |
   +---- optional browser takeover transport
   |
   +---- credential-safe external Human provider coordinator
```

Consumer integration is **optional, but authoritative when enabled**. A consumer such as CUMG may run without Handoff at all; Handoff is not a mandatory execution dependency. Once a consumer elects to attach Handoff to a bounded operation or Target Surface, however, the consumer must treat Handoff authority as part of its execution boundary: Agent and Human authority must remain mutually exclusive, stale/unknown Handoff state must fail closed, and runtime/transport unavailability must not be converted into a bypass that silently restores Agent control. Domain authorization, operation ledgers, quarantine, and postcondition verification remain consumer-owned; Handoff owns only its canonical authority/epoch/ownership/replay/recovery semantics and must not be duplicated inside the consumer.

## Four-axis handoff taxonomy

The architecture uses four separate axes. They compose, but they are not interchangeable terms and not every combination is necessarily supported.

### 1. Handoff Semantics

This is the invariant core: who owns execution authority, which state is still valid, and under what conditions execution may resume. It includes Agent/Human authority exclusivity, resource-epoch fencing, principal/invocation ownership binding, bounded checkpoints, replay/resume policy, stale reconnect rejection, and recovery by `reissue_and_revalidate`.

Handoff Semantics are target- and transport-agnostic. They are not a takeover type.

### 2. Human Interaction Policy

This describes the trust/safety boundary under which the Human may interact. The current implementation values are:

- `automation_adjacent` — Human control remains adjacent to the automation-managed execution surface;
- `credential_safe_external` — Human control moves to an external Human-only boundary suitable for interventions that must not reuse the automation-managed credential surface.

The existing TypeScript API calls these values `HumanSurfaceKind`. Documentation uses **Human Interaction Policy** to avoid confusing this policy axis with the actual target surface. No public API rename is required for this taxonomy.

### 3. Target Surface

This describes what execution surface the Human controls. The currently proven categories are:

- `browser` — a browser execution/window/session surface;
- `os_window` — a bounded OS application/window surface.

Future categories such as terminal/PTY or another native-application abstraction remain non-contractual until a real consumer proves the need. Architecture terminology prefers **Target Surface**; “takeover type” may be used informally, but should not replace the canonical term.

### 4. Transport

This describes how Human control/media is delivered. Current and planned transport families include Native, WebRTC, and future WebSocket/HTTP-streaming/WebTransport siblings. Within WebRTC, direct ICE is preferred when viable and TURN is fallback connectivity infrastructure. `WebRTC direct` and `WebRTC + TURN` are therefore transport/connectivity outcomes, not Target Surface kinds.

```text
Execution Handoff
|
+-- Handoff Semantics
|    authority / epoch / ownership / replay / recovery
|
+-- Human Interaction Policy
|    automation_adjacent
|    credential_safe_external
|
+-- Target Surface
|    browser
|    os_window
|
+-- Transport
     Native
     WebRTC
       +-- direct
       +-- TURN fallback
     future: WebSocket / HTTP streaming / WebTransport
```

Current examples include `browser + automation_adjacent + WebRTC` and `browser/os_window + credential_safe_external + WebRTC`. A combination is supported only when the relevant consumer/provider/host path has its own acceptance evidence; architectural composability does not imply blanket support.

## Lifecycle

1. Consumer detects a surface that requires Human intervention.
2. `ExecutionHandoffState.begin()` creates or returns the sole active intervention and advances the resource epoch.
3. The originating invocation binds an owner while the intervention is still `awaiting_human`.
4. Agent authority is suspended. Human may claim exclusive control.
5. Human completion moves to `verifying` and advances the epoch again.
6. The consumer performs domain-specific postcondition verification.
7. Verification either returns control to Human for another round, fails/cancels, or marks the intervention `ready_to_resume`.
8. Resume returns a policy decision. The consumer decides whether the original operation may safely replay, must be reissued semantically, or must never replay.

The core does not infer that a challenge is solved, a login is successful, or a transaction is approved. Those are adapter policies.

## Durable recovery

The file checkpoint is HMAC-protected and private-permission. It persists only bounded metadata: adapter kind, intervention id/status, epoch, resume policy, principal binding, optional action digest, timestamps, expiry.

It deliberately excludes raw arguments and execution content. Recovery returns `reissue_and_revalidate`; old Agent/Human authority, requestState, browser state, or takeover capability are not restored.

## MCP bridge

MRTR requestState binds:

- exact tool name,
- canonical argument digest,
- intervention id,
- resource epoch,
- resume strategy,
- authenticated logical-principal binding.

The library does not decide how a consumer authenticates a user. The consumer must derive a stable non-secret binding and pass it explicitly.

## Credential-safe external Human surface

The external Human surface is a control-plane adapter. It can point at a truly external normal-browser provider, or at the bounded Handoff browser broker when a hosted execution plane deliberately keeps the browser co-located. These modes have different browser trust boundaries and must not be conflated.

`HostedBrowserTakeoverProvider` is a small bridge from the existing `TakeoverBroker` to the generic `ExternalHumanSurfaceProvider` contract. It adds no CDP, Chrome, Maps, or provider-specific concept to Handoff: frame/input implementation remains a consumer adapter. This mode is appropriate only where the target service permits the hosted browser shape and after real sign-in acceptance. It is not a bypass for providers that require a non-automated browser.

A consumer first enters the normal handoff lifecycle and gives exclusive authority to the Human. Only then may `CredentialSafeHumanSurfaceRuntime.begin()` create an external operator session. The runtime binds that session to the active intervention id, resource epoch, and principal binding. Only one session may be active, and a duplicate begin is idempotent only for the same binding.

Provider output is deliberately narrowed to bounded fields: provider kind, intervention id, epoch, principal binding, session id, operator locator, and optional expiry. Extra provider data is not retained. In particular, credentials, browser cookies, tokens, screenshots, DOM/network data, and provider-specific opaque metadata must not be used as continuity material.

Before restoring automation, the consumer must revoke the external session and verify any consumer-specific execution boundary, such as closing a normal browser and releasing its dedicated profile lock. Human completion then advances through the existing `verifying -> ready_to_resume` lifecycle. Authentication success must be revalidated from fresh browser state, and stale pre-auth semantic actions must not be replayed.

The package does not decide which intervention reasons need this surface. `selectHumanSurface()` lets each consumer configure its own identity-sensitive reason set without moving provider-specific policy into the generic core.

## Browser takeover

`BrowserHandoffAdapter` is the first-class consumer-level Browser WebRTC composition. It owns construction of the bounded WebRTC runtime + broker pair and intentionally exposes no generic HTTP-frame start operation. Consumers provide an already-authorized exact process/window target, an explicit `{ tap, scroll, text, key }` input policy, and retain ownership of browser/profile start-stop, target-service authentication semantics, checkpoint/restore policy, and fresh post-Human verification. The input policy is immutable for the active takeover session, returned to the browser client as bounded booleans, and enforced server-side before OS input so UI bugs cannot widen authority.

`processId` is mandatory. When no `windowId` is supplied the platform host must resolve exactly one eligible window for that process. When `windowId` is explicit, the host revalidates that exact window is owned by the process. Linux additionally checks the same X11 window's PID ownership/visibility and refreshes its bounded geometry immediately before every Human mutation; disappearance, window-id reuse by another process, focus failure, or ownership mismatch fences the host rather than selecting another window. None, ambiguity, disappearance, or ownership mismatch ever fall back to desktop capture/input.

The adapter's `start()` returns a short-lived locator, not a readiness claim. The existing WebRTC prepare/connect path remains authoritative for runtime readiness and does not return a usable answer until the host-window/first-media-frame gates pass. Transport failure is explicit and cannot silently switch the canonical adapter to HTTP screenshot polling.

WebRTC media/input generation authority and Human completion authority are deliberately separate. A completion-only HMAC capability is bound to session/intervention/epoch/principal/expiry but not to the released media generation. The same authenticated principal may therefore reload the short-lived locator after a disconnect and press `Done` without making any stale frame/input capability valid again. Completion first fences/revokes transport and only then invokes the adapter's optional consumer callback to start fresh verification. Callback failure is retryable with the same completion-only capability; successful delivery is idempotent. `Done` remains completion evidence only, never authentication success or approval.

The lower-level optional `TakeoverBroker` owns transport/session concerns for deliberate custom compositions. A public locator contains no media/input capability. Same-origin bootstrap claims one remote-client lease and returns a short-lived generation capability. Legacy HTTP frame/input/done operations still require the matching capability, principal binding, and client binding; the canonical WebRTC completion path uses the separate completion-only capability described above.

A new binding cannot implicitly reclaim an already-owned lease. Native clients may instead use the explicit claim/reconnect API. Reconnect requires the same authenticated principal, a generation-bound reconnect handle, and an idle prior lease. Successful reconnect increments the client generation and rotates both capability and reconnect handle, so the old client generation is immediately fenced. Expired/revoked sessions, active prior clients, wrong principals, wrong handles, or stale generations fail closed. The reconnect handle contains no browser content or target-service credential material.

For the WebRTC browser transport, ICE remains direct-first and Handoff owns the full signaling/data-plane policy. Safari uses host candidates only; the Node/werift peer uses an explicit Cloudflare STUN server so dependency behavior cannot silently select a different third-party default. TURN, when configured, is fallback-only and uses generation-bounded short-lived peer credentials. Network diagnostics retain only candidate type/count, peer state, and bounded timing; candidate strings, addresses, SDP, and credentials are excluded.

For dense mobile UIs, the client also provides a client-side **Aim mode**. Enabling Aim moves the view to a bounded 4× scale; video drag/pinch remains local pan/zoom and emits no remote input. The Human aligns the target under a fixed center crosshair and only the explicit `Tap` control emits one ordinary server-policy-gated remote tap. Reconnect, orientation change, and teardown reset Aim/view state, and this does not widen consumer semantics or server-side input authority.

Touch-capable Safari uses Touch Events as the authoritative gesture stream and suppresses duplicate touch Pointer Events. The macOS host injects events from `CGEventSource(stateID: .combinedSessionState)`, which matches a process running inside the logged-in user session. Tap/scroll use the session event tap; target-bound keyboard input is posted to the resolved target PID when available. These choices keep window-scoped capture/input and browser gesture semantics aligned without broadening the consumer API.

The broker cannot widen the set of surfaces eligible for takeover. The consumer browser adapter must reject navigation/state outside its own allowlist and verify every input against the current intervention epoch.

## Consequential actions

No generic approval API is coupled to handoff completion. A consumer that performs a consequential action must use a separate explicit approval mechanism bound to its exact final action and current state. Human completion is evidence only that the manual intervention step ended; it is never approval for a later action.
