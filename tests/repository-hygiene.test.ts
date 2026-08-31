import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const auditScript = path.resolve("scripts/audit-worktrees.mjs");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("worktree hygiene audit is read-only and classifies only exact-main reachability as removable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-worktree-audit-"));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  const reachable = path.join(root, "reachable");
  const localOnly = path.join(root, "local-only");
  const dirty = path.join(root, "dirty");
  try {
    fs.mkdirSync(repo);
    git(root, ["init", "--bare", remote]);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "handoff-test@example.invalid"]);
    git(repo, ["config", "user.name", "Handoff Test"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(repo, ["add", "base.txt"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "-u", "origin", "main"]);

    git(repo, ["worktree", "add", "-b", "reachable-evidence", reachable, "HEAD"]);
    git(repo, ["worktree", "add", "-b", "local-only-evidence", localOnly, "HEAD"]);
    fs.writeFileSync(path.join(localOnly, "local.txt"), "local\n");
    git(localOnly, ["add", "local.txt"]);
    git(localOnly, ["commit", "-m", "local-only"]);

    git(repo, ["worktree", "add", "-b", "dirty-evidence", dirty, "HEAD"]);
    fs.writeFileSync(path.join(dirty, "uncommitted.txt"), "do not delete\n");

    const output = execFileSync(process.execPath, [auditScript, "--repo", repo, "--json"], {
      encoding: "utf8"
    });
    const report = JSON.parse(output) as {
      worktrees: Array<{ branch: string | null; disposition: string; dirty: boolean; headInMain: boolean }>;
    };
    const byBranch = new Map(report.worktrees.map((row) => [row.branch, row]));

    assert.equal(byBranch.get("main")?.disposition, "preserve_primary");
    assert.equal(byBranch.get("reachable-evidence")?.disposition, "safe_remove_reachable");
    assert.equal(byBranch.get("reachable-evidence")?.headInMain, true);
    assert.equal(byBranch.get("local-only-evidence")?.disposition, "review_unreachable");
    assert.equal(byBranch.get("local-only-evidence")?.headInMain, false);
    assert.equal(byBranch.get("dirty-evidence")?.disposition, "blocked_dirty");
    assert.equal(byBranch.get("dirty-evidence")?.dirty, true);

    const source = fs.readFileSync(auditScript, "utf8");
    assert.doesNotMatch(source, /worktree["']?,\s*["']remove|branch["']?,\s*["']-D|clean["']?,\s*["']-f|worktree["']?,\s*["']prune/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
