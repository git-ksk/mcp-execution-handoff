# Repository worktree and branch hygiene

Issue #144 tracks repository hygiene only. Cleanup must never infer safety from a branch name, a closed PR, or GitHub's automatic remote-branch deletion.

## Invariants

- Never run blanket `git clean`, `git branch -D`, or destructive cleanup against an unknown worktree.
- Dirty worktrees are **always preserved** until a Human explicitly classifies the changes.
- A `[gone]` upstream is not evidence that the local branch is disposable. Squash-merged PR heads are commonly not ancestors of `main`.
- A worktree may be automatically considered removable only when it is clean and its exact HEAD is an ancestor of the current `origin/main`.
- A clean non-ancestor with a surviving remote branch/tag is preserved as referenced work.
- A clean non-ancestor with no surviving remote/tag reference requires manual review. It may be squash-merged evidence or local-only work.
- The primary worktree is never a cleanup candidate from the audit tool.
- Active WIP must have an intentional durable reference such as a pushed remote branch or reviewed tag before any neighboring cleanup.

## Audit

Fetch current refs first, then run the read-only audit:

```sh
git fetch --prune origin
node scripts/audit-worktrees.mjs
node scripts/audit-worktrees.mjs --json
```

The tool never removes worktrees or branches. It reports one of:

- `preserve_primary[_dirty]` — primary checkout; never auto-remove;
- `blocked_dirty` — uncommitted/untracked state exists; do not touch;
- `safe_remove_reachable` — clean and exact HEAD is reachable from `origin/main`;
- `safe_remove_worktree_only` — same proof, but the checked-out branch is `main`; remove only the linked worktree, never the branch;
- `preserve_referenced` — clean non-main history still has a remote/tag reference;
- `review_unreachable` — clean but not reachable from `origin/main` and not remotely/tag referenced; manual review required.

## Removal procedure

For a `safe_remove_*` row only:

1. rerun the audit immediately before removal;
2. verify the worktree still reports `dirty=no` and `main=yes`;
3. remove that exact linked worktree with `git worktree remove <path>`;
4. for a non-`main` local branch, use ordinary `git branch -d <branch>` only after the worktree is gone; never force-delete;
5. rerun the audit and `git worktree list`.

Do not use `git worktree prune` as a substitute for per-path proof. It is acceptable only after the filesystem state has already been reviewed and no active path is being recovered.

## GitHub auto-delete behavior

When GitHub deletes a merged PR branch, the local upstream may become `[gone]`. Keep the local branch/worktree until one of these is true:

- its exact HEAD is reachable from `origin/main`; or
- a Human verifies the squash/rebase merge and intentionally records another durable reference before removing it.

This prevents a squash-merged-looking branch from being mistaken for disposable local-only work.
