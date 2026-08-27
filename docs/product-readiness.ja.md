# Product Readiness boundary

[English](product-readiness.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

Product Readinessはcompatibilityとdeliveryを横断するtrackです。Target Surfaceの機能追加や
v0.4+ transport / hosted topology roadmapとは分離します。またnpm publishを必須条件には
しません。source releaseとして成熟・再現可能でも、installable artifactの配布は未承認のまま
維持できます。

## 現在のdelivery claim

現在の `v0.3.0` baselineは **GitHub source release** です。

- `package.json` は `private: true` のままで、npm packageは未公開です。
- package manifestはcandidateとなるJavaScript/TypeScript package shape（`dist`、公開docs、
  package subpath）を記述しますが、npmで利用可能というclaimではありません。
- macOS Swift takeover helperはacceptance / consumer integration向けにrepository sourceから
  buildしており、独立version・署名・notarize済みbinary productとしては配布していません。
- Linux native / accessibility helperのbuild inputもrepository-owned implementation materialです。
  将来package化する場合はsource-buildをbinary deliveryとみなさず、build / ABI-runtime /
  provenance / update境界を明示します。

source tag、`npm pack` 成功、consumer-local helper buildだけを根拠にinstallable binary releaseと
表現してはいけません。

## 実consumer compatibility evidence

現在のcompatibility setは次の3 consumerです。

| Consumer | 関連する実証済みHandoff boundary |
| --- | --- |
| `git-ksk/maps-browser-mcp` | Browser Handoffとcredential-safe external Human flow |
| `git-ksk/japan-cinema-browser-mcp` | Browser Handoffとcredential-safe external Human flow |
| `git-ksk/computer-use-mcp-gateway` | first-class bounded Window / Terminal-PTY adapterとmacOS physical dogfood |

release-significantな変更では、**exact** Handoff revisionまたはexact candidate package artifactに
対してevidenceを記録します。「latest」、pinされていないbranch名、古いconsumer checkoutでの
成功は十分なevidenceではありません。

compatibility recordでは必要に応じて次を記録します。

- consumer repositoryとtested consumer revision
- exact Handoff commit/tagまたはpackage artifact identity
- 影響するadapter / Target Surface
- clean install / build結果
- deterministic contract / E2E結果
- 必要なphysical acceptance結果
- 意図的に未検証のconsumerと、その変更に無関係である理由

consumer成功はHandoff自身のdeterministic / portability / security / physical gateを補完するもので、
置き換えるものではありません。

### Release-significant change

少なくとも次はcompatibility review対象です。

- exported API / type / package-subpath変更
- authority / epoch / lease / reconnect / completion / replay semantics変更
- checkpoint / recovery schemaやcompatibility behavior変更
- stable audit / operator diagnostics contract変更
- Browser / Window / Terminal adapter lifecycle変更
- native/helper wire、invocation、build、required runtime変更
- consumerへ影響するpackage contents、engine requirement、dependency変更

consumer behaviorを変更し得ないdocumentation-only fixは、無関係なconsumer acceptanceの代わりに
`not applicable` と記録できます。

## Source / package / native-helper境界

Product Readinessのclaimは対象delivery layerを明示します。

### Source-built consumer

source consumerはimmutableなHandoff revisionをpinし、必要なJavaScript/TypeScriptとhelper componentを
repository sourceからbuildできます。source-release gateが証明するのはこのrepository shapeであり、
documented source revision外のbinary helper compatibilityまでは約束しません。

### Candidate npm artifact

`private: true` の間も `npm pack --dry-run` でcandidate package contentsを確認します。npm publish承認前には
別npm gateとして、exact-artifact consumer validation、provenance、least-privilege publishing credential、
migration impact、rollback / deprecation procedureも証明します。

### Native/helper artifact

macOS helperをdistributed product artifactと表現する前に最低限次を定義します。

- 再現可能なsource revision / build input
- artifact integrity / provenanceとrelease ownership
- macOS配布で必要となるcode-signing identity / notarization expectation
- entitlement / minimum OS compatibility expectation
- stale Human/Agent authorityを復元しないupdate / rollback behavior

Linux native / accessibility helperをdistributed product artifactと表現する前にも、supported architecture /
runtime / library boundary、build provenance、invocation contract、compatibility / rollback expectationを定義します。
review済みhelperが使えない場合に別helper/fallbackへsilent substitutionしてはいけません。

## Upgrade / rollback / compatibility

SemVerをcompatibility signalに使いますが、pre-1.0でも意図したchangeはあり得ます。consumer-visibleな
breaking changeではpre-1.0という理由だけに依存せずmigration behaviorを明記します。

upgrade / restart invariantはsource compatibilityより厳格です。

- upgrade/restartでstale Human/Agent capability、media/input session、locator、reconnect handle、PTY authority、
  queued Human inputを復元しない
- durable recoveryは `reissue_and_revalidate` のままで、旧checkpointをaction成功evidenceにしない
- checkpoint/schema変更ではold stateをaccept / reject / safely clearのどれにするか明示し、rejectはfail closed
- rollbackでpre-upgrade actionをreplayしたり、新しいdurable stateをsilent reinterpretしない
- consumer-visible contractの削除/deprecationでは、installable packageをproduct-readyと呼ぶ前にmigration /
  rollback pathをdocumentする

source rollbackを理由にpublished tagをforce-moveしません。corrective releaseを使い、published release provenanceは
immutableに保ちます。

## Human-visible lifecycleはcorrectness

Human surfaceではauthority stateを曖昧にしてはいけません。少なくとも関連transportは次と同等の状態を
視覚的に区別します。

`connecting -> human_active -> verifying -> closed/unavailable`

authorityが既にfenceされた後も旧frameやenabledに見えるcontrolが残る場合、backend verificationが成功していても
product correctness defectです。#150のmacOS LocalAuthenticationが具体例で、target消失時は旧Human surfaceを
clear/fenceして `verifying` へ進めますが、target消失自体をauthentication successにはしません。terminal success /
closedへ進めるのはfreshなconsumer-owned semantic verificationだけです。

そのsurfaceが状態を公開する場合、stale frame/control除去、authority fencing、verified transition、non-success /
timeout behaviorをlifecycle regression evidenceとして固定します。

## Diagnostics / resource / supply chain

Product Readinessでも既存privacy boundaryを維持します。

- credential、Human input、frame/media content、raw target content、SDP/candidate address、execution argumentをgeneric
  durable diagnostics / audit stateへ入れない
- stable operator diagnosticsはbounded / reviewableのまま維持
- Human takeover responsiveness、process lifetime、memory/CPU、helper startupへ実質影響する変更ではlatency/resource
  regression evidenceを取る。すべてのdocs/logic patchへ無条件benchmarkを要求するわけではない
- Dependency Review、CodeQL、audit、package inspection、repository security reportingをrelease evidenceとして維持
- provenance claimはactual delivery layerへ一致させる。source tag、candidate npm tarball、将来native binaryは別artifact

## Release-significant changeのProduct Readiness gate

適用可能な次の項目がすべて成立したとき、その変更をProduct Readiness上completeとします。

1. Handoff自身のdeterministic / security / portability testがgreen
2. 必要なphysical acceptanceがgreen、または不要な理由をrelease recordへ明記
3. relevantな実consumerをexact candidate revision / artifactで検証
4. public/package/helper compatibility impactをdocument
5. upgrade/restart/rollbackがauthority / replay invariantを維持
6. Human-visible lifecycleがfenced authorityを誤表示しない
7. package/helper contentsとprovenance claimがactual deliveryと一致
8. packagingを簡単にするためconsumer semantic verificationをHandoffへ移さない

このgateはnpm/native-binary publication gateを満たさなくてもsource release向けに成立できます。
