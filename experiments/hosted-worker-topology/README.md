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


## Managed split deployment acceptance

The managed split harness goes beyond loopback by placing the Handoff control-plane process on a temporary Cloud Run service while the worker process runs on the physical macOS host and connects only outbound over WSS.

It uses an ephemeral Ed25519 keypair generated on the Mac. Only the public key is configured on the temporary control plane; the private key remains in a mode-0600 temporary local file and is deleted during cleanup. The service never receives a worker bearer secret.

Run:

    npm run accept:hosted-topology:managed-local-worker

The harness builds the exact Git revision, deploys a one-instance acceptance-only Cloud Run service, runs the macOS worker, verifies worker generation rotation, Human input, worker-origin frame delivery, stale worker/viewer rejection, explicit revoke and reissue-only recovery, then deletes the temporary Cloud Run service and exact acceptance image.

Success ends with:

    MANAGED_SPLIT_TOPOLOGY_ACCEPTANCE_OK

This is real hosted-control-plane + physical-Mac outbound-worker evidence. It still does not prove a real browser/profile worker, a remote/stateful browser VM, physical Human UI interaction, production IAM/secret rotation, or the complete consumer semantic verification lifecycle. Those remain separate physical acceptance gates.


## Managed remote/stateful browser-worker acceptance

The remote/stateful gate places the Handoff control plane on a temporary Cloud Run service and a Chromium-owning worker on a temporary GCE VM with **no external IP**. A temporary Cloud NAT supplies outbound-only Internet access; the worker publishes no container port and initiates only the authenticated WSS channel to the control plane.

The worker owns a dedicated Chromium profile on VM-local storage and keeps the same Chromium process/profile alive while the hosted worker channel disconnects and reconnects from generation 1 to generation 2. The worker reports only content-free booleans proving browser-process continuity, profile-marker continuity, Chromium readiness, and Linux worker shape.

Run:

    npm run accept:hosted-topology:managed-remote-stateful

Success ends with:

    MANAGED_REMOTE_STATEFUL_TOPOLOGY_ACCEPTANCE_OK

The harness deletes the temporary VM, Cloud Run service, Cloud NAT/router, exact acceptance images, and ephemeral authentication material during cleanup. It proves the #12 remote/stateful topology boundary; it does not turn Handoff into a browser-profile lifecycle owner or claim a new virtual/remote Desktop display backend.
