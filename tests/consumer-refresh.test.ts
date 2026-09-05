import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const script = join(process.cwd(), "scripts", "consumer-refresh.mjs");
const repository = "git-ksk/mcp-execution-handoff";
const archive = (revision: string) => `https://github.com/${repository}/archive/${revision}.tar.gz`;
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
const parent = git("rev-parse", "HEAD^");
const packageVersion = (revision: string) => JSON.parse(git("show", `${revision}:package.json`)).version as string;

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...options.env }
  });
}

function tempConsumer(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "handoff-consumer-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("consumer artifact manifest is deterministic and revision-bound", () => {
  const first = run(["manifest", "--revision", head]);
  const second = run(["manifest", "--revision", head]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const manifest = JSON.parse(first.stdout);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.repository, repository);
  assert.equal(manifest.revision, head);
  assert.equal(manifest.packageVersion, packageVersion(head));
  assert.equal(manifest.sourceArchiveUrl, archive(head));
  assert.match(manifest.artifactIdentity.packageJson, /^[0-9a-f]{40}$/);
  assert.match(manifest.artifactIdentity.packageLock, /^[0-9a-f]{40}$/);
  assert.match(manifest.artifactIdentity.consumerDist, /^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.nativeHelperBuildInputs, []);

  const invalid = run(["manifest", "--revision", "main"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /exact lowercase 40-character Git SHA/);
});

test("source-checkout refresh updates all declared identities and marks native helper rebuild", (t) => {
  const root = tempConsumer(t);
  writeFileSync(join(root, "pin.json"), `${JSON.stringify({
    schema_version: 1,
    source_commit: parent,
    package_version: packageVersion(parent)
  }, null, 2)}\n`);
  writeFileSync(join(root, "release.yml"), `env:\n  HANDOFF_SOURCE_COMMIT: ${parent}\n`);
  writeFileSync(join(root, "consumer-refresh.json"), `${JSON.stringify({
    schemaVersion: 1,
    dependency: { kind: "source-checkout" },
    pinPolicies: [
      { kind: "json", path: "pin.json", jsonPath: ["source_commit"], value: "revision" },
      { kind: "json", path: "pin.json", jsonPath: ["package_version"], value: "packageVersion" },
      {
        kind: "regex",
        path: "release.yml",
        pattern: "^  HANDOFF_SOURCE_COMMIT: ([0-9a-f]{40})$",
        replacement: "  HANDOFF_SOURCE_COMMIT: {{revision}}",
        value: "revision"
      }
    ],
    nativeHelpers: {
      mode: "rebuild-required",
      sourceRoots: ["experiments/thin-takeover-runtime", "native"]
    }
  }, null, 2)}\n`);

  const result = run(["apply", "--consumer", root, "--config", "consumer-refresh.json", "--revision", head]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "updated");
  assert.equal(output.previousRevision, parent);
  assert.equal(output.requestedRevision, head);
  assert.equal(output.nativeHelpers.rebuildRequired, true);
  assert.deepEqual(output.nativeHelpers.sourceTrees.map((entry: { path: string }) => entry.path), [
    "experiments/thin-takeover-runtime",
    "native"
  ]);
  assert.ok(output.nativeHelpers.sourceTrees.every((entry: { gitTree: string }) => /^[0-9a-f]{40}$/.test(entry.gitTree)));

  const pin = JSON.parse(readFileSync(join(root, "pin.json"), "utf8"));
  assert.equal(pin.source_commit, head);
  assert.equal(pin.package_version, packageVersion(head));
  assert.match(readFileSync(join(root, "release.yml"), "utf8"), new RegExp(head));

  const verify = run(["verify", "--consumer", root, "--config", "consumer-refresh.json", "--revision", head]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).status, "verified");
});

test("source-checkout refresh fails closed when declared revision pins disagree", (t) => {
  const root = tempConsumer(t);
  writeFileSync(join(root, "pin.json"), `${JSON.stringify({ source_commit: parent }, null, 2)}\n`);
  writeFileSync(join(root, "release.yml"), `env:\n  HANDOFF_SOURCE_COMMIT: ${head}\n`);
  writeFileSync(join(root, "consumer-refresh.json"), `${JSON.stringify({
    schemaVersion: 1,
    dependency: { kind: "source-checkout" },
    pinPolicies: [
      { kind: "json", path: "pin.json", jsonPath: ["source_commit"], value: "revision" },
      {
        kind: "regex",
        path: "release.yml",
        pattern: "^  HANDOFF_SOURCE_COMMIT: ([0-9a-f]{40})$",
        replacement: "  HANDOFF_SOURCE_COMMIT: {{revision}}",
        value: "revision"
      }
    ],
    nativeHelpers: { mode: "none" }
  }, null, 2)}\n`);

  const beforePin = readFileSync(join(root, "pin.json"), "utf8");
  const beforeWorkflow = readFileSync(join(root, "release.yml"), "utf8");
  const result = run(["apply", "--consumer", root, "--config", "consumer-refresh.json", "--revision", head]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /revision pinPolicies disagree/);
  assert.equal(readFileSync(join(root, "pin.json"), "utf8"), beforePin);
  assert.equal(readFileSync(join(root, "release.yml"), "utf8"), beforeWorkflow);
});

