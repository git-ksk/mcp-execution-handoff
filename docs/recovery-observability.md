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

A future provider-neutral store may change the storage mechanism, but not this trust boundary. Schema validation stays Handoff-owned. A storage backend is not allowed to return arbitrary consumer content and have the runtime treat it as trusted recovery state.

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

## Audit boundary

Audit is a durable-friendly **generic control-plane event stream**, not an execution transcript.

Candidate stable event families include:

- intervention lifecycle transitions;
- authority claim/revoke/expiry outcomes;
- checkpoint written/cleared/recovery requested;
- generic verification/resume-policy outcomes;
- bounded failure categories.

Before v0.3 freezes names or shapes, #128 must define:

- event schema/versioning and compatibility rules;
- bounded field sizes/cardinality;
- which identifiers/digests are acceptable durable metadata;
- sink failure/backpressure behavior;
- privacy tests proving sensitive execution content is structurally excluded.

Consumer business events, authentication facts, payment approval records, and target-service audit requirements remain outside the generic library contract.

## Operator diagnostics boundary

Diagnostics are optimized for troubleshooting and acceptance, not durable reconstruction. Existing WebRTC diagnostics already demonstrate the preferred style:

- finite categorical stage/state values;
- bounded candidate-type counts rather than candidate/address strings;
- bounded durations/latency distributions;
- bounded event buffers;
- no target/session/principal/network/content payloads.

#129 should expose genuinely shared lifecycle/authority/failure categories across Browser, Window, and Terminal while leaving target- or transport-specific detail in its own namespace. v0.3 must not manufacture false parity merely to create one giant generic diagnostics object.

Process-memory remains the default retention model for diagnostics. If an operator persists a projection, only fields explicitly admitted by the stable operator contract should be exported.

## Crash/restart conformance gate

#130 is the v0.3 release gate for the recovery model. At minimum, deterministic tests must cover crashes while:

1. `awaiting_human`;
2. `human_active`;
3. `verifying`;
4. `ready_to_resume` before consumer reissue;
5. a Browser/Window locator or capability exists;
6. a reconnect generation/handle exists;
7. Terminal Human authority exists or its PTY/process exits;
8. a checkpoint is interrupted, expired, tampered, or principal/adapter mismatched.

For every case, stale mutation authority must remain unavailable after restart. Browser, Window, and Terminal should require fresh consumer-owned target/session reconstruction where applicable.

## v0.3 sequencing

Recommended implementation order:

1. **#127 checkpoint-store contract** — establish the durable interface and failure semantics first;
2. **#128 audit contract** and **#129 diagnostics contract** — may proceed in parallel once their boundaries reference the same data-classification rules;
3. **#130 crash/restart conformance** — closes only after the other contracts are concrete enough to test as a release-level invariant.

## v0.3 exit criteria

v0.3 is ready when:

- a provider-neutral checkpoint-store interface exists without widening the durable schema;
- the signed-file store remains a supported reference implementation;
- audit events have a versioned, bounded, privacy-reviewed contract;
- operator diagnostics have stable shared categories while target/transport-specific detail remains scoped;
- crash/restart conformance proves stale authority, capabilities, request state, media/input sessions, and PTY authority are not restored;
- recovery remains `reissue_and_revalidate` and consumer semantic verification remains mandatory;
- Browser, Window, and Terminal established integrations remain green.

## Explicit non-goals for v0.3

- Desktop Handoff (#125);
- provider-neutral TURN/connectivity productization (#19);
- hosted control plane / execution workers (#12);
- distributed database or queue selection;
- transparent live migration of a Human session;
- browser/profile/PTY/media restoration;
- automatic action replay;
- credential vaulting;
- mandatory OpenTelemetry/SIEM/vendor integration.

Those capabilities may use the v0.3 contracts later, but they do not belong inside the v0.3 authority or persistence boundary.
