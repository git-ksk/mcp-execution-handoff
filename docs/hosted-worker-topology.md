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

## Next v0.6.0 slices

The remaining #12 work builds on this boundary:

- authenticated outbound worker channel protocol;
- operator-session TTL independent from worker connection lifetime;
- latest-frame/backpressure semantics with no stale-frame queue;
- disconnect/reconnect and revocation propagation through the real hosted channel;
- bounded durable hosted metadata using existing recovery rules;
- local-worker and remote/stateful-worker deployment references and acceptance.
