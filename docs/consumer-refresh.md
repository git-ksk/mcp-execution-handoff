# Deterministic consumer refresh contract

`mcp-execution-handoff` source releases are intentionally immutable and remain `private: true`. Consumers that bake Handoff into an application image or native bundle therefore **must still rebuild and stage a new consumer artifact/revision** when the Handoff revision changes. The refresh contract in this document automates dependency/pin staging; it does not mutate a running service, deploy a consumer, hold cloud credentials, or switch traffic.

Tracked by #237 and introduced for the v0.4.4 hardening line.

## Handoff artifact manifest

An exact Handoff Git SHA can be projected into a deterministic machine-readable manifest:

```bash
npm run consumer:refresh -- manifest --revision <40-character-sha>
```

The manifest contains only reproducible source-release metadata:

- repository identity;
- exact 40-character Git revision;
- package version at that revision;
- canonical immutable GitHub source-archive URL;
- Git object identities for `package.json`, `package-lock.json`, and committed `dist/`;
- optional Git tree identities for consumer-declared native-helper build-input roots.

There is no timestamp, branch name, mutable `latest`, deployment credential, consumer identity, target-service state, or Human content in this manifest.

## Consumer config schema v1

The consumer owns a small JSON config. Handoff does not hard-code Maps, Cinema, CUMG, Cloud Run, or another repository layout.

### Immutable npm archive consumer

```json
{
  "schemaVersion": 1,
  "dependency": {
    "kind": "npm-github-archive",
    "packageName": "mcp-execution-handoff",
    "packageJson": "package.json",
    "packageLock": "package-lock.json"
  },
  "pinPolicies": [],
  "nativeHelpers": {
    "mode": "rebuild-required",
    "sourceRoots": ["experiments/thin-takeover-runtime"]
  }
}
```

This shape matches consumers that pin `https://github.com/git-ksk/mcp-execution-handoff/archive/<sha>.tar.gz`. Before changing anything, the CLI requires `package.json`, the lockfile root dependency, the installed-package lock record, package version, and any declared pin policies to agree on the current immutable Handoff revision. It then updates `package.json`, runs `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, and verifies that the lockfile resolves exactly to the requested archive/version. A stale or mismatched lockfile fails before mutation.

### Exact source-checkout / native-helper consumer

```json
{
  "schemaVersion": 1,
  "dependency": { "kind": "source-checkout" },
  "pinPolicies": [
    {
      "kind": "json",
      "path": "packaging/handoff.json",
      "jsonPath": ["source_commit"],
      "value": "revision"
    },
    {
      "kind": "json",
      "path": "packaging/handoff.json",
      "jsonPath": ["package_version"],
      "value": "packageVersion"
    },
    {
      "kind": "regex",
      "path": ".github/workflows/release.yml",
      "pattern": "^  HANDOFF_SOURCE_COMMIT: ([0-9a-f]{40})$",
      "replacement": "  HANDOFF_SOURCE_COMMIT: {{revision}}",
      "value": "revision"
    }
  ],
  "nativeHelpers": {
    "mode": "rebuild-required",
    "sourceRoots": ["experiments/thin-takeover-runtime", "native"]
  }
}
```

A regex policy must match exactly once and expose exactly one capture group containing the current value. JSON policies update only an explicitly declared existing path. All files must be regular non-symlink files inside the consumer checkout. Multiple revision policies must agree before refresh; disagreement fails closed.

`nativeHelpers.mode = "rebuild-required"` means a revision change returns `nativeHelpers.rebuildRequired: true` plus the exact Git tree identities of the declared Handoff source roots. This is a build-input contract, **not** a claim that a native helper was rebuilt. Consumer CI must rebuild/stage its native helper from the requested Handoff revision before admitting the new candidate. This prevents an old helper from being silently treated as compatible with a new source pin.

## Apply and verify

From a Handoff checkout that contains the requested commit object:

```bash
npm run consumer:refresh -- apply \
  --consumer /path/to/consumer \
  --config .handoff-consumer-refresh.json \
  --revision <40-character-sha>

npm run consumer:refresh -- verify \
  --consumer /path/to/consumer \
  --config .handoff-consumer-refresh.json \
  --revision <40-character-sha>
```

`apply` performs a preflight consistency check, snapshots every file it may change, applies only declared updates, refreshes the npm lockfile when required, and then re-verifies the exact requested identity. Any apply/lock/verification failure restores the snapshotted files before returning failure. `verify` is read-only.

The stable JSON result includes the previous/requested revisions, package version, touched files, native-helper rebuild requirement/source-tree identities, and exact-pin verification status. It intentionally does not run consumer tests, build an image, create a deployment revision, check target-service semantics, or switch traffic.

`--verify-consumer-dist` may additionally run Handoff's committed-dist contract, but only when the requested revision equals a clean current Handoff `HEAD`; it never substitutes for consumer CI.

## Required consumer workflow after refresh

The expected ownership remains:

```text
exact Handoff revision
  -> deterministic refresh/stage
  -> consumer tests
  -> rebuild immutable consumer/native artifacts
  -> consumer-owned candidate deployment/readiness
  -> explicit consumer-owned traffic decision
```

For Cloud Run this commonly means a 0%-traffic candidate revision and consumer-specific public preflight before traffic movement. Those deployment steps remain outside Handoff. Runtime `npm install`, fetch-on-start, mutable branch refs, shared mutable dependency directories, automatic downstream merge, and implicit traffic changes are not supported by this contract.
