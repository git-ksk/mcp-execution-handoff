## Summary

## Contract / security impact

- [ ] No Maps/Cinema/provider-specific concept was added to generic core.
- [ ] Principal/invocation binding and resource-epoch fencing are preserved.
- [ ] Browser takeover remains locator-only, short-lived, one-client, and memory-bound.
- [ ] Human completion is not treated as approval for another action.
- [ ] No stateful/consequential action becomes automatic replay without an explicit safety basis.
- [ ] No secrets, credentials, OTP/MFA, payment data, challenge answers, or private endpoints are included.

## Validation

- [ ] `npm run check`
- [ ] `npm run build`
- [ ] `npm audit --audit-level=moderate`
