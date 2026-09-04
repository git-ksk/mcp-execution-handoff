# Product Readiness / consumer compatibility

この文書はHandoffの **Product Readiness** trackを定義します。Transport maturity、hosted topology、
npm publicationとは別の軸です。transportが安定していてもsource artifact、upgrade、consumer evidence、
native helper delivery、Human-visible lifecycleが未成熟ならproduct-readyとは扱いません。逆にpackagingが
成熟してもTarget Surface authorityを広げたり、Handoffをremote desktop productへ変更したりしません。

#151で追跡します。Target Surfaceのsupport claimは
[Component ownership and support matrix](component-support-matrix.md) とそのexecutable gateを正本とします。

## 現在のproduct boundary

現在は `private: true` の **v0.4.0 GitHub/source release** がbaselineです。

- committed `dist/` はsource-release JavaScript artifactとしてconsumer-readyです。CIはtracked package
  metadata + `dist/` だけをstageし、TypeScript source/build設定を含めずproduction dependencyだけを導入し、
  public entry pointとconsumer-required exportを `npm run verify:consumer-dist` で検証します。
- npm publicationは有効化しておらず、maturityの指標にも使いません。
- macOS/Linuxのnative/OS helperをuniversal prebuilt binaryとしてはclaimしません。
- Browser / bounded Window / bounded Terminal-PTYは別々のfirst-class componentです。Product Readinessを
  理由にunsupported surfaceやhidden desktop fallbackを追加してはいけません。

## Evidence class

consumer evidenceはrevisionとscopeが明確な場合だけrelease evidenceとして扱います。

1. **Deterministic upstream** — Handoff-owned unit/conformance/portability/CI。
2. **Consumer integration** — exact consumer commitがexact Handoff commit/package artifactをimport/stageし、
   consumer contract testを通過。
3. **Physical component** — Handoff-owned physical acceptanceをexact Handoff revisionで実施。
4. **Physical consumer dogfood** — exact consumer commit + exact Handoff revisionでreal Human flowを実施。

古いphysical evidenceを新revisionへ自動継承しません。新revisionは自身のCIでdeterministic coverageを得ますが、
physical evidenceは実際にexerciseしたrevisionの証拠のままです。

### 現在のconsumer evidence ledger

| Consumer | Consumer revision | Handoff revision/artifact | Evidence | 意味 |
| --- | --- | --- | --- | --- |
| `git-ksk/maps-browser-mcp` | `025ec6a882b0851d75f5b19001d354467ec353dd` (`origin/main`, 2026-08-31観測) | immutable source pin `4f9d809eec812213e404a6d5a6d7d04029170f50` | Consumer integration + consumer側にhistorical physical Browser evidence | detached `origin/main` worktreeで `npm ci --ignore-scripts` + full `npm run check` を実行し、typecheck、351 tests（346 pass / 5 platform skip）、acceptance-harness syntaxがimmutable Handoff pinでPASSしました。過去のdirect/TURN/Cloud Run physical evidenceはMaps側で明記されたrevisionにだけ帰属し、このdeterministic rerunをfresh physical runとは扱いません。 |
| `git-ksk/japan-cinema-browser-mcp` | `7ec79a682dbeabd371cf28c3422d2d14a49c5ab9` (`origin/main`, 2026-08-31観測) | immutable source pin `a56cdf22ae6fcf6201c08de7974e01ef5795f6b3` | Consumer integration | detached `origin/main` worktreeで `npm ci --ignore-scripts` + full `npm run check` を実行し、typecheck + 165/165 testsがimmutable Handoff pinでPASSしました。Cinemaはpointer/scroll-onlyの狭いpolicyを維持し、TOHO Gate 0b physical acceptanceはconsumer-owned/pendingのままです。 |
| `git-ksk/computer-use-mcp-gateway` | `1957921948a3a082a95d9801ee690ec02ed66f4e` (`origin/main`, 2026-08-31観測) | source artifact `096b2e18e5bc582101bfde09330316af9490056e` | Consumer integration / production-style staging preflight | fresh private runtime stageでproduction dependencyのみ、`.bin`除去、dependency symlinkなしを確認し、CUMG `verify-import`で9 required exportsがPASS。CUMG preflight unitも14/14 PASS。過去のWindow/Terminal physical dogfoodは別revisionのevidenceとして扱います。 |

machine-readable正本は [`consumer-compatibility-evidence.json`](consumer-compatibility-evidence.json) です。Handoff CIはrevision/evidence class/validation/limitationがclosed-formで記録されていることを検証します。外部consumer test自体は各recordのexact consumer worktreeで実行したevidenceであり、Handoff CIが外部repositoryをcloneして再実行するものではありません。

