#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = "git-ksk/mcp-execution-handoff";
const ARCHIVE_PREFIX = `https://github.com/${REPOSITORY}/archive/`;
const HANDOFF_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const VALUE_KINDS = new Set(["revision", "packageVersion", "sourceArchiveUrl"]);
const DEPENDENCY_KINDS = new Set(["npm-github-archive", "source-checkout"]);
const POLICY_KINDS = new Set(["json", "regex"]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !["manifest", "apply", "verify"].includes(command)) {
    fail("usage: consumer-refresh.mjs <manifest|apply|verify> --revision <40-sha> [--consumer <path> --config <path>] [--verify-consumer-dist]");
  }
  const args = { command, verifyConsumerDist: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--verify-consumer-dist") {
      args.verifyConsumerDist = true;
      continue;
    }
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${token}`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
}

function git(args, { cwd = HANDOFF_ROOT } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function exactRevision(revision) {
  if (!SHA.test(revision ?? "")) fail("revision must be one exact lowercase 40-character Git SHA");
  let resolved;
  try {
    resolved = git(["rev-parse", `${revision}^{commit}`]);
  } catch {
    fail(`Handoff revision is unavailable in this checkout: ${revision}`);
  }
  if (resolved !== revision) fail(`Handoff revision did not resolve exactly: ${revision}`);
  return revision;
}

function gitObjectId(revision, path) {
  try {
    return git(["rev-parse", `${revision}:${path}`]);
  } catch {
    fail(`required Handoff artifact path is absent at ${revision}: ${path}`);
  }
}

function packageAt(revision) {
  let raw;
  try {
    raw = git(["show", `${revision}:package.json`]);
  } catch {
    fail(`package.json is unavailable at Handoff revision ${revision}`);
  }
  const value = JSON.parse(raw);
  if (value?.name !== "mcp-execution-handoff" || typeof value?.version !== "string") {
    fail(`invalid package identity at Handoff revision ${revision}`);
  }
  return value;
}

function artifactManifest(revision, sourceRoots = []) {
  exactRevision(revision);
  const pkg = packageAt(revision);
  const roots = [...new Set(sourceRoots)].sort();
  const nativeSourceTrees = roots.map((path) => ({ path, gitTree: gitObjectId(revision, path) }));
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    revision,
    packageVersion: pkg.version,
    sourceArchiveUrl: `${ARCHIVE_PREFIX}${revision}.tar.gz`,
    artifactIdentity: {
      packageJson: gitObjectId(revision, "package.json"),
      packageLock: gitObjectId(revision, "package-lock.json"),
      consumerDist: gitObjectId(revision, "dist")
    },
    nativeHelperBuildInputs: nativeSourceTrees
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field: ${key}`);
  }
}

