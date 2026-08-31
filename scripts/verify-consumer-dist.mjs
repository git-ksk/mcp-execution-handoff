import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const stage = mkdtempSync(path.join(os.tmpdir(), "handoff-consumer-dist-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function trackedFiles() {
  const output = execFileSync("git", [
    "ls-files", "-z", "--", "package.json", "package-lock.json", "dist"
  ], { cwd: root });
  return output.toString("utf8").split("\0").filter(Boolean);
}

try {
  const files = trackedFiles();
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes("package-lock.json"));
  assert.ok(files.includes("dist/index.js"));

  for (const relative of files) {
    const destination = path.join(stage, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, relative), destination);
  }

  assert.equal(existsSync(path.join(stage, "src")), false, "consumer stage must not contain TypeScript source");
  assert.equal(existsSync(path.join(stage, "tsconfig.json")), false, "consumer stage must not require a TypeScript build");

  const pkg = JSON.parse(readFileSync(path.join(stage, "package.json"), "utf8"));
  assert.equal(pkg.private, true, "consumer-ready source artifacts do not imply npm publication");

  execFileSync(npm, [
    "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"
  ], { cwd: stage, stdio: "inherit" });

  const requiredExports = [
    "ExecutionHandoffState",
    "InheritedFdNativeRuntimeProvider",
    "SignedFileHandoffCheckpointStore",
    "SpawnedWebRtcRuntimeProvider",
    "TakeoverBroker",
    "WindowHandoffAdapter",
    "TerminalHandoffAdapter",
    "claimHandoffOwner",
    "createHandoffOwner"
  ];
  const importScript = `
    const root = await import('./dist/index.js');
    const required = ${JSON.stringify(requiredExports)};
    for (const name of required) {
      if (!(name in root)) throw new Error('missing public export: ' + name);
    }
    for (const subpath of [
      './dist/core/index.js',
      './dist/mcp/index.js',
      './dist/browser-takeover/index.js',
      './dist/window-takeover/index.js',
      './dist/terminal-takeover/index.js'
    ]) await import(subpath);
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", importScript], {
    cwd: stage,
    stdio: "inherit"
  });

  process.stdout.write(`consumer dist verified from ${files.length} tracked artifacts\n`);
} finally {
  if (process.env.HANDOFF_KEEP_CONSUMER_STAGE === "1") {
    process.stdout.write(`consumer stage retained: ${stage}\n`);
  } else {
    rmSync(stage, { recursive: true, force: true });
  }
}