test("npm archive refresh updates package and lock through npm then verifies exact resolution", (t) => {
  const root = tempConsumer(t);
  const oldVersion = packageVersion(parent);
  const nextVersion = packageVersion(head);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "fixture-consumer",
    version: "1.0.0",
    private: true,
    dependencies: { "mcp-execution-handoff": archive(parent) }
  }, null, 2)}\n`);
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
    name: "fixture-consumer",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture-consumer", version: "1.0.0", dependencies: { "mcp-execution-handoff": archive(parent) } },
      "node_modules/mcp-execution-handoff": { version: oldVersion, resolved: archive(parent) }
    }
  }, null, 2)}\n`);
  writeFileSync(join(root, "consumer-refresh.json"), `${JSON.stringify({
    schemaVersion: 1,
    dependency: {
      kind: "npm-github-archive",
      packageName: "mcp-execution-handoff",
      packageJson: "package.json",
      packageLock: "package-lock.json"
    },
    pinPolicies: [],
    nativeHelpers: {
      mode: "rebuild-required",
      sourceRoots: ["experiments/thin-takeover-runtime"]
    }
  }, null, 2)}\n`);

  const fakeNpm = join(root, "fake-npm.mjs");
  writeFileSync(fakeNpm, `import {readFileSync,writeFileSync} from 'node:fs';\nconst pkg=JSON.parse(readFileSync('package.json','utf8'));\nconst lock=JSON.parse(readFileSync('package-lock.json','utf8'));\nconst url=pkg.dependencies['mcp-execution-handoff'];\nlock.packages[''].dependencies['mcp-execution-handoff']=url;\nlock.packages['node_modules/mcp-execution-handoff'].resolved=url;\nlock.packages['node_modules/mcp-execution-handoff'].version=process.env.FAKE_HANDOFF_VERSION;\nwriteFileSync('package-lock.json',JSON.stringify(lock,null,2)+'\\n');\n`);
  chmodSync(fakeNpm, 0o755);

  const result = run(
    ["apply", "--consumer", root, "--config", "consumer-refresh.json", "--revision", head],
    { env: { npm_execpath: fakeNpm, FAKE_HANDOFF_VERSION: nextVersion } }
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "updated");
  assert.equal(output.nativeHelpers.rebuildRequired, true);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.dependencies["mcp-execution-handoff"], archive(head));
  assert.equal(lock.packages[""].dependencies["mcp-execution-handoff"], archive(head));
  assert.equal(lock.packages["node_modules/mcp-execution-handoff"].resolved, archive(head));
  assert.equal(lock.packages["node_modules/mcp-execution-handoff"].version, nextVersion);
});

test("npm archive refresh rejects stale lock state before mutation", (t) => {
  const root = tempConsumer(t);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "fixture-consumer",
    version: "1.0.0",
    private: true,
    dependencies: { "mcp-execution-handoff": archive(parent) }
  }, null, 2)}\n`);
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
    name: "fixture-consumer",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "mcp-execution-handoff": archive(parent) } },
      "node_modules/mcp-execution-handoff": { version: packageVersion(parent), resolved: archive(head) }
    }
  }, null, 2)}\n`);
  writeFileSync(join(root, "consumer-refresh.json"), `${JSON.stringify({
    schemaVersion: 1,
    dependency: {
      kind: "npm-github-archive",
      packageName: "mcp-execution-handoff",
      packageJson: "package.json",
      packageLock: "package-lock.json"
    },
    pinPolicies: [],
    nativeHelpers: { mode: "none" }
  }, null, 2)}\n`);

  const beforePackage = readFileSync(join(root, "package.json"), "utf8");
  const beforeLock = readFileSync(join(root, "package-lock.json"), "utf8");
  const result = run(["apply", "--consumer", root, "--config", "consumer-refresh.json", "--revision", head]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package-lock resolved Handoff archive is stale or mismatched/);
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), beforePackage);
  assert.equal(readFileSync(join(root, "package-lock.json"), "utf8"), beforeLock);
});