function parseConfig(path) {
  const config = assertObject(JSON.parse(readFileSync(path, "utf8")), "config");
  assertKeys(config, new Set(["schemaVersion", "dependency", "pinPolicies", "nativeHelpers"]), "config");
  if (config.schemaVersion !== 1) fail("consumer refresh config schemaVersion must be 1");
  const dependency = assertObject(config.dependency, "dependency");
  assertKeys(dependency, new Set(["kind", "packageName", "packageJson", "packageLock"]), "dependency");
  if (!DEPENDENCY_KINDS.has(dependency.kind)) fail(`unsupported dependency kind: ${dependency.kind}`);
  if (dependency.kind === "npm-github-archive") {
    if (dependency.packageName !== "mcp-execution-handoff") fail("npm-github-archive packageName must be mcp-execution-handoff");
    if (typeof dependency.packageJson !== "string" || typeof dependency.packageLock !== "string") {
      fail("npm-github-archive requires packageJson and packageLock paths");
    }
  } else if ("packageName" in dependency || "packageJson" in dependency || "packageLock" in dependency) {
    fail("source-checkout dependency must not declare npm package paths");
  }

  const pinPolicies = config.pinPolicies ?? [];
  if (!Array.isArray(pinPolicies)) fail("pinPolicies must be an array");
  for (const [index, rawPolicy] of pinPolicies.entries()) {
    const policy = assertObject(rawPolicy, `pinPolicies[${index}]`);
    if (!POLICY_KINDS.has(policy.kind)) fail(`unsupported pin policy kind at index ${index}`);
    if (!VALUE_KINDS.has(policy.value)) fail(`unsupported pin policy value at index ${index}`);
    if (typeof policy.path !== "string") fail(`pinPolicies[${index}].path must be a string`);
    if (policy.kind === "json") {
      assertKeys(policy, new Set(["kind", "path", "jsonPath", "value"]), `pinPolicies[${index}]`);
      if (!Array.isArray(policy.jsonPath) || policy.jsonPath.length === 0 || policy.jsonPath.some((part) => typeof part !== "string" || !part)) {
        fail(`pinPolicies[${index}].jsonPath must be a non-empty string array`);
      }
    } else {
      assertKeys(policy, new Set(["kind", "path", "pattern", "replacement", "value"]), `pinPolicies[${index}]`);
      if (typeof policy.pattern !== "string" || typeof policy.replacement !== "string") {
        fail(`pinPolicies[${index}] regex policy requires pattern and replacement`);
      }
    }
  }

  const nativeHelpers = config.nativeHelpers ?? { mode: "none" };
  assertObject(nativeHelpers, "nativeHelpers");
  assertKeys(nativeHelpers, new Set(["mode", "sourceRoots"]), "nativeHelpers");
  if (!new Set(["none", "rebuild-required"]).has(nativeHelpers.mode)) fail(`unsupported nativeHelpers mode: ${nativeHelpers.mode}`);
  const sourceRoots = nativeHelpers.sourceRoots ?? [];
  if (!Array.isArray(sourceRoots) || sourceRoots.some((value) => typeof value !== "string" || !value)) fail("nativeHelpers.sourceRoots must be a string array");
  if (nativeHelpers.mode === "rebuild-required" && sourceRoots.length === 0) fail("rebuild-required nativeHelpers must declare sourceRoots");
  if (nativeHelpers.mode === "none" && sourceRoots.length !== 0) fail("nativeHelpers mode none cannot declare sourceRoots");

  return { schemaVersion: 1, dependency, pinPolicies, nativeHelpers: { mode: nativeHelpers.mode, sourceRoots } };
}