release-significantなconsumer validationでは最低限、consumer repository/commit、exact Handoff commit/package/digest、
evidence class、必要ならTarget Surface/host/transport、実行command/workflow、結果/日付、未検証boundaryを記録します。
branch名、`latest`、dirty local tree、unpinned archiveはrelease evidenceにしません。

## Delivery boundary

### JavaScript runtime

GitHub/source-releaseのJavaScript contractはtracked package metadata + committed `dist/` です。consumerは
TypeScript sourceなし・compileなしでstageできます。release gateは `npm run verify:consumer-dist` と通常CIです。
これはnpm registry availabilityを約束しません。

### macOS helper

macOS Window/WebRTC helperは `experiments/thin-takeover-runtime` のtracked Swift packageからbuildします。
source releaseはuniversal/notarized binaryをclaimしません。deployment側でexact Handoff source revision、review済み
Swift/Xcode toolchain、persistent TCC attributionが必要な場合のstable code-sign identity/designated requirement、
private install path、controlled device側のTCC/Accessibility/Screen Recordingを管理します。live helperのin-place
replacementは避けます。

将来prebuilt macOS helperを配布する場合、code signing、notarization、artifact digest/provenance、upgrade/rollbackを
release gateへ昇格させます。

### Linux helper

Linux exact-window pathはtracked JavaScript/runtime helperに加え、X11/Xvfb、ffmpeg、XTEST/xdotoolまたはnative X11
helper、必要に応じてAT-SPI metadataを利用します。現在のsource releaseはsingle hermetic Linux binaryやuniversal ABIを
claimしません。deploymentはHandoff revisionとOS/runtime dependencyをpinし、exact-window helperをfail-closedに維持し、
claimするsurfaceに対応するLinux acceptance/portabilityを実行します。

## Upgrade / rollback / compatibility

upgradeは「fileを置き換えて古いHuman sessionを継続する」処理ではなく、paired artifact/state transitionです。

- consumer serviceをdrain/replaceする前にnew artifactをstage/import/preflightする。
- old/new Handoff revisionとconsumer revisionを記録する。
- old locator/capability/client generation/media-input session/Agent-Human authorityを復元しない。
- durable recoveryは常に `reissue_and_revalidate`。checkpoint metadataを読めてもtarget/session authorityはfreshに
  再構成し、schema/ownership/expiry/target revalidation失敗時はfail closedする。
- semantic verification/replay policyはconsumer-owned。rollbackだけでprior actionをsuccess/replay可にしない。
- checkpoint/audit/operator schema compatibility変更時はsupported version rangeとmigration/deprecationを明記する。
  unknown/unsupported durable dataをlive authorityへcoerceしない。
- rollbackはreview済みpaired runtime/config artifactを戻し、failed upgradeのmutable transport/session stateを再利用しない。

CUMGのgeneration staging/preflightはこのmodelの有用なconsumer evidenceですが、全consumerにCUMG topologyを要求しません。

## Human-visible lifecycle quality

stale UIがauthorityを誤認させる場合、presentationもproduct correctnessです。

```text
connecting -> human_active -> verifying -> closed
                         \-> unavailable
```

- `connecting` はHuman authority取得済みを意味しない。
- `human_active` はcurrent valid Human generationと一致する。
- `Done` はconsumer verification前にHuman mutationを即fenceする。
- `verifying` でstale interactive controlを操作可能に見せない。
- disconnect/unavailableは`Done`でもAgent resumeでもない。
- `closed`はHuman surfaceのterminal stateであり、consumer actionのapproval/successではない。

#150は完了済みのv0.4.0 Product Readiness evidenceです。physical iPhoneのLocalAuthentication OK / Cancel runで、exact target消失時にHuman inputをfenceし、stale secure frameを消去し、non-interactiveなverifying stateへ移行し、consumer-owned verification後だけterminal successへ進むことを確認しました。backend lifecycleが正しくてもold controlをactiveに見せるpresentation defectはproduct-quality defectとして扱います。

## Diagnostics / resource / supply chain

- framebuffer、raw Human input、PTY/browser content、credential/token/OTP、account identity、private target identifierを
  generic log/audit/checkpointへ入れない。
- bounded operator diagnosticsはversioned/content-freeを維持する。
- latency/resource改善はmeasurement-firstでauthority/backpressureを弱めない。
- Dependency Review、CodeQL、cross-platform portability、committed-dist sync、clean consumer artifact gateをrelease evidenceに残す。
- prebuilt native binaryを配布する前にprovenance/signing要件を強化する。

## Product Readinessと別track

以下はProduct Readinessとは別に進めます。

- provider-neutral relay/connectivity #19
- hosted control-plane/stateful worker #12
- explicit Desktop authority/session #125/#161
- maturity演出のためだけのnpm publication
- consumer固有browser/profile/PTY/process policy
- consumer semantic verification / consequential-action approval
