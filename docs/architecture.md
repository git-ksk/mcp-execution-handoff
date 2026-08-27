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
   +---- BrowserHandoffAdapter ---- exact browser/window + WebRTC
   |
   +---- WindowHandoffAdapter ----- exact bounded OS window + WebRTC
   |
   +---- TerminalHandoffAdapter --- bounded consumer-owned PTY + DataChannel WebRTC
   |
   +---- credential-safe external Human provider coordinator
```

Consumer integration is **optional, but authoritative when enabled**. A consumer such as CUMG may run without Handoff at all; Handoff is not a mandatory execution dependency. Once a consumer elects to attach Handoff to a bounded operation or Target Surface, however, the consumer must treat Handoff authority as part of its execution boundary: Agent and Human authority must remain mutually exclusive, stale/unknown Handoff state must fail closed, and runtime/transport unavailability must not be converted into a bypass that silently restores Agent control. Domain authorization, operation ledgers, quarantine, and postcondition verification remain consumer-owned; Handoff owns only its canonical authority/epoch/ownership/replay/recovery semantics and must not be duplicated inside the consumer.

## Four-axis handoff taxonomy

The architecture uses four separate axes. They compose, but they are not interchangeable terms and not every combination is necessarily supported.

### 1. Handoff Semantics

This is the invariant core: who owns execution authority, which state is still valid, and under what conditions execution may resume. It is organized into four semantic domains rather than treating every mechanism as a peer concept:

- **Authority state-machine semantics** — exclusive `agent` / `human` / `none` authority and explicit `awaiting_human -> human_active -> verifying -> ready_to_resume` transitions, including cancel, return-to-Human, and explicit resume.
- **Freshness and ownership fencing semantics** — monotonic resource epochs, stale-state rejection, principal binding, exact invocation/canonical-argument ownership, and no owner rebinding after the initial ownership window.
- **Completion and continuation semantics** — Human `Done` ends the manual step only; fresh consumer verification and the stricter replay/call-site policy decide whether execution may continue. `Done` is neither semantic success nor consequential-action approval.
- **Recovery semantics** — durable state contains bounded control-plane metadata only, checkpoint integrity/expiry is enforced, and restart recovery is always `reissue_and_revalidate` rather than restoration of stale Agent/Human authority or browser/request state.

Handoff Semantics are target- and transport-agnostic. They are not a takeover type.

**Takeover Session Semantics are a separate optional layer.** Short-lived capability, one-client lease, client generation, reconnect handle, release/revoke/expiry, and stale capability rejection are security-critical but belong to the remote Human-control session rather than the invariant authority state machine. They remain bound to intervention + epoch + principal and may be reused by Native, WebRTC, WebSocket, or future transports without becoming core Handoff state solely because they are security mechanisms.

### 2. Human Interaction Policy

This describes the trust/safety boundary under which the Human may interact. The current implementation values are:

- `automation_adjacent` — Human control remains adjacent to the automation-managed execution surface;
- `credential_safe_external` — Human control moves to an external Human-only boundary suitable for interventions that must not reuse the automation-managed credential surface.

The canonical TypeScript API now exposes `HumanInteractionPolicyKind`, `HUMAN_INTERACTION_POLICY_KINDS`, and `selectHumanInteractionPolicy()`. The historical `HumanSurfaceKind`, `HUMAN_SURFACE_KINDS`, and `selectHumanSurface()` names remain compatibility aliases so v0.2.0 does not break consumers.

### v0.2 terminology inventory and compatibility decision

The public vocabulary is intentionally additive in v0.2.0. Existing consumers are not required to rename imports merely to match documentation.

| Existing term or symbol | Canonical axis | v0.2.0 decision |
| --- | --- | --- |
| `HumanInteractionPolicyKind`, `HUMAN_INTERACTION_POLICY_KINDS`, `selectHumanInteractionPolicy()` | Human Interaction Policy | Canonical public names for `automation_adjacent` / `credential_safe_external`. |
| `HumanSurfaceKind`, `HUMAN_SURFACE_KINDS`, `selectHumanSurface()` | Human Interaction Policy | Compatibility aliases. They remain source/runtime compatible; removal is reserved for a future intentional breaking release after consumer migration. |
| credential-safe external Human surface/provider/runtime | Human Interaction Policy + concrete Human-control boundary | Keep the wording when it refers to the actual external operator boundary. It is not a Target Surface kind and does not attest target-service identity. |
| `BrowserHandoffAdapter` / Browser | Target Surface | Canonical consumer-level Browser surface. |
| `WindowHandoffAdapter` / bounded OS Window | Target Surface | Canonical `os_window` architecture label. Exact PID/window ownership remains fail closed; there is no desktop-wide fallback. |
| `TerminalHandoffAdapter` / bounded Terminal/PTY | Target Surface | Canonical `terminal_pty` architecture label. PTY/process ownership remains consumer-owned. |
| `browser`, `os_window`, `terminal_pty` | Target Surface | Proven documentation labels only. v0.2.0 intentionally does **not** export `TargetSurfaceKind`: there is no shared runtime compatibility/diagnostic discriminator that needs it yet. |
| Native, WebRTC, WebSocket; direct ICE / TURN fallback | Transport | Transport families/connectivity behavior only. They do not identify the Target Surface or change Handoff authority. |
| `browser-takeover`, `window-takeover`, `terminal-takeover` package subpaths; `TakeoverBroker` | Compatibility/API naming | Retained to avoid breaking consumers. “Takeover” in these names is historical API/product prose, not a fifth architecture axis. New architecture prose should prefer Browser/Window/Terminal **Handoff** plus an explicit Transport when needed. |
| “browser takeover” | Product prose / compatibility naming | Acceptable when referring to the historical API/module or the broader browser-Human-control feature. Do not use it as a synonym for Transport or Handoff Semantics. |
| “browser transport” | Transport | Use only for a concrete transport implementation carrying Browser Target Surface media/input; Browser itself is not a transport. |
| “OS takeover”, “desktop takeover”, “window takeover” | Target Surface prose | Prefer **bounded OS Window Handoff**. Whole-desktop control is outside the current normal boundary; compatibility module names are the only reason to retain “window-takeover”. |
| unqualified “Human surface” | Context-dependent | Avoid when discussing policy. Use **Human Interaction Policy**, **Target Surface**, or **Human-control session/boundary** according to the actual axis. |
| Human `Done` | Handoff Semantics | Completion evidence only. It is not semantic success, authentication success, target-service identity proof, or approval. |
| MCP principal vs target-service account/session | Handoff Semantics / consumer authorization boundary | Remain distinct. Handoff binds the MCP principal/invocation/epoch; consumers must freshly verify target-service identity/context when required. |

The compatibility aliases above are the complete public rename for v0.2.0. No authority, replay, completion, principal-binding, transport-selection, exact-window, or PTY semantics change with this terminology convergence. Consumer transport selection also remains outside the generic public Handoff policy API.

### 3. Target Surface

This describes what execution surface the Human controls. Real consumer evidence now proves three materially different surface shapes:

- `browser` — a browser execution/window/session surface;
- `os_window` — a bounded OS application/window surface;
- `terminal_pty` — one bounded, consumer-owned PTY/session with byte-stream input/output, resize, staged writer drains, process continuity, and mandatory post-Human Agent state synchronization.

`terminal_pty` is an architecture label for the proven shape, not a frozen public enum value. #46 documents the semantic-domain/Target Surface admission baseline; the v0.2 compatibility decision above completes the public terminology convergence without introducing a Target Surface enum. A future native-application/device abstraction remains non-contractual until a real consumer proves a materially different boundary. Architecture terminology prefers **Target Surface**; “takeover type” may be used informally, but should not replace the canonical term.

A new Target Surface shape is admitted only when its execution boundary differs materially in authority, capture/input model, lifecycle, or postcondition handling. A different application technology, product/domain, OS/device, or transport does not create a new shape by itself. `native_app` remains `os_window` when the authority boundary is still one bounded application window; `device` is normally a host/runtime property; whole `desktop` control is not a normal Target Surface and requires a separate explicit security review because it widens the current exact-surface boundary. Editor/document/IDE labels are product categories, not generic authority boundaries.

Target Surface remains descriptive/documentation-first unless a concrete runtime compatibility or diagnostics need justifies a machine-readable public discriminator. The existence of three proven shapes does not by itself require a public enum.

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
|    terminal_pty
|
+-- Transport
     Native
     WebRTC
       +-- direct
       +-- TURN fallback
     future: WebSocket / HTTP streaming / WebTransport
```

