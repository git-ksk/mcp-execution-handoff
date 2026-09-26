# Provider-neutral WebRTC connectivity

Status: v0.5.0 contract for Issue #19.

Handoff owns WebRTC discovery, relay-provider selection, relay credentials, fallback policy, and bounded transport diagnostics. Browser, Window, Terminal, and MCP consumers keep the existing lifecycle API and do not select ICE/STUN/TURN providers.

## Ingress and relay are separate

Hosted HTTPS ingress carries Handoff signaling/control traffic. WebRTC direct/TURN carries the Human-to-worker data plane. An ingress choice such as Cloudflare Tunnel is never the TURN abstraction, and TURN remains usable with another ingress or no hosted ingress.

## Direct discovery policy

The browser direct attempt stays host-candidate-only. Handoff always gives the server peer an explicit ICE-server list so a WebRTC dependency cannot silently choose a third party.

For compatibility, the reviewed default remains `stun:stun.cloudflare.com:3478`. This is a compatibility default, not a consumer contract. A deployment can replace it with credential-free STUN/STUNS endpoints through:

`MCP_HANDOFF_WEBRTC_DIRECT_STUN_URLS`

Only bounded `stun:` / `stuns:` URLs are accepted. TURN URLs, credentials, paths, invalid ports, and query parameters fail closed.

## Relay provider boundary

`WebRtcIceCredentialProvider` is the provider-neutral internal issuance/revoke seam. Provider selection is resolved once inside Handoff.

Current implementations are Cloudflare Realtime TURN and coturn TURN REST. Existing provider-specific environment names remain deployment compatibility inputs, not consumer API. Configuring multiple relay providers fails closed; Handoff never silently crosses to another vendor after a provider failure.

Provider credentials remain Handoff-owned, generation-bounded, and in memory. They do not enter MCP arguments/results, model context, consumer settings, locator URLs, argv, generic logs, durable checkpoints, frames, or Human-input records.

When optional relay issuance fails, Handoff records only a bounded content-free reason, keeps the reviewed direct path with relay marked unavailable, and does not treat transport failure as Human completion or Agent replay/resume authority.

## Consumer contract

Consumers receive no provider enum, STUN/TURN URL, candidate policy, credential, or failover control. Managed transport order remains Handoff-owned and finite. Direct WebRTC, WSS, and relay-capable WebRTC keep independent generation fencing, revoke semantics, and no Human-input replay across attempts.

## Evidence

Deterministic tests cover central provider selection, direct STUN override, conflicting/partial configuration, bounded Cloudflare failure reasons, coturn credential generation, direct fallback, generation fencing, revoke, and no-replay behavior.

The self-hosted path also has a real relay acceptance:

`npm run accept:webrtc:coturn-relay`

The harness uses digest-pinned coturn and Node images on an isolated Docker network with no host TURN port, resolves coturn through the same Handoff-owned environment seam, forces relay-only ICE, requires relay candidates on both peers, connects, and transfers a DataChannel message before `COTURN_RELAY_ACCEPTANCE_PASS`.

Issue #12 owns the later hosted worker/control-plane topology and must consume this boundary rather than redefine provider connectivity.
