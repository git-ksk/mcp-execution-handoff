# Product readiness boundary

[日本語](product-readiness.ja.md)

Product readiness is a cross-cutting compatibility and delivery track. It is separate from both
Target Surface feature work and the v0.4+ transport/hosted topology roadmap. It also does not require
npm publication: a source release can be mature and reproducible while installable artifact delivery
remains intentionally unapproved.

## Current delivery claim

The current `v0.3.0` baseline is a **GitHub source release**.

- `package.json` remains `private: true`; no npm package has been published.
- The package manifest describes the candidate JavaScript/TypeScript package shape (`dist`, public
  docs, and the documented package subpaths), but that shape is not an npm availability claim.
- macOS Swift takeover helpers are built from repository source for acceptance/consumer integration;
  they are not a separately versioned, signed, notarized binary product today.
- Linux native/accessibility helper build inputs also remain repository-owned implementation
  material. Any future packaged helper boundary must explicitly define its build, ABI/runtime,
  provenance, and update expectations instead of assuming source-build behavior is binary delivery.

Do not describe a source tag, `npm pack` success, or a consumer-local helper build as an installable
binary release.

## Real consumer compatibility evidence

The compatibility set is currently:

| Consumer | Relevant proven Handoff boundary |
| --- | --- |
| `git-ksk/maps-browser-mcp` | Browser Handoff and credential-safe external Human flow |
| `git-ksk/japan-cinema-browser-mcp` | Browser Handoff and credential-safe external Human flow |
| `git-ksk/computer-use-mcp-gateway` | first-class bounded Window and Terminal/PTY adapters, including macOS physical dogfood |

For a release-significant change, record evidence against an **exact** Handoff revision or exact
candidate package artifact. “Latest”, an unpinned branch name, or success against an older consumer
checkout is not sufficient evidence.

A compatibility record should identify, as applicable:

- consumer repository and tested consumer revision;
- exact Handoff commit/tag or package artifact identity;
- adapter/Target Surface affected;
- clean install/build result;
- deterministic contract/E2E result;
- required physical acceptance result;
- any intentionally untested consumer and why it is not relevant to that change.

Consumer success supplements Handoff's own deterministic, portability, security, and physical gates;
it never replaces them.

### Release-significant changes

Treat at least these changes as release-significant for compatibility review:

- exported API/type/package-subpath changes;
- authority, epoch, lease, reconnect, completion, or replay semantics;
- checkpoint/recovery schema or compatibility behavior;
- stable audit/operator-diagnostic contract changes;
- Browser/Window/Terminal adapter lifecycle changes;
- native/helper wire, invocation, build, or required-runtime changes;
- package contents, runtime engine requirements, or dependency changes that affect consumers.

Documentation-only fixes that cannot change consumer behavior may record “not applicable” instead of
running unrelated consumer acceptance.

## Source, package, and native-helper boundary

Product-readiness claims must say which delivery layer they cover.

### Source-built consumer

A source consumer may pin an immutable Handoff revision and build the required JavaScript/TypeScript
and helper components from repository source. The source-release gate proves this repository shape;
it does not promise binary helper compatibility outside the documented source revision.

### Candidate npm artifact

`npm pack --dry-run` is a required inspection of the candidate package contents even while
`private: true`. Before npm publication is approved, the separate npm gate must additionally prove
exact-artifact consumer validation, provenance, least-privilege publishing credentials, migration
impact, and rollback/deprecation procedures.

### Native/helper artifact

Before any macOS helper is described as a distributed product artifact, define at minimum:

- reproducible source revision and build inputs;
- artifact integrity/provenance and release ownership;
- code-signing identity and notarization expectations where macOS distribution requires them;
- entitlement and minimum-OS compatibility expectations;
- update and rollback behavior without restoring stale Human/Agent authority.

Before any Linux native/accessibility helper is described as a distributed product artifact, define
at minimum its supported architecture/runtime/library boundary, build provenance, invocation
contract, and compatibility/rollback expectations. Do not silently substitute a different helper or
fallback mechanism when the reviewed helper is unavailable.

## Upgrade, rollback, and compatibility

SemVer is the compatibility signal, but pre-1.0 releases may still change intentionally. Every
consumer-visible breaking change must state its migration behavior rather than relying on the
pre-1.0 label alone.

Upgrade/restart invariants are stricter than source compatibility:

- no upgrade or restart restores a stale Human or Agent capability, media/input session, locator,
  reconnect handle, PTY authority, or queued Human input;
- durable recovery remains `reissue_and_revalidate`; an old checkpoint is never action-success
  evidence;
- checkpoint/schema changes must explicitly state whether old state is accepted, rejected, or safely
  cleared; rejection must fail closed;
- rollback must not replay a pre-upgrade action or silently reinterpret newer durable state;
- removal/deprecation of a consumer-visible contract requires a documented migration/rollback path
  before an installable package can call the change product-ready.

A source rollback is not a reason to force-move a published tag. Use a corrective release and keep
published release provenance immutable.

## Human-visible lifecycle is correctness

The Human surface must make authority state unambiguous. At minimum, the relevant transport should
visibly distinguish states equivalent to:

`connecting -> human_active -> verifying -> closed/unavailable`

A frame or enabled-looking control from an authority state that has already been fenced is a product
correctness defect even if backend verification succeeds. Issue #150 is the concrete macOS
LocalAuthentication example: target disappearance must clear/fence the old Human surface and may
enter `verifying`, but disappearance itself is never authentication success. Only fresh
consumer-owned semantic verification can produce the terminal success/closed state.

Required lifecycle regression evidence should cover stale-frame/control removal, authority fencing,
verified transition, and non-success/timeout behavior where the surface exposes those states.

## Diagnostics, resources, and supply chain

Product readiness keeps the existing privacy boundary:

- no credentials, Human input, frame/media content, raw target content, SDP/candidate addresses, or
  execution arguments enter generic durable diagnostics/audit state;
- stable operator diagnostics remain bounded and reviewable;
- latency/resource regression evidence is required when a change materially affects Human takeover
  responsiveness, process lifetime, memory/CPU, or helper startup—not as an unconditional benchmark
  for every documentation/logic patch;
- dependency review, CodeQL, audit, package inspection, and repository security reporting stay part
  of release evidence;
- provenance claims must match the actual delivery layer: source tag, candidate npm tarball, and
  future native binaries are distinct artifacts.

## Product-readiness gate for a release-significant change

A change is product-readiness complete only when all applicable items below are true:

1. Handoff's deterministic/security/portability tests are green.
2. Required physical acceptance is green, or the release record explicitly says why none applies.
3. Relevant real consumers are validated against the exact candidate revision/artifact.
4. Public/package/helper compatibility impact is documented.
5. Upgrade/restart/rollback behavior preserves authority and replay invariants.
6. Human-visible lifecycle does not misrepresent fenced authority.
7. Package/helper contents and provenance claims match what is actually delivered.
8. No consumer semantic verification is moved into Handoff merely to make packaging easier.

This gate can be satisfied for a source release without satisfying the npm or native-binary
publication gates.
