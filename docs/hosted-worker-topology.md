# Hosted control plane / execution-worker topology

Status: v0.6.0 / Issue #12 contract in progress.

This contract separates a replaceable hosted Handoff control plane from a stateful execution worker without widening Browser, Window, Terminal, or Desktop authority.

## Worker registration boundary

The transport authenticates an outbound-capable worker channel first. Handoff core receives only:

- a bounded worker identity;
- the principal binding authorized for that worker;
- an opaque authenticated-channel binding;
- a Handoff-owned worker generation.

The channel binding is not a bearer credential. It stays process-local and is not returned by the registry or admitted into durable routing metadata.

`HostedWorkerRegistry` is the transport-neutral reference boundary. It does not implement HTTP, WSS, Cloud Run, a message bus, or another hosting vendor.

A worker identity is principal-pinned for the registry lifetime. A second concurrent channel for the same worker is rejected. After an explicit disconnect, reconnect increments the worker generation; a stale disconnect from an earlier channel cannot fence the successor.

## Authenticated outbound control channel

`HostedWorkerControlChannel` composes an already-authenticated deployment transport with the worker registry. The transport supplies the trusted worker id, principal binding, and opaque channel binding; peer messages are not allowed to assert or replace those identities.

The v1 control messages are deliberately content-free:

- `registered` returns only the Handoff-owned worker generation;
- `bind` names the intervention id, epoch, and worker generation;
- `revoke` names the intervention id, epoch, and worker generation.

Frames, Human input, credentials, target metadata, cookies, and provider details are not part of this control protocol.

Registration delivery failure fences the just-created worker generation. Bind delivery failure disconnects the worker and invalidates every route owned by that generation. Revoke fences the local route **before** remote notification, so a failed notification cannot restore control-plane routing authority. Provider-specific WSS, HTTP/2, overlay, message-bus, or other transport adapters may carry this protocol later without changing these authority semantics.

## Intervention routing

Every hosted route is bound to all of:

- intervention id;
- intervention epoch;
- principal binding;
- worker identity;
- current worker generation.

A stale worker generation fails closed. Worker disconnect immediately invalidates all routes owned by that generation.

The same intervention may explicitly reconnect to the same worker identity after transport loss, including at the same intervention epoch, but it cannot migrate to another worker identity. Worker replacement requires consumer-owned reissue/revalidation that creates a fresh intervention. This avoids treating a newer transport or lifecycle epoch as proof that a different execution session is equivalent.

## Data boundary

The worker registry admits bounded control-plane metadata only. It rejects extra fields so frame data, Human input, credential/token material, cookies, browser/application content, target identity, and arbitrary provider data cannot become route state.

Persistent browser profile, application session, OS session, framebuffer, and target content remain execution-worker concerns. They do not live in a disposable hosted control-plane instance.

## Relationship to existing Handoff state

The registry does not create a second mutation-authority FSM. Existing Handoff intervention / authority / checkpoint / recovery semantics remain authoritative.

Hosted worker routing is an additional delivery fence:

1. Handoff authority admits the Human operation.
2. The hosted route must still match principal, intervention, epoch, worker identity, and worker generation.
3. Worker/channel loss invalidates delivery.
4. Recovery never reconstructs stale Human or Agent authority from route metadata.
5. Agent execution resumes only through the existing consumer-owned semantic verification / reissue rules.

## Operator session / worker lifetime composition

`HostedOperatorRouteBinding` composes an already-authoritative operator/viewer session with one current worker route. It intentionally does not create a second operator-session state machine.

The lifetimes are independent:

- operator session TTL remains owned by the existing Handoff surface/session manager;
- viewer/client generation remains owned by that operator session;
- worker connection lifetime and worker generation remain owned by `HostedWorkerRegistry`.

A worker reconnect may rotate only worker generation; it cannot extend operator TTL or revive a stale viewer generation. A viewer reconnect may rotate only viewer generation; it cannot validate a stale worker route. The composed binding must be recreated after either generation changes and is revalidated against both current authoritative states.

The binding is process-local coordination state, not durable recovery state. It admits no frame, Human input, credential, cookie, target identity, provider detail, channel binding, or arbitrary content.

## Latest-only hosted frame delivery

`HostedLatestFrameBridge` provides process-memory-only frame delivery for hosted paths. It matches the existing WSS backpressure principle rather than building an unbounded relay queue.

- at most one frame send may be in flight;
- at most one pending frame is retained;
- a newer pending frame replaces the older one;
- explicit transport drain retries only the newest pending frame;
- operator/viewer and worker generations are revalidated immediately before every send;
- transport failure closes the bridge and discards pending frame data.

Frames are ephemeral and are never durable recovery/control state. Diagnostics expose only bounded counters/state and no session, intervention, principal, worker, credential, or frame content.

## Revocation propagation

`HostedWorkerControlChannel` may receive a bounded `routesInvalidated` hook that bridges hosted routing loss back into the existing operator/surface lifecycle without creating a second authority FSM.

The ordering is fail-closed:

1. local hosted route state is fenced first;
2. the bounded invalidation callback is invoked with route identity/generation metadata and an enum reason;
3. remote worker revoke/close notification proceeds independently;
4. callback or transport failure is surfaced explicitly and never restores the fenced route.

