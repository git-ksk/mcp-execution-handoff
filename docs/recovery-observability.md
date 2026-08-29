# Recovery and observability boundary

This document defines the intended v0.3 boundary for **durable recovery, audit, and operator diagnostics** in `mcp-execution-handoff`.

v0.3 does not add a new Target Surface, Human-control authority class, transport, hosted database, or replay engine. It turns existing recovery/observability primitives into a production-grade contract while preserving the core rule:

> Durable state may describe what must be revalidated after a restart, but it must never restore stale Agent or Human authority.

The work is tracked by milestone `v0.3 — Recovery & Observability`:

- #127 — provider-neutral bounded checkpoint-store contract;
- #128 — stable privacy-bounded audit events;
- #129 — stable operator diagnostics across Target Surfaces;
- #130 — crash/restart conformance without stale authority restoration.

## Existing baseline

The current source already contains useful pieces:

- `SignedFileHandoffCheckpointStore` writes HMAC-protected, private-permission local checkpoints;
- `ExecutionHandoffRuntime` persists bounded intervention metadata and recovers only as `reissue_and_revalidate`;
- `ExecutionAuditSink` receives small control-plane events for checkpoint/recovery operations;
- Browser/Window WebRTC expose bounded stage/state/count/timing diagnostics with explicit privacy tests;
- Browser, Window, and Terminal keep media, input, PTY bytes, credentials, and target-service content outside generic durable state.

v0.3 should generalize and stabilize these boundaries rather than replace their safety model.

## Three different data paths

Checkpoint, audit, and diagnostics are deliberately separate concepts.

| Path | Primary purpose | Default lifetime | May restore authority? | Content rule |
| --- | --- | --- | --- | --- |
| Durable checkpoint | Restart/revalidation hint | Durable, TTL-bounded | **No** | Small Handoff control-plane record only |
| Audit event | Operator/compliance integration for generic lifecycle metadata | Sink-defined | **No** | Stable bounded metadata projection only |
| Diagnostics | Troubleshooting/health/acceptance evidence | Process-memory by default | **No** | Bounded categorical/count/timing data only |

A consumer may persist an allowed diagnostics projection through its own operator system, but doing so does not turn diagnostics into a checkpoint or recovery authority source.

## Durable checkpoint contract

The current checkpoint schema is the baseline allowed durable shape:

- schema version;
- adapter kind;
- intervention id/status;
- resource epoch;
- resume policy;
- stable non-secret principal binding;
- optional action digest;
- update timestamp;
- expiry.

`HandoffCheckpointStore` is the provider-neutral persistence boundary. It is deliberately synchronous and contains only `write(checkpoint)`, `read()`, and `clear()`. `read()` returns `unknown`: a backend is a persistence mechanism, not a schema or recovery-authority provider. `ExecutionHandoffRuntime` strictly reparses every returned value, rejects extra fields, enforces expiry with its own clock, and then applies adapter/principal binding before returning only `reissue_and_revalidate`.

`SignedFileHandoffCheckpointStore` implements this interface and remains the local reference implementation. Its existing `load()`, `recover()`, and operator-revalidation helpers remain available for source compatibility; the runtime itself depends only on the provider-neutral interface.

### Storage failure semantics

The checkpoint-store contract is synchronous on purpose. A successful method return means that storage operation completed according to the provider's own durability contract; a thrown error means it did not. v0.3 does not silently reinterpret an asynchronous or best-effort write as durable fencing.

- active-intervention `write()` failure is propagated **and** the runtime cancels/fences that Human intervention, preserving the existing fail-closed behavior;
- `read()` failure or malformed/expired data is propagated/fails closed and never restores any authority;
- `clear()` failure is propagated rather than reported as success. Explicit clear is not itself an authority transition, so the adapter's current authority state is left unchanged while the caller handles the durable-state cleanup failure;
- a future async store would require a distinct lifecycle contract defining awaited write/clear completion, crash points, cancellation, and sink failure semantics before it could be accepted here.

### Forbidden generic durable content

