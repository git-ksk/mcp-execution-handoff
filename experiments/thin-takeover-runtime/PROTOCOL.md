# Thin Takeover Runtime wire contract v1

This document describes the experimental v1 data plane. It is intentionally narrower than a general remote-desktop protocol.

## Authority model

The data plane never grants authority. A control plane must first grant Human authority and provide a short-lived binding containing at least:

- principal;
- intervention identifier;
- epoch;
- client generation;
- absolute expiry;
- short-lived 32-byte root transport key.

The runtime receives only the derived runtime binding. `Done`, `Cancel`, revoke, approval, and Agent resume remain control-plane operations and MUST NOT be inferred from a media/input packet.

Agent and Human input authority are mutually exclusive. Agent resume requires Human revoke, epoch advancement, fresh automation attach, and fresh semantic readiness verification.

The host converts the absolute control-plane expiry to a process-local monotonic deadline at startup. Media admission, media transmission and input injection must all fail closed after that deadline. Explicit Done/Cancel/revoke should revoke the local lease immediately instead of waiting for expiry.

## Cryptographic binding

`TransportCipher` uses ChaCha20-Poly1305. The control plane supplies a random 32-byte root key. HKDF-SHA256 derives separate keys for each:

`sessionHash / epoch / generation / direction / channel`

The per-derived-key sequence number is the AEAD nonce. A sequence MUST NOT repeat inside one derived context.

Channels are:

1. video;
2. realtime input;
3. critical input;
4. control (reserved; durable authority changes stay outside UDP).

Video is encrypted once per complete encoded frame or decoder-configuration blob, then the authenticated ciphertext is fragmented into MTU-bounded datagrams. This keeps AEAD work proportional to frames rather than packets. Packet headers are pre-authentication routing metadata; receiver allocation must therefore remain bounded. The complete reassembled frame is not trusted until AEAD verification succeeds.

## Video datagrams

`VideoPacketHeader` is a fixed 56-byte network-byte-order header containing:

- magic/version;
- flags;
- session hash;
- epoch;
- generation;
- frame ID;
- packet index/count;
- capture timestamp;
- encode-complete timestamp.

Default datagram size is 1200 bytes to avoid common-path IP fragmentation.

Receiver policy is newest-frame-wins. Only bounded reassembly state is kept. A newer frame abandons an older incomplete frame. Ordinary delta-frame loss is not retransmitted.

### Decoder-critical recovery

For an incomplete keyframe, a receiver may request a small number of missing packets only until a short frame deadline. After that deadline it requests a new IDR. IDR requests are rate-limited. No path permits unbounded retransmission or a growing reliable video queue.

## Input datagrams

Input uses two lanes:

- `realtime`: pointer movement and other replaceable state. Newest sequence wins; old/replayed events are dropped.
- `critical`: pointer buttons, keys, and text commits. A 64-sequence receiver replay window permits bounded retry while preventing double injection.

Each secure input datagram exposes only lane + sequence for nonce/routing and encrypts the binary `InputEvent` with a lane-specific client-to-host AEAD key.

Suggested field semantics:

- pointer coordinates: normalized integer range `0...1_000_000`;
- pointer button: `value=1` down, `value=0` up; payload may identify button;
- scroll: x/y carry signed deltas;
- key: x carries platform key code, `value=1` down / `0` up;
- text commit: UTF-8 payload.

Adapters may define stricter platform mappings, but MUST validate event kind/lane and bounds before OS injection.

## Reconnect

Reconnect does not reuse stale authority. A reconnect must re-authenticate to the control plane and recover the currently valid intervention/epoch/generation/expiry binding. Old generation keys and packets cannot reclaim a newer session. A reconnect after expiry requires a fresh control-plane grant rather than extending the old local lease.

## Credentials

Credential, OTP/MFA, passkey, cookie, token, framebuffer, and typed text material are ephemeral Human-plane data. They MUST NOT be returned to MCP/model context, argv, durable checkpoints, analytics, or ordinary logs.
