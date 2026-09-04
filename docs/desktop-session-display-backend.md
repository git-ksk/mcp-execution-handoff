# Desktop Session / Display Backend boundary

[日本語](desktop-session-display-backend.ja.md)

Issue #161 introduces a deliberately small **internal** boundary for v0.4.x. It does not add a
Desktop Target Surface, a public package subpath, a virtual/remote desktop implementation, or a new
Human authority. The purpose is to stop transport/viewer lifecycle from being treated as if it were
the OS/application session itself.

## Distinct concepts

| Concept | Owns | Does not own |
| --- | --- | --- |
| **Desktop Session** | persistent application/session continuity as observed by Handoff; one stable physical display binding during the current v0.4.x implementation | transport generation, viewer URL, semantic success, Desktop-wide mutation authority |
| **Display Backend** | how the existing authorized surface is presented by the host; v0.4.1 has only the existing `physical` backend | Human authority, transport choice, consumer authentication state |
| **Target Surface** | the already-reviewed mutation scope, currently the bounded Window contract | whole Desktop merely because a display exists |
| **Human Viewer** | fit/actual-size/adaptive presentation, zoom/pan and one current viewer generation | OS display/session lifetime, authority restoration, semantic verification |
| **Transport** | WebRTC/WSS delivery, reconnect/fallback, transport generation/capability fencing | application-session identity, display resize policy, Target Surface widening |
| **Authority** | Agent/Human exclusivity, principal/intervention/epoch/client-generation fencing, revoke/expiry/Done semantics | viewer presentation or backend implementation details |

The important consequence is that a WebRTC -> WSS -> relay-capable WebRTC transition may rotate the
**Human viewer attachment generation** while the **Desktop Session + physical display backend** remain
the same. This attachment generation is intentionally separate from the existing transport/client
generation used for capability and reconnect fencing; an internal WebRTC reconnect does not recreate
the Desktop Session or silently rotate authority. Disconnect or transport fallback therefore never
means that the application session was destroyed or recreated.

## v0.4.1 implementation boundary

The first increment is intentionally conservative:

- the backend-neutral descriptor can name `physical`, `virtual`, or `remote_session` capability
  classes, but v0.4.1 implements/factories only `physical`;
- `DesktopSessionDisplayBoundary` is internal and is not exported from the package surface;
- only the first-class **Window** facade opts in; Browser and Terminal keep their existing semantics;
- the current physical bounded-Window path is the only concrete display backend;
- direct Window Handoff uses one viewer generation for the intervention;
- managed Window transport fallback detaches the old viewer generation before attaching the next
  generation, while the same Desktop Session/display boundary remains active;
- final revoke/verified completion closes only Handoff's boundary object; it does **not** terminate
  the consumer-owned OS/application process/session;
- implicit retargeting of the same boundary fails closed;
- no input is replayed across viewer/transport generations.

The runtime's internal snapshot is deliberately content-free: lifecycle, backend kind, whether a
viewer/display is attached, the numeric viewer generation, and the two backend capability booleans.
It contains no PID/window id, principal, intervention/session id, locator, credential, framebuffer or
Human input.

## Viewer scaling versus display resize

These are separate capabilities.

Current physical backend capabilities are:

```text
viewer_scaling: true
dynamic_display_resize: false
```

Viewer modes are represented independently:

```text
fit | actual_size | adaptive
```

For the physical backend, all three remain **viewer-side** presentation choices. `adaptive` does not
change monitor resolution or mutate the target Window. Fit/zoom/pan geometry is resolved locally and
viewer coordinates are mapped back into normalized coordinates on the already-authorized bounded
surface. A point outside that rendered surface is rejected.

A request to dynamically resize the physical display fails closed with
`DESKTOP_DISPLAY_RESIZE_UNSUPPORTED`. A future backend may advertise dynamic resize only after its OS
session semantics and authority effects are separately designed and physically accepted.

## Lifecycle and stale-generation fencing

```text
Desktop Session active
  + physical display attached
  + viewer generation N active
        |
        | transport fallback / reconnect boundary
        v
  viewer generation N detached
  Desktop Session + display stay active
        |
        v
  viewer generation N+1 attached
        |
        | revoke / verified terminal close
        v
Desktop Session Handoff boundary closed
```

A viewer generation must increase monotonically. Reusing an old generation, detaching a stale
attachment, or attaching another viewer while one is active fails closed. Viewer detach is
idempotent for authority/transport cleanup and never creates a replacement session.

## Platform semantics are not normalized

This abstraction deliberately does **not** claim one cross-platform OS-session model.

- **macOS:** current evidence remains the existing bounded physical Window path, including reviewed
  secure-Window/successor behavior. #161 does not introduce Screen Sharing, a virtual display, or a
  generic desktop session API.
- **Linux:** current evidence remains the existing exact X11 Window/runtime path. A future headless or
  virtual-display backend must define whether the application session survives display attachment
  changes rather than inheriting an assumption from another OS.
- **Windows:** #161 does not encode RDP session switching, console-session behavior, or virtual-display
  semantics as a generic invariant. Any Windows backend proof must document those semantics itself.

CUA and other GUI drivers remain replaceable execution mechanisms. They are not required to own the
Desktop Session/Display Backend lifecycle or implement Handoff-specific virtual-display behavior.

## Security invariants

This boundary does not weaken the existing contract:

- no silent Window -> Desktop fallback;
- no Desktop authority is introduced by #161;
- Agent/Human mutation authority stays mutually exclusive;
- stale locator/capability/epoch/client/viewer generations fail closed;
- disconnect is not Done;
- Human input is never replayed;
- Done remains lifecycle completion, not authentication/approval/semantic success;
- credentials, secure/Human text, framebuffer/browser content and remote-session secrets stay out of
  generic audit/checkpoint/diagnostic state.

## Follow-up backends

Virtual display and remote-session implementations are intentionally **not** part of #161/v0.4.1.
Once this boundary is stable, each backend proof should be a separate issue with platform-specific
session/lifecycle semantics, resize capability, physical/deterministic acceptance and explicit
failure behavior. Explicit Human-only Desktop authority remains #125 and is sequenced after this
boundary; a backend implementation must never become a hidden route around that authority review.