Current examples include `browser + automation_adjacent + WebRTC`, bounded `os_window + WebRTC`, and `terminal_pty + WebRTC DataChannel`. A combination is supported only when the relevant consumer/provider/host path has its own acceptance evidence; architectural composability does not imply blanket support. Direct ICE and TURN relay are transport outcomes, not additional Target Surface categories.

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

The v0.3 recovery/observability contract keeps this authority rule while separating three operator data paths: durable checkpoint, durable-friendly audit metadata, and process-memory diagnostics. Provider-neutral storage may replace the file mechanism, but not widen the admitted durable schema or restore ephemeral authority. See [Recovery and observability boundary](recovery-observability.md) and Issues #127–#130.

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

### MCP principal vs target-service identity

The authenticated MCP principal that owns the intervention is not the same security domain as the account/session active inside the target service. Handoff binds control-plane ownership to the MCP principal + invocation + resource epoch, but it does not attest a Google/Apple/member/enterprise account merely because the Human completed sign-in, MFA, account selection, CAPTCHA, or consent. A consumer that needs account identity for authorization must perform its own fresh identity/context verification and fail closed on unknown, changed, or ambiguous state. Credentials, cookies, session tokens, MFA/OTP values, and challenge answers must not be copied into Handoff state to create that binding.

Single-user deployments should use a dedicated browser profile/runtime for the logical principal. Unrelated principals must not share one authenticated profile without an explicit per-principal isolation design. Human `Done` remains separate from both target-service identity attestation and any later consequential-action approval.

