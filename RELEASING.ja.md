# リリース手順

[English](RELEASING.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

このプロジェクトでは、delivery decisionを意図的に2つへ分離します。

1. **GitHub source release** — reviewedな`main` commitにversion tagを付け、GitHub Releaseを公開する。
2. **npm publication** — 将来の別gate。packageは `private: true` のままで、source releaseを出しても `npm publish` を意味しません。

**v0.3.0** が現在のGitHub/source-release baselineで、`v0.3 — Recovery & Observability`（#127〜#130）完了後、milestone `v0.3.0 — Source Release` とIssue #145で追跡します。non-blockingなv0.3.x maintenance（#141〜#144）は別扱いで、後続のrelay / hosted / desktop maturity（#19 / #12 / #125）もrelease blockerにはしません。

## Versioning policy

npm未公開の間もSemVerをcompatibility signalとして使います。

- `0.1.x`: v0.1 public contractを維持するfix / docs更新。
- `0.2.0`: v0.1.0以降にpublic surfaceが本質的に拡張したことを示すpre-1.0 minor。first-class Browser / Window / Terminal componentとpackage subpathを含む。
- later `0.2.x`: public-contract milestoneを増やさずに行えるcompatible hardeningやbounded host/transport改善。
- それ以降のpre-1.0 minor: public contractやdeployment semanticsが再び本質的に拡張する場合に使う。

`v0.2` のようなroadmap familyには、`v0.2.0` 公開後に入るworkも含められます。v0.2方向のIssueだからといって、最初のv0.2 source releaseを自動的にblockするわけではありません。

## Source releaseの前提条件

final release PRを作る前に次を確認します。

- release milestoneに実際のblockerが明示されている。
- blocker issueがclose済み、またはnon-blocking判断が明文化されている。
- `main` / `origin/main` / GitHub `main` が一致する。
- release worktreeがcleanで、そのexact commitをbaselineにしている。
- documented invariantを無効化するknown security issueが残っていない。
- required CI / portability / Dependency Review / CodeQL gateが動作している。
- npm publication gateが別途承認されていない限り、`package.json` は `private: true` のまま。

同じroadmap familyに記載されているだけのoptional featureをrelease blockerへ昇格させません。

## Final release PR

final release PRは、blocker修正が必要な場合を除きrelease bookkeepingだけにします。

1. `package.json` と `package-lock.json` をtarget versionへ上げる。
2. `CHANGELOG.md` の対象entryを `[Unreleased]` から `[X.Y.Z] - YYYY-MM-DD` へ移す。
3. 最新source releaseを説明するREADME / Roadmapを更新する。
4. source-only releaseでは `private: true` を維持する。
5. clean installから後述のrelease validationを全部通す。

v0.3.0ではIssue #145をauthoritative checklistとして使います。historicalなv0.2.0はIssue #119でした。

## Release validation

clean checkout/worktreeから実行します。

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm audit --audit-level=moderate
npm pack --dry-run
```

pack内容には少なくとも次のintended public artifactが入ることを確認します。

- root export
- `./core`
- `./mcp`
- `./browser-takeover`
- `./window-takeover`
- `./terminal-takeover`

build済みentry pointもsmoke importします。代表例:

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

final PRではGitHubのrequired checksもすべてgreenにします。local greenをprotected-branch checkの代用にはしません。

## GitHub source releaseの公開

release PR merge後:

1. fetchして、merged `main` のexact commitを確認する。
2. そのexact commitへ `vX.Y.Z` tagを作る。既存version tagをforce-move / silent retagしない。
3. そのtagからGitHub Release `vX.Y.Z — Source Release` を公開する。
4. `private: true` の間はnpm未公開であることを明記する。
5. tagとGitHub Releaseが意図したcommitを指すことを確認する。
6. README / Roadmap / CHANGELOGが新releaseと一致することを確認する。
7. ここまで通ってからrelease-gate issueとmilestoneをcloseする。

releaseに不備があった場合はcorrective follow-up versionを優先し、公開済みtagを書き換えることを通常のcleanupにしません。

## npm publicationは別gate

source release手順の中で `npm publish` は実行しません。

将来npm公開する場合は、Roadmapのnpm publication gateを独立に満たします。package名/export stability、provenance、least-privilege credential、artifact inspection、exact packageによるconsumer validation、SemVer/migration documentation、rollback/deprecation procedureを確認します。
