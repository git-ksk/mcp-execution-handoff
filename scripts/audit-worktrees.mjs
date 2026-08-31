#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";

function run(cwd, args, options = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function parseArgs(argv) {
  let repo = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--repo") {
      const value = argv[++i];
      if (!value) throw new Error("--repo requires a path");
      repo = path.resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { repo, json };
}

function parseWorktrees(text) {
  const result = [];
  let current = {};
  for (const line of `${text}\n`.split("\n")) {
    if (!line) {
      if (current.worktree) result.push(current);
      current = {};
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? true : line.slice(space + 1);
    current[key] = value;
  }
  return result;
}

function lines(value) {
  return value ? value.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function branchName(ref) {
  return typeof ref === "string" && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

function isAncestor(repo, commit, ref) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], {
      cwd: repo, stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function upstreamState(repo, branch) {
  if (!branch) return { upstream: null, upstreamExists: false, upstreamTrack: null };
  const value = run(repo, [
    "for-each-ref", `refs/heads/${branch}`,
    "--format=%(upstream:short)|%(upstream:track)"
  ], { allowFailure: true });
  if (!value) return { upstream: null, upstreamExists: false, upstreamTrack: null };
  const [upstream = "", track = ""] = value.split("|", 2);
  const exists = Boolean(upstream) && Boolean(run(repo, ["rev-parse", "--verify", "--quiet", upstream], { allowFailure: true }));
  return { upstream: upstream || null, upstreamExists: exists, upstreamTrack: track || null };
}

function classify({ primary, dirty, headInMain, branch, remoteContains, tagsContain, upstreamExists }) {
  if (primary) return dirty ? "preserve_primary_dirty" : "preserve_primary";
  if (dirty) return "blocked_dirty";
  if (headInMain) return branch === "main" ? "safe_remove_worktree_only" : "safe_remove_reachable";
  if (upstreamExists || remoteContains.length > 0 || tagsContain.length > 0) return "preserve_referenced";
  return "review_unreachable";
}

function main() {
  const { repo: requestedRepo, json } = parseArgs(process.argv.slice(2));
  const repo = run(requestedRepo, ["rev-parse", "--show-toplevel"]);
  run(repo, ["rev-parse", "--verify", "origin/main"]);
  const worktrees = parseWorktrees(run(repo, ["worktree", "list", "--porcelain"]));
  const rows = worktrees.map((item, index) => {
    const worktree = path.resolve(String(item.worktree));
    const head = String(item.HEAD ?? "");
    const branch = branchName(item.branch);
    const status = run(worktree, ["status", "--porcelain=v1", "--untracked-files=all"], { allowFailure: true });
    const dirty = Boolean(status);
    const headInMain = Boolean(head) && isAncestor(repo, head, "origin/main");
    const remoteContains = lines(run(repo, ["branch", "-r", "--contains", head, "--format=%(refname:short)"], { allowFailure: true }));
    const tagsContain = lines(run(repo, ["tag", "--contains", head], { allowFailure: true }));
    const upstream = upstreamState(repo, branch);
    const primary = index === 0;
    return {
      worktree,
      head,
      branch,
      primary,
      dirty,
      headInMain,
      remoteContains,
      tagsContain,
      ...upstream,
      disposition: classify({ primary, dirty, headInMain, branch, remoteContains, tagsContain, upstreamExists: upstream.upstreamExists })
    };
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ repo, base: "origin/main", worktrees: rows }, null, 2)}\n`);
    return;
  }
  process.stdout.write("DISPOSITION\tDIRTY\tMAIN\tBRANCH\tHEAD\tWORKTREE\n");
  for (const row of rows) {
    process.stdout.write([
      row.disposition,
      row.dirty ? "yes" : "no",
      row.headInMain ? "yes" : "no",
      row.branch ?? "(detached)",
      row.head.slice(0, 12),
      row.worktree
    ].join("\t") + "\n");
  }
}

main();