A higher-assurance **consumer-specific target-service identity verification gate** may be added when a consumer must authorize against an expected service account/context. That gate must bind its result to the MCP principal + dedicated profile/runtime + resource epoch + intended semantic action, expose no credentials/tokens, and fail closed when identity is unknown, ambiguous, stale, or changed. Generic Handoff state intentionally carries no target-service account attestation field.

Real consumer evidence follows this separation: Maps exposes only coarse authentication readiness and requires fresh semantic reissue/revalidation rather than treating Google sign-in completion as account proof; Japan Cinema keeps member sign-in data out of Handoff state and never turns Human completion into checkout/purchase authority. These examples validate the generic boundary without moving provider-specific identity logic into Handoff.

The package does not decide which intervention reasons need this boundary. `selectHumanInteractionPolicy()` lets each consumer configure its own identity-sensitive reason set without moving provider-specific policy into the generic core; `selectHumanSurface()` remains its compatibility alias.

## Browser Handoff (compatibility API: browser takeover)

`BrowserHandoffAdapter` is the first-class consumer-level Browser WebRTC composition. It owns construction of the bounded WebRTC runtime + broker pair and intentionally exposes no generic HTTP-frame start operation. Consumers provide an already-authorized exact process/window target, an explicit `{ tap, scroll, text, key }` input policy, and retain ownership of browser/profile start-stop, target-service authentication semantics, checkpoint/restore policy, and fresh post-Human verification. The input policy is immutable for the active takeover session, returned to the browser client as bounded booleans, and enforced server-side before OS input so UI bugs cannot widen authority.

`processId` is mandatory. When no `windowId` is supplied the platform host must resolve exactly one eligible window for that process. When `windowId` is explicit, the host revalidates that exact window is owned by the process. Linux additionally checks the same X11 window's PID ownership/visibility and refreshes its bounded geometry immediately before every Human mutation; disappearance, window-id reuse by another process, focus failure, or ownership mismatch fences the host rather than selecting another window. Primary pointer injection is a separate mechanism-only boundary: one standalone Xlib/libXtst child keeps a persistent X11 connection, serializes MOVE/DOWN/UP/CANCEL, and acknowledges mutations after `XSync`. The Node host remains the sole PID/XID/geometry/active/focus authority and never continues a failed gesture through `XSendEvent`, DOM/CDP, or an xdotool pointer fallback. None, ambiguity, disappearance, or ownership mismatch ever fall back to desktop capture/input.

