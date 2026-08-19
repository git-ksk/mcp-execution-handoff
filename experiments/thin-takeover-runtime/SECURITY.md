# Security model

Thin Takeover Runtime is a short-lived Human interaction data plane. It is not an authorization service and not a permanent remote-desktop daemon.

## Security invariants

1. Human and Agent input authority are mutually exclusive.
2. A media socket never grants Human authority.
3. Every transport binding is short-lived and scoped to session / intervention / epoch / principal / client generation / expiry by the control plane.
4. Stale epoch or generation material fails closed.
5. Expired local leases stop media admission/transmission and Human input injection; explicit revoke should stop them earlier.
6. `Done` and `Cancel` are control-plane operations. Human completion is not proof that authentication or another semantic action succeeded.
7. Agent resume requires revoke, epoch advancement, fresh attach, and fresh readiness/semantic verification.
8. Credential, OTP/MFA, passkey, cookie, token, typed text, and framebuffer contents are not durable control-plane artifacts.
9. No transport error may fall back to unauthenticated media or input.

## Transport protection

The runtime accepts a random 32-byte root key from the authority/control plane. It does not invent a key exchange protocol.

`TransportCipher` derives independent ChaCha20-Poly1305 keys with HKDF-SHA256 for each session/epoch/generation/direction/channel tuple. Video is sealed once per encoded frame before fragmentation. Input is sealed per event. Replay/deduplication is enforced independently at the input receiver.

The clear video packet header is routing metadata only. It is untrusted until the complete frame is reassembled and AEAD verification succeeds. Reassembly therefore has hard bounds on packet count and frame bytes and retains only the newest frame.

At host startup, the absolute control-plane expiry is converted once to a monotonic process-local deadline. This avoids extending a grant because of later wall-clock changes. Input binds to loopback by default; remote operation requires an explicitly configured local bind address.

## Threats explicitly addressed

- packet tampering / content injection;
- cross-epoch and cross-generation packet replay;
- host-to-client packet reflection into client-to-host channels;
- duplicate critical input injection;
- stale realtime input application;
- use of an already-expired runtime grant;
- transport continuing indefinitely after its expiry;
- unbounded frame reassembly allocation;
- reliable-video queue growth causing latency collapse;
- accidental unauthenticated fallback.

## Out of scope for the data plane

The embedding application must provide:

- principal authentication;
- capability issuance and authoritative expiry/revoke;
- intervention lifecycle;
- process/sandbox boundaries;
- NAT traversal / relay trust policy;
- OS permission UX;
- secure destruction/rotation of session keys;
- immediate authority revoke on Done/Cancel/disconnect/timeout according to product policy.

The local expiry lease is defense in depth; it does not replace authoritative control-plane revocation.

## Logging

Safe logs may contain aggregate latency, packet counts, codec names, frame sizes, and opaque non-secret generation numbers. Do not log root keys, plaintext input, text commits, framebuffer bytes, credential material, cookies, tokens, or full takeover URLs/capabilities.

## Reporting

While this code lives inside `mcp-execution-handoff`, follow the repository-level `SECURITY.md` reporting process. If it is later extracted, this security model should move with it unchanged unless the public contract changes.