The generic checkpoint/audit/diagnostics APIs must not become a path for:

- raw tool/action arguments;
- Human input or entered text;
- browser/page/DOM/network content;
- framebuffer, screenshots, video, or audio;
- PTY input/output/transcript content;
- credentials, passwords, cookies, bearer/session tokens, private keys;
- OTP/MFA/challenge answers;
- payment data;
- consumer approval receipts or domain-specific consequential-action evidence;
- live takeover capabilities, reconnect handles, requestState, client generations, ICE/SDP/key material, or equivalent transport secrets.

Consumer-specific state that is genuinely required for the consumer application remains consumer-owned and is not made safe merely by placing it behind a Handoff storage interface.

## Restart authority model

A restart must be treated as a loss of ephemeral execution authority, not as a transparent continuation.

```text
active intervention
        |
        | process/consumer crash
        v
all ephemeral mutation authority lost
        |
        | load + validate bounded checkpoint
        v
recovery record: reissue_and_revalidate
        |
        +--> principal / adapter / integrity / expiry mismatch --> fail closed
        |
        v
consumer reconstructs fresh target/session state
        |
        v
consumer revalidates semantic/postcondition state
        |
        +--> cancel / start a fresh Human round / reissue safely
        |
        v
fresh authority only through the normal lifecycle
```

The checkpoint can tell an operator or consumer that an intervention existed and which bounded resume policy applied. It cannot:

- reclaim a pre-crash Human lease;
- revive Agent mutation authority;
- recreate a browser/window/desktop/PTY session;
- revive a takeover locator/capability or reconnect generation;
- replay an interrupted action;
- skip consumer semantic verification.

### Deterministic restart conformance matrix

#130 freezes the restart boundary with first-class deterministic tests. A process restart is modeled by discarding every in-memory authority/transport object and constructing a fresh adapter/runtime with only the durable checkpoint store retained. No target/session object is copied across that boundary.

| Crash / loss point | State allowed to survive | Restart outcome | Required next step |
| --- | --- | --- | --- |
| `awaiting_human` | bounded checkpoint only | no intervention or Human lease is reconstructed | reconstruct the consumer target/session, then cancel or start a fresh Human round |
| `human_active` | bounded checkpoint only | old Human authority and transport are gone | re-read target state and start a fresh Human round only if still required |
| `verifying` | bounded checkpoint only | no pre-crash verification authority is restored | perform fresh consumer semantic/postcondition verification |
| `ready_to_resume` before reissue | bounded checkpoint only | no automatic Agent resume or action replay | revalidate and explicitly reissue through the normal lifecycle |
| Browser / Window locator, capability, generation, reconnect handle | none of these are durable | old page/capability/reconnect requests are rejected after restart | create a fresh first-class adapter session and locator after revalidation |
| Terminal Human-active consumer restart | no PTY bytes, queue, locator, or transport authority | a fresh PTY/session generation has no old intervention/transport and cannot read old queued Human input | reconstruct a fresh consumer-owned PTY/session and synchronize state before Agent use |
| Terminal PTY/process exit while Human is active | no replacement PTY is synthesized | authority becomes `none`, lifecycle enters `verifying`, session is dead | verify/cancel from the dead-session state; never restore Agent/Human input to that PTY |
| tamper / expiry / principal mismatch / adapter mismatch | rejected bounded metadata only | recovery fails closed or returns no record | investigate or begin a fresh lifecycle; never weaken validation |
| checkpoint write interruption | no partially trusted recovery record | active intervention is cancelled/fenced before the write error escapes | reconstruct and revalidate from fresh consumer state |

The conformance fixture also queues Human Terminal input immediately before the simulated restart and proves that the fresh adapter cannot retrieve it. Human-period bytes are therefore not replayed to Agent through generic recovery.

### Operator guidance after a restart