The adapter's `start()` returns a short-lived locator, not a readiness claim. The existing WebRTC prepare/connect path remains authoritative for runtime readiness and does not return a usable answer until the host-window/first-media-frame gates pass. Transport failure is explicit and cannot silently switch the canonical adapter to HTTP screenshot polling.

WebRTC media/input generation authority and Human completion authority are deliberately separate. A completion-only HMAC capability is bound to session/intervention/epoch/principal/expiry but not to the released media generation. The same authenticated principal may therefore reload the short-lived locator after a disconnect and press `Done` without making any stale frame/input capability valid again. Completion first fences/revokes transport and only then invokes the adapter's optional consumer callback to start fresh verification. Callback failure is retryable with the same completion-only capability; successful delivery is idempotent. `Done` remains completion evidence only, never authentication success or approval.

The lower-level optional `TakeoverBroker` owns transport/session concerns for deliberate custom compositions. A public locator contains no media/input capability. Same-origin bootstrap claims one remote-client lease and returns a short-lived generation capability. Legacy HTTP frame/input/done operations still require the matching capability, principal binding, and client binding; the canonical WebRTC completion path uses the separate completion-only capability described above.

A new binding cannot implicitly reclaim an already-owned lease. Native clients may instead use the explicit claim/reconnect API. Reconnect requires the same authenticated principal, a generation-bound reconnect handle, and an idle/released prior lease. Successful reconnect increments the client generation and rotates both capability and reconnect handle, so the old client generation is immediately fenced. Browser WebRTC recovery coalesces overlapping Safari lifecycle/failure triggers into one reconnect, waits for exact-generation release, bounds active-lease conflict retries, and never replays Human input across generations. Physical same-LAN iPhone acceptance recovered through three background/foreground cycles without a 409 loop or black-frame stall. Full browser-app termination intentionally loses memory-only reconnect state and requires a fresh authorized flow. Expired/revoked sessions, active prior clients, wrong principals, wrong handles, or stale generations fail closed. The reconnect handle contains no browser content or target-service credential material.

For the WebRTC transport carrying the Browser Target Surface, ICE remains direct-first and Handoff owns the full signaling/data-plane policy. Safari uses host candidates only; the Node/werift peer uses an explicit Cloudflare STUN server so dependency behavior cannot silently select a different third-party default. TURN, when configured, is fallback-only and uses generation-bounded short-lived peer credentials. Network diagnostics retain only candidate type/count, peer state, and bounded timing; candidate strings, addresses, SDP, and credentials are excluded.

For dense mobile UIs, the client also provides a client-side **Aim mode**. Enabling Aim moves the view to a bounded 4× scale; video drag/pinch remains local pan/zoom and emits no remote input. The Human aligns the target under a fixed center crosshair and only the explicit `Tap` control emits one ordinary server-policy-gated remote tap. Reconnect, orientation change, and teardown reset Aim/view state, and this does not widen consumer semantics or server-side input authority.

Touch-capable Safari uses Touch Events as the authoritative gesture stream and suppresses duplicate touch Pointer Events. The macOS host injects events from `CGEventSource(stateID: .combinedSessionState)`, which matches a process running inside the logged-in user session. Tap/scroll use the session event tap. For an exact native window, ordinary non-secure AppKit text controls first use a bounded `AXSelectedText` commit only after the focused window, focused-element PID, and non-web ancestry are revalidated; unsupported controls keep the existing target-PID keyboard-event path. Ownership or exact-window mismatches fail closed rather than falling back. Text-routing diagnostics retain only one bounded stage (`native_ax`, `pid_keyboard`, `event_creation_failure`, `activation_rejected`, or `native_boundary_rejected`) and never retain Human text, coordinates, target/process/window identity, or session identity. These choices keep window-scoped capture/input and browser gesture semantics aligned without broadening the consumer API.

The broker cannot widen the set of surfaces eligible for takeover. The consumer browser adapter must reject navigation/state outside its own allowlist and verify every input against the current intervention epoch.

## Window handoff

