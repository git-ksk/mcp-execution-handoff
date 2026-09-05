# Deterministic consumer refresh contract

`mcp-execution-handoff` のsource releaseはimmutableを維持し、packageも `private: true` のままです。Handoffをapplication imageやnative bundleへ組み込むconsumerは、Handoff revision変更時に **consumer artifact/imageを再buildし、新しいcandidate revisionをstageする必要があります**。ここで定義するrefresh contractはdependency/pin stagingを自動化するもので、running serviceのin-place更新、consumer deploy、cloud credential保持、traffic切替は行いません。

#237で追跡し、v0.4.4 hardening lineで導入します。

## Handoff artifact manifest

exact Handoff Git SHAからdeterministicなmachine-readable manifestを生成できます。

```bash
npm run consumer:refresh -- manifest --revision <40-character-sha>
```

manifestに含めるのはreproducibleなsource-release metadataだけです。

- repository identity;
- exact 40文字Git revision;
- そのrevisionのpackage version;
- canonical immutable GitHub source archive URL;
- `package.json` / `package-lock.json` / committed `dist/` のGit object identity;
- consumerが明示したnative-helper build-input rootのGit tree identity（任意）。

時刻、branch名、mutable `latest`、deployment credential、consumer identity、target-service state、Human contentは含めません。

## Consumer config schema v1

consumer側が小さなJSON configを所有します。Handoff側でMaps / Cinema / CUMG / Cloud Run固有pathをhard-codeしません。

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

`https://github.com/git-ksk/mcp-execution-handoff/archive/<sha>.tar.gz` をpinするconsumer向けです。変更前に `package.json`、lockfile root dependency、installed-package lock record、package version、宣言済みpin policyが同じcurrent immutable Handoff revisionを示すことを必須にします。その後 `package.json` を更新し、`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` でlockをrefreshし、requested archive/versionへexact resolveしたことを再検証します。stale/mismatched lockfileは変更前にfail closedします。

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

regex policyはexactly one matchかつcurrent valueを表すcapture groupをexactly oneだけ持つ必要があります。JSON policyは明示した既存pathだけを更新します。対象fileはconsumer checkout内のregular non-symlink fileに限定します。複数revision policyがrefresh前に一致しなければfail closedします。

`nativeHelpers.mode = "rebuild-required"` の場合、revision変更時に `nativeHelpers.rebuildRequired: true` と宣言source rootのexact Git tree identityを返します。これはbuild-input contractであり、**native helperが再build済みだという証明ではありません**。consumer CIはrequested Handoff revisionからhelperを再build/stageしてからcandidateをadmitする必要があります。古いhelperを新pinと暗黙互換として扱うことを防ぎます。

## Apply / verify

requested commit objectを持つHandoff checkoutから実行します。

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

`apply` はpreflight整合確認後、変更対象fileをsnapshotし、明示宣言された更新だけを適用し、必要ならnpm lockfileをrefreshし、最後にrequested exact identityを再検証します。apply / lock refresh / verificationの途中で失敗した場合はsnapshotしたfileを元へ戻してfailureを返します。`verify` はread-onlyです。

stable JSON resultにはprevious/requested revision、package version、変更file、native-helper rebuild requirement/source-tree identity、exact-pin verification statusを含めます。consumer test、image build、deployment revision作成、target-service semantic確認、traffic切替は行いません。

`--verify-consumer-dist` でHandoff committed-dist contractも追加確認できますが、requested revisionがcleanなcurrent Handoff `HEAD` と一致する場合だけです。consumer CIの代替にはしません。

## Refresh後にconsumerが必ず行うこと

責務境界は次のままです。

```text
exact Handoff revision
  -> deterministic refresh/stage
  -> consumer tests
  -> immutable consumer/native artifactを再build
  -> consumer-owned candidate deploy/readiness
  -> consumer-owned explicit traffic decision
```

Cloud Runなら通常は0%-traffic candidate revisionとconsumer固有public preflightを通してからtrafficを判断します。これらdeployment stepはHandoff外です。runtime `npm install`、fetch-on-start、mutable branch ref、shared mutable dependency directory、自動downstream merge、implicit traffic changeはこのcontractではサポートしません。
