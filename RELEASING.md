# Release process

[日本語](RELEASING.ja.md)

This project currently has two deliberately separate delivery decisions:

1. **GitHub source release** — versioned tag + GitHub Release from a reviewed `main` commit.
2. **npm publication** — a separate future gate. The package remains `private: true`; a source release does not imply `npm publish`.

**v0.4.0** is the current GitHub/source-release baseline, tracked through milestone `v0.4.0 — Source Release` and Issue #213. It preserves the v0.3 Recovery & Observability contract while promoting the completed bounded WSS/component-maturity line: macOS exact-window WSS including LocalAuthentication, managed recoverable WSS behavior, mobile Human-control parity, executable support/auth-UX conformance, and stale secure-frame fencing. Later relay/hosted/desktop authority work (#19/#12/#161/#125) remains separate and non-blocking.

## Versioning policy

Use SemVer as a compatibility signal even before npm publication.

- `0.1.x`: fixes or documentation changes that preserve the v0.1 public contract.
- `0.2.0`: minor pre-1.0 boundary for the materially expanded public surface introduced after v0.1.0, including first-class Browser/Window/Terminal components and their package subpaths.
- later `0.2.x`: compatible hardening and bounded host/transport improvements that do not require another public-contract milestone.
- `0.3.0`: recovery/observability source boundary: provider-neutral bounded checkpoint storage, stable privacy-bounded audit/operator diagnostics, and crash/restart conformance without new Human-control authority.
- later `0.3.x`: compatible maintenance/durability/documentation hardening that preserves the v0.3 contract.
- `0.4.0`: bounded transport/component-maturity boundary: reusable macOS exact-window WSS including LocalAuthentication, managed recoverable WSS semantics, mobile Human-control parity, executable support/auth-UX conformance, and lifecycle-presentation hardening without adding implicit Desktop authority.
- later `0.4.x`: compatible hardening that preserves the v0.4 Target Surface and authority boundaries.
- later pre-1.0 minors: use when public contract/deployment semantics materially expand again.

A roadmap family such as `v0.2` can contain work that lands after `v0.2.0`. An issue belongs to the v0.2 product direction without automatically blocking the first v0.2 source release.

## Source-release preconditions

Before a final release PR:

- the release milestone identifies the actual blockers;
- all blocker issues are closed or explicitly documented as non-blocking;
- `main`, `origin/main`, and GitHub `main` agree;
- the release worktree is clean and based on that exact commit;
- no unresolved known security issue invalidates a documented invariant;
- required CI, portability, Dependency Review, and CodeQL gates are operational;
- `package.json` is still `private: true` unless the separate npm publication gate has independently been approved.

Do not make optional feature work a release blocker merely because it is listed in the same roadmap family.

## Final release PR

The final release PR should contain only release bookkeeping unless a blocker requires a reviewed code change.

1. Bump `package.json` and `package-lock.json` to the target version.
2. Promote the applicable `CHANGELOG.md` entries from `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`.
3. Update README/Roadmap wording that describes the latest source release.
4. Keep `private: true` for source-only releases.
5. Run the complete release validation below from a clean install.

For v0.4.0, the authoritative checklist is Issue #213. Historical v0.3.0 used Issue #145; v0.2.0 used Issue #119.

## Release validation

Run from a clean checkout/worktree:

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm run verify:consumer-dist
npm audit --audit-level=moderate
npm pack --dry-run
```

The pack inspection must confirm that the intended public package artifacts are present, including:

- root export;
- `./core`;
- `./mcp`;
- `./browser-takeover`;
- `./window-takeover`;
- `./terminal-takeover`.

Also smoke-import the built entry points. A representative local check is:

```bash
node --input-type=module - <<'NODE'
for (const path of [
  "./dist/index.js",
  "./dist/core/index.js",
  "./dist/mcp/index.js",
  "./dist/browser-takeover/index.js",
  "./dist/window-takeover/index.js",
  "./dist/terminal-takeover/index.js",
]) {
  await import(path);
  console.log(`ok ${path}`);
}
NODE
```

`npm run verify:consumer-dist` creates a temporary consumer staging directory from **tracked** `package.json`, `package-lock.json`, and `dist/` artifacts only. It intentionally excludes `src/` and TypeScript build configuration, installs production dependencies with `npm ci --omit=dev --ignore-scripts`, then imports the public root/subpath entry points and verifies the exports required by current consumers. This is the supported GitHub/source-release JavaScript artifact boundary: a consumer staging committed `dist/` does not need to compile TypeScript first. It does **not** enable npm publication or claim that every platform-native helper is distributed as a prebuilt binary.

The final PR must also pass the repository's required GitHub checks. Do not treat a local green run as a substitute for protected-branch checks.

## Publishing the GitHub source release

After the release PR is merged:

1. Fetch and verify the exact merged `main` commit.
2. Create tag `vX.Y.Z` on that exact commit. Never force-move or silently retag an existing version.
3. Publish GitHub Release `vX.Y.Z — Source Release` from that tag.
4. State explicitly that npm is not published while `private: true` remains in effect.
5. Verify the tag and GitHub Release both resolve to the intended commit.
6. Verify README/Roadmap/CHANGELOG describe the new release correctly.
7. Close the release-gate issue and milestone only after those checks pass.

If a release contains a mistake, prefer a corrective follow-up version. Do not rewrite an already published release tag as routine cleanup.

## npm publication is separate

Do not run `npm publish` as part of the source-release process.

Before npm publication is ever enabled, the roadmap's npm publication gate must be satisfied independently: package naming/export stability, provenance, least-privilege credentials, artifact inspection, exact-package consumer validation, SemVer/migration documentation, and rollback/deprecation procedures.