`WindowHandoffAdapter` is the first-class non-browser bounded-window component. Browser and Window share the smallest internal bounded-window WebRTC/session core: exact process/window binding, short-lived locator/session lifecycle, direct-first ICE with optional TURN fallback, reconnect/client-generation fencing, revoke, and privacy-bounded transport diagnostics. Browser profile/authentication policy remains in the Browser facade rather than leaking into the Window component.

The Window adapter requires a positive `processId`, an optional exact `windowId`, and an explicit bounded `{ tap, scroll, text, key }` Human input policy. There is no display-wide or whole-desktop fallback. If only `processId` is supplied, the host must resolve exactly one eligible owned window; if `windowId` is supplied, ownership is revalidated against that process. Target disappearance, ambiguity, ownership mismatch, or input-host failure fences the Human transport rather than widening scope.

CUMG is the real non-browser consumer. It migrated from consumer-local `TakeoverBroker` + WebRTC runtime assembly to `WindowHandoffAdapter` without moving CUMG authorization, quarantine, replay, or semantic verification into Handoff. Merged-code physical iPhone acceptance passed on both a public Cloudflare Tunnel/TURN relay path and the equivalent same-LAN direct path, including stale-locator rejection. Issue #85 is complete; future Window work should extend bounded capability rather than re-prove the first-class adapter boundary.

### macOS Window input-backend capability contract

The ordinary macOS Window Handoff backend remains **bounded exact-window Human input**. It is not Apple Screen Sharing, Remote Management, a VNC server, a trusted-HID daemon, or an Agent mutation API. The current capability contract is:

- every mutable Human input first revalidates and activates the same exact process/window frame; ambiguity, disappearance, ownership change, or activation failure rejects the input;
- pointer input uses stateful `CGEvent` mouse movement/button lifecycle from the logged-in session (`combinedSessionState`) and posts at `cghidEventTap` only after exact-window revalidation; pressed state is released fail-closed on disconnect/revoke/expiry;
- ordinary non-secure native text may use the separately bounded AX selected-text route; secure text fields and web content are excluded from that route, and credentials/authorization secrets are never a Handoff input capability;
- input policy remains the existing explicit `{ tap, scroll, text, key }` Human policy. Handoff exposes no general trusted-HID, desktop, TCC, authorization, or credential-injection primitive to the Agent;
- there is **no hidden secure-UI fallback**. If an exact system control rejects this bounded backend, the session remains fail-closed. A future backend that fundamentally requires desktop-wide or privileged remote-control authority must be introduced as a separate, explicitly reviewed escalation rather than selected implicitly from Window Handoff.

Issue #94 re-tested the premise after the stateful macOS pointer work in #99/#101. The physical failure was traced to the pre-input AX gate rather than WebRTC or the `CGEvent` path: System Settings exposed the exact Accessibility window as active/focused with matching geometry, but `AXRaise` returned `kAXErrorAttributeUnsupported` (`-25205`). Handoff had incorrectly treated that activation aid as mandatory authority proof. `AXRaise` is now best-effort; admission still requires the same active process and focused AX window to match the exact captured bounds. On macOS 26.5, physical iPhone acceptance then activated the `Privacy & Security > Accessibility` **Add** control and opened its system file chooser. The chooser became a separate focused window while capture stayed on the original bounded Accessibility window; no target/desktop fallback was introduced. No TCC entry, permission value, password, credential, or authorization decision was changed by the probe. This falsifies the assumption that a second Screen Sharing/Remote Management backend is currently required for that control. Apple's own documentation describes Screen Sharing/Remote Management as desktop-control facilities, so importing them as a silent Window fallback would widen authority beyond the exact-window contract.

### Bounded successor-window lineage

Issue #124 closes the narrower boundary exposed by #94 without changing ordinary Window authority. `WindowHandoffAdapter` keeps exact-one-window behavior by default and offers an explicit `successorWindowPolicy: { mode: "same_process", transitionWindowMs? }` opt-in for Human sessions that may legitimately create a modal, sheet, file chooser, or secondary window. Admission is metadata-only and fail-closed: the candidate must be newly observed after the Human action, owned by the same exact PID, uniquely eligible, on-screen, geometrically revalidated, and focused/modal/dialog-related; pre-existing sibling IDs and unrelated/frontmost processes are never successors. During the bounded probe the old mutable target is fenced. Capture/filter and input bounds rotate only after the successor is re-resolved exactly; ambiguous, stale, unsupported, or failed transitions stop rather than widening scope. A successor may return only to its immediate exact predecessor after the current successor disappears and the predecessor is focused.

