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

The optional broker owns only transport/session concerns. A public locator contains no capability. Same-origin bootstrap claims one remote-client lease and returns a short-lived capability. Every frame/input/done request must present the matching capability, principal binding, and client binding.

A new binding cannot implicitly reclaim an already-owned lease. Native clients may instead use the explicit claim/reconnect API. Reconnect requires the same authenticated principal, a generation-bound reconnect handle, and an idle prior lease. Successful reconnect increments the client generation and rotates both capability and reconnect handle, so the old client generation is immediately fenced. Expired/revoked sessions, active prior clients, wrong principals, wrong handles, or stale generations fail closed. The reconnect handle contains no browser content or target-service credential material.

For the WebRTC browser transport, ICE remains direct-first and Handoff owns the full signaling/data-plane policy. Safari uses host candidates only; the Node/werift peer uses an explicit Cloudflare STUN server so dependency behavior cannot silently select a different third-party default. TURN, when configured, is fallback-only and uses generation-bounded short-lived peer credentials. Network diagnostics retain only candidate type/count, peer state, and bounded timing; candidate strings, addresses, SDP, and credentials are excluded.

Touch-capable Safari uses Touch Events as the authoritative gesture stream and suppresses duplicate touch Pointer Events. The macOS host injects events from `CGEventSource(stateID: .combinedSessionState)`, which matches a process running inside the logged-in user session. Tap/scroll use the session event tap; target-bound keyboard input is posted to the resolved target PID when available. These choices keep window-scoped capture/input and browser gesture semantics aligned without broadening the consumer API.

The broker cannot widen the set of surfaces eligible for takeover. The consumer browser adapter must reject navigation/state outside its own allowlist and verify every input against the current intervention epoch.

## Consequential actions

No generic approval API is coupled to handoff completion. A consumer that performs a consequential action must use a separate explicit approval mechanism bound to its exact final action and current state. Human completion is evidence only that the manual intervention step ended; it is never approval for a later action.