1. Treat `recover()` as a **hint**, never as permission to call resume or mutate the target. It does not recreate an active intervention.
2. Reconstruct the target/session through the consumer's normal ownership path. Browser/Window must issue a fresh locator/capability generation; Terminal must use a fresh consumer-owned PTY/session generation.
3. Re-read the target's current semantic/postcondition state. A pre-crash `Done`, `verifying`, or `ready_to_resume` checkpoint is not proof that the intended action completed.
4. If identity, ownership, target state, or postcondition is unknown/changed/ambiguous, fail closed: cancel the recovered work or start a fresh Human round instead of replaying it.
5. For Terminal, discard/re-read Human-period state and acknowledge the normal Agent-state synchronization boundary before Agent input/observation/resize. Never replay queued Human input/output from the old process.
6. Clear the checkpoint only after the consumer has deliberately resolved the recovered work; audit/diagnostic snapshots remain observability data and are never recovery authority.

## Audit boundary

Audit is a durable-friendly **generic control-plane event stream**, not an execution transcript. v0.3 stabilizes schema **version 1** with the existing event names `checkpoint_written`, `checkpoint_cleared`, and `recovery_requested`. Every emitted event now carries `version: 1`; the event-name strings remain source-compatible with the pre-v0.3 baseline, while consumers that construct audit records directly must migrate to the versioned shape.

The v1 union is intentionally narrow:

- common fields: schema version, enumerated event type, bounded adapter kind, non-negative integer timestamp;
- checkpoint/recovery events may additionally carry bounded intervention id, epoch, stable non-secret principal binding, and optional action digest where that field already exists in the checkpoint contract;
- no free-form message, reason, payload, target identity, transport identity, or consumer-domain object is admitted;
- strict parsing rejects extra fields and oversized/newline-bearing identifiers rather than silently serializing them.

`ExecutionAuditSink.record()` remains synchronous. Audit is **observe-only**: sink success is not proof of semantic verification, approval, or authority state, and sink failure must not grant/revoke/restore authority or change checkpoint/recovery success. `ExecutionHandoffRuntime` catches sink exceptions for all v1 event classes and may report only `{ version, eventType }` through the optional bounded `onAuditSinkFailure` callback. Failure reporting errors are also contained. The core does not create an unbounded retry/backpressure queue. A production sink that exports asynchronously must place that behavior behind its own bounded queue/durability contract and return or throw promptly from `record()`.

`MemoryExecutionAuditSink` remains the simple test/reference sink and retains only the newest 256 strictly validated events. `NOOP_EXECUTION_AUDIT` remains supported.

Human completion is deliberately **not** represented as approval of a consequential action. Consumer business events, authentication facts, payment approval records, and target-service audit requirements remain outside the generic library contract. Browser, Window, and Terminal can all use the same v1 audit sink without exposing media, input, PTY bytes, process/window identity, or target-service content.

### Forbidden audit content

The v1 parser structurally rejects extra fields that could become a path for raw action arguments, Human input, PTY/browser/page content, framebuffer/media, credentials/cookies/tokens, OTP/MFA/challenge answers, payment data, approval receipts, takeover capabilities/requestState/reconnect state, SDP/candidates/IP addresses, or free-form execution messages.

## Operator diagnostics boundary

Diagnostics are optimized for troubleshooting and acceptance, not durable reconstruction. v0.3 stabilizes a **version 1 operator summary** through `OperatorDiagnosticsSnapshot` and `operatorDiagnosticsSnapshot()` on the first-class Browser, Window, and Terminal adapters.

The stable v1 envelope is deliberately identifier-free:

- `version: 1`;
- diagnostic source only: `browser_handoff`, `window_handoff`, or `terminal_handoff`. These values identify the diagnostics producer and **do not freeze a public Target Surface semantic enum**;
- generic health only: `idle`, `starting`, `available`, `degraded`, or `failed`;
- optional bounded failure category: `target`, `transport`, `input`, or `recovery`;
- Terminal only, because it genuinely owns this state: bounded execution authority and intervention phase;
- target/transport-specific detail stays in explicit namespaces instead of being flattened into false parity.

### Namespaced projections

Browser and Window use a `webrtc` transport projection containing only:

