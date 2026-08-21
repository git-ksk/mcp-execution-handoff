# Security Policy

[日本語](SECURITY.ja.md)

## Supported security boundary

This project treats execution handoff and browser takeover as security-sensitive control-plane capabilities.

Reports are especially useful for:

- principal / invocation / argument binding bypass,
- Agent/Human authority overlap,
- stale epoch acceptance,
- checkpoint tampering or secret/content persistence,
- takeover capability leakage, replay, expiry, or revocation failures,
- one-client lease bypass, implicit reload/tab/device transfer, reconnect-handle replay/theft, or stale client-generation acceptance,
- CSP / origin / cache / referrer boundary regressions,
- any path where Human completion is interpreted as approval for a different consequential action,
- external Human session overlap with restored Agent/automation authority, cross-principal/epoch reuse, or sensitive provider metadata retention.
- WebRTC stale-generation revival, implicit background/foreground reconnect, legacy frame/input fallback, transport data leaking into logs/durable control-plane state, or unreviewed STUN/TURN trust-boundary changes.

## Non-goals that must remain non-goals

Do not add or report a missing feature for CAPTCHA/challenge solving, anti-bot bypass, stealth/fingerprint spoofing, proxy rotation, credential/OTP/MFA/payment-data transport through MCP, raw CDP exposure, arbitrary browser automation, or automatic replay/approval of consequential actions. Credential-safe external Human surfaces exist to leave an automation-incompatible credential surface, not to disguise automation as a supported login environment.

## Sensitive data

Never commit, log, persist in checkpoints, or place in public issues:

- passwords or authentication secrets,
- OAuth/session/access tokens,
- OTP/MFA/verification codes,
- CAPTCHA/challenge answers,
- cookies or browser-profile contents,
- payment-card or bank data,
- private endpoints or production credentials,
- raw Human input, framebuffer/video payloads, WebRTC key material, raw ICE candidate strings or network addresses, SDP containing sensitive deployment topology, or reconnect/capability secrets.

The direct-only browser peer does not contact STUN. The Node/werift peer explicitly uses Cloudflare STUN to avoid an implicit dependency default; this can expose server-side network metadata to Cloudflare and is therefore part of the reviewed transport trust boundary. Handoff diagnostics must never retain the resulting raw candidate/address data.

Checkpoint signing keys must be generated and stored outside the repository.

## Reporting

Use GitHub Private Vulnerability Reporting when enabled for this repository. If that mechanism is unavailable, do not post exploit details or secrets in a public issue; open a minimal public issue asking the maintainer for a private reporting channel.
