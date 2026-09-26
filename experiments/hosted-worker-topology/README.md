# Hosted worker topology acceptance

This experiment is the deterministic network acceptance for the v0.6.0 hosted control-plane / execution-worker contract.

It runs one loopback control-plane listener and connects the execution worker **outbound** with a real WebSocket client. The worker never starts an inbound listener.

The acceptance proves, on the exact repository revision under test:

- transport authentication is resolved before worker identity/principal enter Handoff;
- each accepted socket receives a fresh process-local channel binding;
- duplicate ownership of one worker identity fails closed;
- the same worker identity cannot reconnect under a different principal;
- one intervention cannot silently move to another worker identity;
- worker reconnect advances worker generation;
- the existing operator-session manager supplies a separate viewer generation and TTL;
- Human input crosses the real socket only after control-plane and worker-side generation checks;
- worker-origin frames cross the real socket only after worker-side route admission and control-plane provenance validation;
- stale worker frames, stale operator bindings, and revoked routes cannot deliver;
- abrupt worker disconnect invalidates current routing without meaning Human Done;
- explicit revoke reaches the worker after local control-plane fencing;
- restart recovery requires worker reconnect and operator-session reissue.

The transport adapter uses ephemeral in-memory authentication material and bounded acknowledgement identifiers. It does not print or persist authentication material, frame bytes, or Human input.

## Scope limitation

This is a deterministic topology/conformance gate, not physical hosted acceptance. It does **not** prove Cloud Run lifecycle behavior, Internet/NAT behavior, a physical Mac worker, a remote stateful browser VM, provider IAM, or production secret rotation. Those remain revision-scoped deployment acceptance for Issue #12 and its consumers.

Run:

    npm run accept:hosted-topology:loopback

Success ends with:

    HOSTED_TOPOLOGY_ACCEPTANCE_OK