- validated event count, capped at 128;
- the latest bounded peer state when present;
- aggregate ICE candidate **type counts** only, each capped at 64.

No detailed WebRTC stage string, duration series, media profile, latency sample, provider name, candidate/address, or target identity is copied into the stable operator summary. The existing `diagnosticsSnapshot()` and `latencySnapshot()` APIs remain unchanged for transport-specific troubleshooting and physical acceptance; #129 adds a stable projection rather than replacing those detailed APIs.

Terminal uses two target-specific namespaces:

- `terminal_session`: session alive, Human disconnected, and Agent-state synchronization-required booleans;
- `terminal_webrtc`: ready/disconnected/completed/faulted booleans plus queued-event count, bounded to the existing 64-item transport limit.

Terminal `sessionId`, session generation, intervention epoch/id, principal binding, PTY bytes, and client generation are not exported. Browser/Window operator summaries intentionally do not invent execution-authority or lifecycle fields because those facades do not own the generic execution state machine.

### Managed Browser/Window takeover diagnostics

Managed direct WebRTC -> WebSocket relay -> optional WebRTC relay troubleshooting has a separate stable, strict schema: `ManagedOperatorDiagnosticsSnapshot`. Browser and Window expose it through the same `managedOperatorDiagnosticsSnapshot()` method. This keeps managed transport detail out of the closed-world generic operator v1 envelope while avoiding consumer-specific diagnostic contracts. When managed fallback is disabled, the method returns the same schema with `idle` / `none` values.

The managed snapshot contains only bounded control-plane facts: current and previous transport, generation and transition count, fallback reason, WSS channel state/failure/disconnect class, observed/sent/dropped frame counts, exact-window surface failure, input attempt/stage/boundary stage, helper stop/crash/exit classifications, exact-window authority boundary (`valid` or `lost`), and WSS session disposition (`none`, `retained`, or `revoked`). A bounded 64-event history may contain only enumerated events for transport transition, WSS open/degraded/failed, capture recovery, input dispatch failure, helper restart, authority loss, and session retained/revoked.

`parseManagedOperatorDiagnosticsSnapshot()` is closed-world: unknown fields, free-form reasons, oversized counters, or unrecognized enum values fail validation. The schema has no field for credentials, MFA/OTP/passkey material, cookies/tokens/capabilities, Human input text, framebuffer/browser content, PID/window identity, principal/intervention/session identity, IP/ICE/SDP/TURN credentials, account identity, timestamps, or arbitrary messages. Diagnostic events are process-memory evidence only and cannot restore or widen authority. Exact-window ownership/visibility/geometry/target loss remains fail-closed, and failed Human input is never replayed by diagnostics.

For physical acceptance, capture this same snapshot at four boundaries: before takeover, after managed fallback, immediately after failure, and after completion. The failure snapshot is the decision point for recovery work: do not infer an input-recovery fix from `Session unavailable` alone.

### Privacy, boundedness, and compatibility

`parseOperatorDiagnosticsSnapshot()` is the strict v1 validator. It rejects extra fields, false-parity fields, oversized counts, and any attempted path for session/intervention/principal ids, PID/window identity, credentials/tokens, SDP/candidates/IPs, framebuffer/media, Human input, PTY/browser/page content, account identity, capability, timestamp, or free-form message payloads.

The stable v1 parser is intentionally closed-world. Renaming/removing a field, adding a new root/namespace field, or changing an enum meaning requires a new schema version rather than silently widening v1. Existing transport-local diagnostics may continue to evolve inside their own typed APIs, but only the explicit v1 projection is the stable cross-surface operator contract.

Operator summaries are process-memory snapshots by default. Persisting one does not make it recovery state: it must never be replayed to recreate authority, locators/capabilities, client generations, media/input sessions, PTY authority, or semantic verification. If an operator system persists diagnostics, it should persist only a value that passes the stable parser (or another separately reviewed allowed projection). #128 audit remains a distinct event contract and is not an execution transcript or a generic diagnostics store.
