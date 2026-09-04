# Product readiness and consumer compatibility

This document defines Handoff's **Product Readiness** track. It is intentionally separate from
transport maturity, hosted topology, and npm publication. A transport can be technically mature
without the source artifact, upgrade boundary, consumer evidence, native-helper delivery, and
Human-visible lifecycle being product-ready. Conversely, source/package maturity does not widen a
Target Surface or turn Handoff into a remote-desktop product.

Tracked by #151. Target Surface support claims remain governed by the
[component support matrix](component-support-matrix.md) and its executable conformance gate.

## Current product boundary

The current baseline is the **v0.4.0 GitHub/source release** with `private: true`.

- The committed JavaScript `dist/` tree is a supported source-release artifact boundary. CI stages
  only tracked package metadata + `dist/`, excludes TypeScript source/build configuration, installs
  production dependencies only, and smoke-imports the public entry points and consumer-required
  exports (`npm run verify:consumer-dist`).
- npm publication is not enabled and is not a maturity signal.
- macOS/Linux native or OS-facing helpers are **not** claimed as universal prebuilt binary assets.
  Their delivery/integrity boundary is deployment-specific and is described below.
- Browser, bounded Window, and bounded Terminal/PTY remain distinct first-class components. Product
  readiness never authorizes a consumer to widen an unsupported surface or assemble a hidden
  desktop fallback.

## Evidence classes

Consumer evidence is useful only when its revision and scope are explicit. Use these classes:

1. **Deterministic upstream** — Handoff-owned unit/conformance/portability/CI evidence.
2. **Consumer integration** — a named consumer commit imports or stages one exact Handoff commit or
   package artifact and its consumer contract tests pass.
3. **Physical component** — a Handoff-owned physical acceptance command passes on one exact Handoff
   revision for a documented host/surface/transport.
4. **Physical consumer dogfood** — a named consumer commit plus exact Handoff revision passes a real
   end-to-end Human flow. This complements, but never replaces, Handoff's own component gate.

Do not carry evidence forward automatically. A newer Handoff revision inherits deterministic
coverage only through its own CI; a prior physical run remains evidence for the revision that was
actually exercised until the relevant physical gate is rerun.

### Current consumer evidence ledger

The ledger records exact, reproducible integration facts without upgrading them into broader claims.

| Consumer | Consumer revision | Handoff revision/artifact | Evidence class | Current meaning |
| --- | --- | --- | --- | --- |
| `git-ksk/maps-browser-mcp` | `025ec6a882b0851d75f5b19001d354467ec353dd` (`origin/main` observed 2026-08-31) | immutable source pin `4f9d809eec812213e404a6d5a6d7d04029170f50` | Consumer integration; consumer repository also records historical physical Browser dogfood | A detached `origin/main` worktree completed `npm ci --ignore-scripts` plus full `npm run check`: typecheck, 351 tests (346 pass / 5 platform skips), and acceptance-harness syntax all passed with the immutable Handoff pin. Existing direct/TURN/Cloud Run physical records remain scoped to the revisions explicitly recorded by Maps; this deterministic rerun is not a fresh physical run. |
| `git-ksk/japan-cinema-browser-mcp` | `7ec79a682dbeabd371cf28c3422d2d14a49c5ab9` (`origin/main` observed 2026-08-31) | immutable source pin `a56cdf22ae6fcf6201c08de7974e01ef5795f6b3` | Consumer integration | A detached `origin/main` worktree completed `npm ci --ignore-scripts` plus full `npm run check`: typecheck and 165/165 tests passed with the immutable Handoff pin. Cinema retains a narrower pointer/scroll policy; TOHO Gate 0b physical acceptance remains consumer-owned/pending and is not implied by this deterministic record. |
| `git-ksk/computer-use-mcp-gateway` | `1957921948a3a082a95d9801ee690ec02ed66f4e` (`origin/main` observed 2026-08-31) | source artifact `096b2e18e5bc582101bfde09330316af9490056e` | Consumer integration / production-style staging preflight | A fresh private runtime stage using production dependencies only, `.bin` removal and a symlink-free dependency tree passed CUMG's `verify-import` for all nine required public exports; CUMG's preflight unit suite passed 14/14. Historical CUMG physical Window/Terminal dogfood remains separate revision-scoped evidence. |

The machine-readable source of record is [`consumer-compatibility-evidence.json`](consumer-compatibility-evidence.json). Handoff CI validates that revisions, evidence class, validation steps, and limitations remain closed-form and exact. The external consumer checks themselves were run in detached worktrees at the recorded consumer commits; Handoff CI does not clone external repositories on every run.

For every release-significant consumer validation, add or update evidence with at least:

- consumer repository + exact commit;
- exact Handoff commit, package version, archive digest, or immutable artifact identifier;
- evidence class;
- Target Surface / host / transport when relevant;
- deterministic or physical command/workflow used;
- result and date;
- any deliberately untested boundary.

A consumer branch name, `latest`, local working tree, or unpinned archive is not release evidence.

## Delivery boundary

### JavaScript runtime

The GitHub/source-release JavaScript contract is the tracked package metadata plus committed `dist/`.
Consumers may stage that artifact without TypeScript source and without compiling it first. The
release gate remains `npm run verify:consumer-dist` plus the normal repository CI.

