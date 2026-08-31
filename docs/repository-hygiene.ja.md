# Repository worktree / branch hygiene

Issue #144はrepository hygieneだけを扱います。branch名、closed PR、GitHubのremote branch自動削除だけからcleanup安全性を推測してはいけません。

## Invariant

- 未知のworktreeへblanketな `git clean`、`git branch -D`、destructive cleanupを実行しない。
- dirty worktreeは、Humanが変更内容を明示分類するまで**必ず保持**する。
- upstream `[gone]` は削除可能性の証拠ではない。squash mergeされたPR headは通常`main`のancestorにならない。
- 自動的にremove候補とみなせるworktreeは、cleanかつexact HEADがcurrent `origin/main`のancestorであるものだけ。
- cleanなnon-main historyにremote branch/tagが残っていればreferenced workとして保持する。
- cleanでも`origin/main`非到達かつremote/tag referenceなしならmanual review必須。squash-merged evidenceまたはlocal-only workの可能性がある。
- primary worktreeはaudit toolからcleanup候補にしない。
- active WIPは周辺cleanup前に、pushed remote branchやreview済みtagなど意図したdurable referenceを持たせる。

## Audit

最新refを取得してからread-only auditを実行します。

```sh
git fetch --prune origin
npm run audit:worktrees
node scripts/audit-worktrees.mjs --json
```

audit tool自身はworktree/branchを一切削除しません。dispositionは以下です。

- `preserve_primary[_dirty]` — primary checkout。auto-remove禁止。
- `blocked_dirty` — uncommitted/untracked stateあり。触らない。
- `safe_remove_reachable` — cleanかつexact HEADが`origin/main`から到達可能。
- `safe_remove_worktree_only` — 同じ証明だがcheckout branchが`main`。linked worktreeだけremoveし、branchは削除しない。
- `preserve_referenced` — cleanなnon-main historyにremote/tag referenceが残る。
- `review_unreachable` — cleanだが`origin/main`非到達、remote/tag referenceなし。manual review必須。

## Removal procedure

`safe_remove_*` の行だけが対象です。

1. remove直前にauditを再実行する。
2. 対象が引き続き `dirty=no` / `main=yes` であることを確認する。
3. exact pathだけ `git worktree remove <path>` でremoveする。
4. non-`main` local branchはworktree remove後、通常の `git branch -d <branch>` だけを使う。force deleteは禁止。
5. auditと `git worktree list` を再実行する。

per-path proofの代わりに `git worktree prune` を使いません。filesystem stateを事前review済みで、active path recoveryが不要な場合だけ補助的に使用できます。

## GitHub auto-delete

GitHubがmerged PR branchを削除するとlocal upstreamは`[gone]`になります。その場合も次のいずれかになるまでlocal branch/worktreeを保持します。

- exact HEADが`origin/main`から到達可能である。
- Humanがsquash/rebase mergeを検証し、削除前に別のdurable referenceを意図的に記録した。

これにより「merge済みに見えるbranch」をlocal-only workと取り違えて消す事故を防ぎます。