function safeConsumerPath(root, relativePath) {
  if (!relativePath || isAbsolute(relativePath)) fail(`consumer path must be relative: ${relativePath}`);
  const normalized = normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) fail(`consumer path escapes checkout: ${relativePath}`);
  const absolute = resolve(root, normalized);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`consumer path escapes checkout: ${relativePath}`);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    fail(`consumer file does not exist: ${relativePath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`consumer path must be a regular non-symlink file: ${relativePath}`);
  return absolute;
}

function parseArchiveRevision(url) {
  if (typeof url !== "string" || !url.startsWith(ARCHIVE_PREFIX) || !url.endsWith(".tar.gz")) {
    fail("consumer dependency is not the canonical immutable Handoff GitHub archive URL");
  }
  const revision = url.slice(ARCHIVE_PREFIX.length, -".tar.gz".length);
  if (!SHA.test(revision)) fail("consumer dependency archive does not contain an exact 40-character SHA");
  return revision;
}

function readJsonPath(document, pathParts, label) {
  let current = document;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || !(part in current)) fail(`${label} JSON path is missing: ${pathParts.join(".")}`);
    current = current[part];
  }
  return current;
}

function setJsonPath(document, pathParts, value, label) {
  let current = document;
  for (const part of pathParts.slice(0, -1)) {
    if (!current || typeof current !== "object" || !(part in current)) fail(`${label} JSON path is missing: ${pathParts.join(".")}`);
    current = current[part];
  }
  const leaf = pathParts.at(-1);
  if (!current || typeof current !== "object" || !(leaf in current)) fail(`${label} JSON path is missing: ${pathParts.join(".")}`);
  current[leaf] = value;
}

function readPolicyValue(root, policy) {
  const path = safeConsumerPath(root, policy.path);
  const raw = readFileSync(path, "utf8");
  if (policy.kind === "json") return readJsonPath(JSON.parse(raw), policy.jsonPath, policy.path);
  const regex = new RegExp(policy.pattern, "gm");
  const matches = [...raw.matchAll(regex)];
  if (matches.length !== 1 || matches[0].length !== 2) fail(`${policy.path} regex policy must match exactly once with exactly one capture group`);
  return matches[0][1];
}

function expectedValue(kind, manifest) {
  if (kind === "revision") return manifest.revision;
  if (kind === "packageVersion") return manifest.packageVersion;
  if (kind === "sourceArchiveUrl") return manifest.sourceArchiveUrl;
  fail(`unsupported policy value kind: ${kind}`);
}

function writePolicyValue(root, policy, manifest) {
  const path = safeConsumerPath(root, policy.path);
  const raw = readFileSync(path, "utf8");
  const value = expectedValue(policy.value, manifest);
  if (policy.kind === "json") {
    const document = JSON.parse(raw);
    setJsonPath(document, policy.jsonPath, value, policy.path);
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  const regex = new RegExp(policy.pattern, "gm");
  const matches = [...raw.matchAll(regex)];
  if (matches.length !== 1 || matches[0].length !== 2) fail(`${policy.path} regex policy must match exactly once with exactly one capture group`);
  const replacement = policy.replacement
    .replaceAll("{{revision}}", manifest.revision)
    .replaceAll("{{packageVersion}}", manifest.packageVersion)
    .replaceAll("{{sourceArchiveUrl}}", manifest.sourceArchiveUrl);
  writeFileSync(path, raw.replace(regex, () => replacement));
}

function readNpmDependency(root, dependency) {
  const packageJsonPath = safeConsumerPath(root, dependency.packageJson);
  const packageLockPath = safeConsumerPath(root, dependency.packageLock);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
  const requested = packageJson?.dependencies?.[dependency.packageName];
  const revision = parseArchiveRevision(requested);
  const expectedNode = packageLock?.packages?.[`node_modules/${dependency.packageName}`];
  if (packageLock?.packages?.[""]?.dependencies?.[dependency.packageName] !== requested) fail("consumer package-lock root dependency is stale or mismatched");
  if (!expectedNode || expectedNode.resolved !== requested) fail("consumer package-lock resolved Handoff archive is stale or mismatched");
  return { revision, packageJsonPath, packageLockPath, packageJson, packageLock, resolvedVersion: expectedNode.version };
}

function revisionFromPolicies(root, policies) {
  const values = policies.filter((policy) => policy.value === "revision").map((policy) => readPolicyValue(root, policy));
  if (values.length === 0) fail("source-checkout consumer requires at least one revision pinPolicy");
  if (values.some((value) => typeof value !== "string" || !SHA.test(value))) fail("source-checkout revision pinPolicy is not an exact 40-character SHA");
  if (new Set(values).size !== 1) fail("consumer revision pinPolicies disagree before refresh");
  return values[0];
}

function verifyPolicies(root, policies, manifest) {
  for (const policy of policies) {
    const actual = readPolicyValue(root, policy);
    const expected = expectedValue(policy.value, manifest);
    if (actual !== expected) fail(`${policy.path} pin policy mismatch for ${policy.value}`);
  }
}

function inspectConsumer(root, config) {
  let currentRevision;
  let npmState = null;
  if (config.dependency.kind === "npm-github-archive") {
    npmState = readNpmDependency(root, config.dependency);
    currentRevision = npmState.revision;
  } else {
    currentRevision = revisionFromPolicies(root, config.pinPolicies);
  }
  const currentManifest = artifactManifest(currentRevision, config.nativeHelpers.sourceRoots);
  if (npmState && npmState.resolvedVersion !== currentManifest.packageVersion) fail("consumer package-lock Handoff version disagrees with the pinned revision");
  verifyPolicies(root, config.pinPolicies, currentManifest);
  return { currentRevision, currentManifest, npmState };
}

function updateNpmDependency(root, dependency, manifest) {
  const path = safeConsumerPath(root, dependency.packageJson);
  const packageJson = JSON.parse(readFileSync(path, "utf8"));
  if (!packageJson?.dependencies || !(dependency.packageName in packageJson.dependencies)) fail("consumer package.json does not contain the Handoff dependency");
  packageJson.dependencies[dependency.packageName] = manifest.sourceArchiveUrl;
  writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function refreshLockfile(root) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : "npm";
  const args = npmExecPath
    ? [npmExecPath, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]
    : ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) fail(`failed to launch npm for lockfile refresh: ${result.error.message}`);
  if (result.status !== 0) fail(`npm lockfile refresh failed (${result.status}): ${(result.stderr || result.stdout || "").trim().slice(0, 500)}`);
}

function verifyTarget(root, config, targetManifest) {
  if (config.dependency.kind === "npm-github-archive") {
    const npmState = readNpmDependency(root, config.dependency);
    if (npmState.revision !== targetManifest.revision) fail("consumer package.json did not resolve to requested Handoff revision");
    if (npmState.resolvedVersion !== targetManifest.packageVersion) fail("consumer package-lock version does not match requested Handoff revision");
  } else {
    const revision = revisionFromPolicies(root, config.pinPolicies);
    if (revision !== targetManifest.revision) fail("consumer source-checkout pin does not match requested Handoff revision");
  }
  verifyPolicies(root, config.pinPolicies, targetManifest);
}

function touchedPaths(config) {
  const paths = new Set(config.pinPolicies.map((policy) => policy.path));
  if (config.dependency.kind === "npm-github-archive") {
    paths.add(config.dependency.packageJson);
    paths.add(config.dependency.packageLock);
  }
  return [...paths].sort();
}

function backupFiles(root, paths) {
  return new Map(paths.map((path) => [safeConsumerPath(root, path), readFileSync(safeConsumerPath(root, path))]));
}

function restoreFiles(backups) {
  for (const [path, contents] of backups) writeFileSync(path, contents);
}

function verifyUpstreamConsumerDist(revision) {
  const head = git(["rev-parse", "HEAD"]);
  if (revision !== head) fail("--verify-consumer-dist requires requested revision to equal the current Handoff HEAD");
  if (git(["status", "--porcelain"])) fail("--verify-consumer-dist requires a clean Handoff working tree");
  const result = spawnSync("npm", ["run", "verify:consumer-dist"], { cwd: HANDOFF_ROOT, encoding: "utf8", stdio: "inherit" });
  if (result.error || result.status !== 0) fail("Handoff consumer-dist verification failed");
}

function consumerRoot(value) {
  if (!value) fail("--consumer is required");
  const root = realpathSync(resolve(value));
  return root;
}

function configPath(root, value) {
  if (!value) fail("--config is required");
  const path = isAbsolute(value) ? value : join(root, value);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("consumer refresh config must be a regular non-symlink file");
  return path;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const revision = exactRevision(args.revision);
  if (args.command === "manifest") {
    output(artifactManifest(revision));
    return;
  }

  const root = consumerRoot(args.consumer);
  const config = parseConfig(configPath(root, args.config));
  const targetManifest = artifactManifest(revision, config.nativeHelpers.sourceRoots);
  const before = inspectConsumer(root, config);

  if (args.command === "verify") {
    verifyTarget(root, config, targetManifest);
    if (args.verifyConsumerDist) verifyUpstreamConsumerDist(revision);
    output({
      schemaVersion: 1,
      status: "verified",
      previousRevision: before.currentRevision,
      requestedRevision: revision,
      packageVersion: targetManifest.packageVersion,
      touchedFiles: [],
      nativeHelpers: {
        rebuildRequired: false,
        sourceTrees: targetManifest.nativeHelperBuildInputs
      },
      verification: { packagePinExact: true, pinPoliciesExact: true, consumerDistVerified: args.verifyConsumerDist }
    });
    return;
  }

  const paths = touchedPaths(config);
  const backups = backupFiles(root, paths);
  try {
    if (config.dependency.kind === "npm-github-archive") updateNpmDependency(root, config.dependency, targetManifest);
    for (const policy of config.pinPolicies) writePolicyValue(root, policy, targetManifest);
    if (config.dependency.kind === "npm-github-archive" && before.currentRevision !== revision) refreshLockfile(root);
    verifyTarget(root, config, targetManifest);
    if (args.verifyConsumerDist) verifyUpstreamConsumerDist(revision);
  } catch (error) {
    restoreFiles(backups);
    throw error;
  }

  output({
    schemaVersion: 1,
    status: before.currentRevision === revision ? "unchanged" : "updated",
    previousRevision: before.currentRevision,
    requestedRevision: revision,
    packageVersion: targetManifest.packageVersion,
    sourceArchiveUrl: targetManifest.sourceArchiveUrl,
    touchedFiles: before.currentRevision === revision ? [] : paths,
    nativeHelpers: {
      rebuildRequired: config.nativeHelpers.mode === "rebuild-required" && before.currentRevision !== revision,
      sourceTrees: targetManifest.nativeHelperBuildInputs
    },
    verification: { packagePinExact: true, pinPoliciesExact: true, consumerDistVerified: args.verifyConsumerDist }
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`consumer-refresh: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