Layer zero remains the ordinary exact Window rule. Physical #124 acceptance discovered that the macOS System Settings **Open** file chooser is owned by the same System Settings PID and exposed by AX as a focused `AXDialog` with `AXModal=true`, while WindowServer presents it at layer 8. The lineage-only resolver therefore permits a non-zero-layer successor only when AX independently proves that same exact candidate is focused and modal/dialog; arbitrary floating/system layers remain ineligible. The ordinary exact-window resolver is unchanged and still requires layer zero. On a same-LAN physical iPhone run, `Accessibility -> Add (+)` produced `host.window.successor.admitted`, the existing WebRTC session rotated its capture to the chooser, and no file, credential, TCC entry, permission value, display, or desktop authority was selected or changed. Diagnostics expose only bounded stages (`probe`, `admitted`, `returned`, `none`, `ambiguous`, `unsupported`, `failure`) and never window titles, frames, input payloads, or credentials.

Implementation comparison supports keeping the current backend family rather than adding a privileged one. Apple's Core Graphics documentation distinguishes the HID event tap from the login-session tap where HID and remote-control events enter a session. Sunshine's macOS input backend posts stateful mouse events through Core Graphics at the HID tap, while RustDesk constructs macOS virtual input from `CombinedSessionState` and uses a Core Graphics event-tap path. These mature remote-control implementations differ in event-tap details but do not establish a separate exact-window-safe privileged API that would justify importing Screen Sharing/Remote Management into Handoff. References: [Apple CGEventTapLocation](https://developer.apple.com/documentation/coregraphics/cgeventtaplocation), [Apple Screen Sharing](https://support.apple.com/guide/mac-help/mh11848/mac), [Sunshine macOS input](https://github.com/LizardByte/Sunshine/blob/master/src/platform/macos/input.cpp), [RustDesk input service](https://github.com/rustdesk/rustdesk/blob/master/src/server/input_service.rs).

## Terminal / PTY handoff

`TerminalHandoffAdapter` is the first-class component for exactly one bounded, consumer-owned PTY/session. It composes the already-proven Terminal authority machine with the DataChannel-only WebRTC transport; it does not introduce a second authority FSM, spawn shells, own cwd/env/job-control policy, supervise consumer processes, or persist a transcript.

The lifecycle is intentionally stronger than a generic byte tunnel. `begin()` fences Agent input/observation/resize before the consumer drains writes admitted before that fence. Human claim is allowed only after that drain and exact transport readiness. Ordered Human `Done` fences the Human transport before the event is exposed, then the consumer drains already-admitted Human writes before verification may succeed. Explicit resume retains `agentStateSynchronizationRequired`; Agent PTY operations remain fenced until the consumer discards/re-reads Human-period output and other PTY assumptions and acknowledges fresh state synchronization. Disconnect is not Done, PTY exit never synthesizes a replacement session, and Human-period output is never replayed to Agent.

CUMG now consumes only `TerminalHandoffAdapter`; its runtime and production staging no longer depend directly on `ExperimentalTerminalPtyAuthority` or `ExperimentalTerminalWebRtcTakeover`. CUMG retains PTY allocation, Unix descendant containment, process truth, bounded PTY I/O, and content-free verification. Merged Handoff/CUMG code passed real `/bin/cat` cross-repo WebRTC E2E and physical iPhone Human acceptance through the first-class adapter. The physical run used an external Cloudflare Tunnel with TURN configured, but the selected ICE pair was not recorded, so it must not be cited as proof that that specific Terminal run relayed through TURN. Issue #91 resolved the mobile status-display ambiguity: Safari now distinguishes transport readiness, waiting-for-Human-authority, Human-active, and verifying/failure states without weakening the backend authority lifecycle.

## Consequential actions

No generic approval API is coupled to handoff completion. A consumer that performs a consequential action must use a separate explicit approval mechanism bound to its exact final action and current state. Human completion is evidence only that the manual intervention step ended; it is never approval for a later action.