This covers explicit revoke, worker disconnect, bind-delivery failure, and revoke-delivery failure. The callback carries no frame, Human input, credential, cookie, target content, or provider secret.

## Hosted recovery boundary

Hosted restart recovery reuses the existing v0.3 checkpoint contract. `recoverHostedControlPlane()` projects a validated checkpoint into a bounded orchestration hint only:

- recovery remains `reissue_and_revalidate`;
- worker route is `reconnect_required`;
- operator session is `reissue_required`.

Worker identity/generation, authenticated channel binding, operator session id/viewer generation, locator/capability, frame/input state, target identity, credential/cookie data, and application/browser content are never restored from durable state. The restarted worker registry therefore begins empty and must accept a freshly authenticated worker connection before any hosted route can be issued.

## Generation-fenced hosted Human input

`HostedHumanInputBridge` and worker-side `HostedWorkerRouteGate` provide the hosted Human-input path without an automatic replay queue.

- the control plane revalidates operator/viewer generation and worker route immediately before dispatch;
- every input envelope carries intervention id, epoch, and worker generation;
- the worker gate independently rejects stale generation, stale epoch, or revoked routes;
- at most one input is in flight through the bridge; concurrent input fails closed instead of queuing;
- transport failure closes the bridge and the Human input is never retried automatically;
- input shapes are closed-world and bounded before delivery.

Worker/principal identity remains authenticated-channel context rather than peer-supplied message data.

## Lifecycle termination ordering

`HostedInterventionRouteLifecycle` composes the canonical `ExecutionHandoffState` with one hosted operator/worker binding. It is an ordering helper, not another authority FSM.

For every terminal Human-control path, hosted mutation routing is revoked **before** the canonical lifecycle may advance:

- **Done:** revoke the hosted route, then enter `verifying`; Human Done is not semantic success and Agent authority remains unavailable until explicit consumer verification.
- **Cancel:** revoke the hosted route, then cancel the canonical intervention; Agent authority is restored only after successful hosted revocation.
- **Operator-session expiry:** revoke the hosted route, then enter `verifying`; expiry never attests semantic success and still requires fresh verification before Agent resume.

If worker revoke delivery or invalidation propagation fails, the lifecycle transition is not performed. The canonical state therefore remains Human-active and Agent authority stays suspended even though local hosted route state has already been fenced. This is deliberately fail-closed.

## Worker-origin frame provenance

Worker-originated frames use a generation-scoped `HostedWorkerFrameEnvelope`. The worker-side route gate may create an envelope only for a currently bound intervention/epoch on its authenticated worker generation. The control-plane `HostedWorkerFrameIngress` then independently compares the envelope with the current operator/worker binding before forwarding it to the latest-only frame bridge.

The envelope never accepts worker identity, channel binding, provider identity, credential material, or target identity from peer data. A stale/revoked worker route or stale viewer generation therefore cannot deliver a frame even if a transport message arrives late.

## Deployment references

The same core contract supports three deployment shapes without changing authority semantics.

1. **Local-only**
   - control plane and execution worker may share one machine;
   - the worker channel may use loopback or a local IPC adapter;
   - browser/profile/application session state remains worker-owned.
2. **Hosted control plane + local worker**
   - public operator ingress / hosted control plane is separated from a private/local worker such as a Mac;
   - the worker initiates an authenticated outbound channel and requires no inbound public listener;
   - operator TTL, viewer generation, and worker generation remain independent.
3. **Hosted control plane + remote/stateful browser worker**
   - a stateful VM/container or equivalent worker owns the persistent browser/profile/application session;
   - disposable control-plane instances do not persist profile/session/frame/input content;
   - replacing a worker is never silent reassignment of a live intervention and requires fresh reissue/revalidation.

`experiments/hosted-worker-topology/acceptance.mjs` deterministically exercises the outbound-worker shape over a real WebSocket, including registration, generation fencing, frame/input delivery, disconnect/reconnect, and revocation. It is not a substitute for physical Cloud Run / Mac / remote-browser acceptance.

## v0.6.0 implementation / acceptance status

The provider-neutral core implementation is complete on the current candidate line:

- authenticated outbound worker registration/channel: `HostedWorkerRegistry` + `HostedWorkerControlChannel`;
- intervention/principal/worker generation fencing and duplicate ownership rejection;
- independent operator-session TTL, viewer generation, and worker connection generation;
- latest-only frame/backpressure semantics with no stale-frame queue;
- fail-closed route revocation propagation on explicit revoke, disconnect, and delivery failure;
- Done / Cancel / operator-session expiry ordering that revokes hosted routing before canonical lifecycle advancement;
- recovery projected only as `reissue_and_revalidate` hints with no stale authority restoration;
- generation-fenced Human input with no automatic replay;
- worker-origin frame provenance bound to intervention/epoch/worker generation;
- deterministic real-WebSocket topology acceptance via `npm run accept:hosted-topology:loopback`.

The deterministic acceptance is necessary evidence but is not the physical deployment gate. Issue #12 remains open only for exact-revision physical acceptance of:

1. hosted control plane + private/local Mac/browser worker with no inbound public worker listener;
2. hosted control plane + remote/stateful browser worker with the same authority/recovery semantics.

Those runs must record the exact Handoff/worker revisions and prove disconnect/reconnect, Done/Cancel/expiry revocation, stale generation rejection, and fresh consumer revalidation before Agent resume.