This does **not** promise npm registry availability. A future npm publication must pass the separate
publication gate in the roadmap/release process and must reproduce the same reviewed artifact
surface.

### macOS helpers

The macOS Window/WebRTC helper currently comes from the tracked Swift package under
`experiments/thin-takeover-runtime`. A source release does not claim a notarized universal binary.
A deployment that uses the helper owns its build and installation provenance and must preserve:

- an exact Handoff source revision;
- the reviewed Swift/Xcode toolchain used to build the helper;
- a stable code-sign identity/designated requirement where persistent TCC attribution is required;
- private executable/configuration paths and no in-place replacement of a live helper;
- platform TCC/Accessibility/Screen Recording permissions on the controlled device, not on an
  unrelated Hub/control-plane process.

If Handoff later ships prebuilt macOS helpers, code signing, notarization, artifact digest/provenance,
and upgrade/rollback behavior become release gates rather than deployment-only concerns.

### Linux helpers

The Linux exact-window path includes tracked JavaScript/runtime helpers and depends on reviewed host
capabilities such as X11/Xvfb, ffmpeg, XTEST/xdotool or the native X11 helper, and optional AT-SPI
metadata. The source release does not claim a single hermetic Linux binary or universal ABI.

A deployment must pin the Handoff revision and its OS/runtime dependencies, keep the exact-window
helper boundary fail-closed, and run the Linux acceptance/portability gates appropriate to the
claimed surface. If prebuilt native Linux artifacts are introduced later, their distro/ABI baseline,
integrity/provenance, and rollback story must be explicit before they are called product-ready.

## Upgrade, rollback, and compatibility

An upgrade must be treated as a paired artifact/state transition rather than "replace files and hope
that an old Human session continues".

- Stage and import/preflight the new artifact **before** draining or replacing a consumer service.
- Record the exact old/new Handoff revisions and the consumer revision that is being upgraded.
- Do not restore a locator, capability, client generation, media/input session, or Agent/Human
  authority from an older runtime generation.
- Durable Handoff recovery remains `reissue_and_revalidate`. A restart/upgrade may recover bounded
  checkpoint metadata, but it must reconstruct target/session authority freshly and fail closed when
  schema, ownership, expiry, or target revalidation fails.
- Consumer semantic verification and replay policy remain consumer-owned. A rollback cannot mark an
  interrupted semantic action successful or authorize replay merely because old binaries returned.
- If checkpoint/audit/operator schema compatibility changes, document the accepted version range and
  migration/deprecation behavior. Unknown or unsupported durable data fails closed; do not silently
  coerce it into live authority.
- Rollback should restore a reviewed paired runtime/configuration artifact. It must not reuse mutable
  transport/session state from the failed upgrade.

CUMG's generation-staging/preflight design is useful consumer evidence for this model, but it is not
a requirement that every consumer adopt CUMG's deployment topology.

## Human-visible lifecycle quality

Human-visible state is part of product correctness whenever stale presentation could misrepresent
who currently owns authority. The product vocabulary is:

```text
connecting -> human_active -> verifying -> closed
                         \-> unavailable
```

Presentation requirements:

- `connecting` must not imply Human authority is already active;
- `human_active` must correspond to the currently valid Human generation;
- `Done` immediately fences further Human mutation before consumer verification;
- `verifying` must not leave stale interactive controls that appear usable;
- disconnect/unavailable is not `Done` and never implies Agent resume;
- `closed` means the Human-control surface is terminal, not that a consequential consumer action was
  approved or semantically successful.

Issue #150 is now completed v0.4.0 Product Readiness evidence: physical iPhone LocalAuthentication OK/Cancel runs proved that exact-target disappearance fences Human input, clears the stale decoded secure frame, shows a non-interactive verifying state, and allows terminal success only after consumer-owned verification. Backend lifecycle correctness alone remains insufficient if stale presentation could make an old control appear active; defects of that class stay in Product Readiness even when transport/authority tests are green.

## Diagnostics, resource, and supply-chain readiness

Product readiness keeps the existing privacy boundary:

- no framebuffer, raw Human input, PTY/browser content, credentials/tokens/OTP, account identity, or
  private target identifiers in generic logs/audit/checkpoints;
- bounded operator diagnostics remain versioned and content-free;
- latency/resource work is evidence-driven and must preserve authority/backpressure semantics;
- Dependency Review, CodeQL, cross-platform portability, committed-dist synchronization, and the
  clean consumer artifact gate stay part of normal release evidence;
- native-helper provenance/signing requirements must become stricter before prebuilt binaries are
  distributed, not after.

## Product Readiness vs later roadmap tracks

Product Readiness does not own:

- provider-neutral relay/connectivity completion (#19);
- hosted control-plane / stateful-worker topology (#12);
- explicit Desktop authority/session work (#125/#161);
- npm publication merely for discoverability;
- consumer-specific browser/profile/PTY/process policy;
- consumer semantic verification or consequential-action approval.

Those tracks may advance independently, but a release should not claim an installable/upgradable
product boundary until the relevant delivery, compatibility, and native-helper gates above are met.
