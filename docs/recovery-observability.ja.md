# Recovery / Observability boundary

この文書は `mcp-execution-handoff` v0.3で固める **durable recovery、audit、operator diagnostics** の境界を定義します。

v0.3では新しいTarget Surface、Human-control authority、transport、hosted database、replay engineを追加しません。既存のrecovery / observability primitiveをproduction-gradeなcontractへ昇格しつつ、次の原則を維持します。

> Durable stateはrestart後に「何を再検証すべきか」を示してよいが、古いAgent/Human authorityを復元してはならない。

作業はmilestone `v0.3 — Recovery & Observability` で追跡します。

- #127 — provider-neutralかつboundedなcheckpoint-store contract
- #128 — stableでprivacy-boundedなaudit event
- #129 — Target Surface横断のstable operator diagnostics
- #130 — stale authorityを復元しないcrash/restart conformance

## 現在のbaseline

現行sourceにはすでに土台があります。

- `SignedFileHandoffCheckpointStore` はHMAC保護 + private permissionのlocal checkpointを保存する
- `ExecutionHandoffRuntime` はbounded intervention metadataだけを保存し、recoveryは常に `reissue_and_revalidate`
- `ExecutionAuditSink` はcheckpoint/recovery向けの小さいcontrol-plane eventを受け取る
- Browser/Window WebRTCにはprivacy test付きのbounded stage/state/count/timing diagnosticsがある
- Browser / Window / Terminalはmedia、input、PTY byte、credential、target-service contentをgeneric durable stateへ入れない

v0.3ではこの安全性modelを置き換えるのではなく、provider-neutral化・stable化します。

## 3つのdata path

Checkpoint、audit、diagnosticsは意図的に別概念です。

| Path | 主目的 | default lifetime | authority復元可否 | Content rule |
| --- | --- | --- | --- | --- |
| Durable checkpoint | restart / revalidation hint | durable、TTL bounded | **不可** | 小さいHandoff control-plane recordのみ |
| Audit event | generic lifecycle metadataのoperator/compliance連携 | sink定義 | **不可** | stableかつboundedなmetadata projectionのみ |
| Diagnostics | troubleshooting / health / acceptance evidence | 原則process-memory | **不可** | bounded category/count/timingのみ |

consumerが許可済みdiagnostics projectionを独自operator systemへ保存することはできますが、それによってdiagnosticsがcheckpointやrecovery authority sourceになることはありません。

## Durable checkpoint contract

現行checkpoint schemaを、durableに許可するbaseline shapeとします。

- schema version
- adapter kind
- intervention id / status
- resource epoch
- resume policy
- stableかつnon-secretなprincipal binding
- optional action digest
- update timestamp
- expiry

将来provider-neutral storeへしてもstorage mechanismが変わるだけで、このtrust boundaryは広げません。schema validationはHandoff-ownedのままです。storage backendが任意consumer contentを返し、それをruntimeがtrusted recovery stateとして扱う設計にはしません。

### Generic durable stateへ入れてはいけないもの

generic checkpoint / audit / diagnostics APIを、次の情報の保存経路にしてはいけません。

- raw tool/action argument
- Human input / 入力文字列
- browser/page/DOM/network content
- framebuffer、screenshot、video、audio
- PTY input/output/transcript content
- credential、password、cookie、bearer/session token、private key
- OTP/MFA/challenge answer
- payment data
- consumer approval receiptやdomain固有の重大操作evidence
- live takeover capability、reconnect handle、requestState、client generation、ICE/SDP/key material等のtransport secret

consumer固有stateが必要な場合はconsumer-ownedです。Handoff storage interfaceの裏へ置いただけでgenericに安全になるわけではありません。

## Restart authority model

restartは「ephemeral execution authorityの喪失」として扱い、transparent continuationにはしません。

```text
active intervention
        |
        | process / consumer crash
        v
すべてのephemeral mutation authorityを失う
        |
        | bounded checkpointをload + validate
        v
recovery record: reissue_and_revalidate
        |
        +--> principal / adapter / integrity / expiry mismatch --> fail closed
        |
        v
consumerがfreshなtarget/session stateを再構築
        |
        v
consumerがsemantic/postconditionを再検証
        |
        +--> cancel / fresh Human round / safe reissue
        |
        v
通常lifecycleからのみfresh authorityを取得
```

checkpointは「interventionが存在した」「どのbounded resume policyだったか」をoperator/consumerへ伝えられます。しかし次はできません。

- crash前のHuman leaseを再claimする
- Agent mutation authorityを復活する
- browser/window/desktop/PTY sessionを再生成する
- takeover locator/capabilityやreconnect generationを復活する
- interrupted actionを自動replayする
- consumer semantic verificationを省略する

## Audit boundary

Auditはdurable保存に適した **generic control-plane event stream** であり、execution transcriptではありません。

候補event family:

- intervention lifecycle transition
- authority claim/revoke/expiry outcome
- checkpoint written/cleared/recovery requested
- generic verification/resume-policy outcome
- bounded failure category

v0.3でname/shapeをfreezeする前に、#128で次を定義します。

- event schema/versioningとcompatibility rule
- field size/cardinality上限
- durable metadataとして許可するidentifier/digest
- sink failure/backpressure behavior
- sensitive execution contentを構造的に除外するprivacy test

consumer business event、authentication fact、payment approval record、target-service固有audit requirementはgeneric library contractの外です。

## Operator diagnostics boundary

Diagnosticsはtroubleshooting / acceptance向けで、durable reconstruction向けではありません。現行WebRTC diagnosticsは次の好ましい形をすでに示しています。

- finiteなstage/state category
- candidate/address文字列ではなくbounded candidate-type count
- bounded duration / latency distribution
- bounded event buffer
- target/session/principal/network/content payloadを持たない

#129ではBrowser / Window / Terminalで本当に共有できるlifecycle/authority/failure categoryだけをstable化し、target/transport固有detailは各namespaceに残します。1つの巨大generic diagnostics objectを作るためにfalse parityを作ってはいけません。

Diagnosticsのdefault retentionはprocess-memoryです。operatorがprojectionを永続化する場合も、stable operator contractで明示許可したfieldだけをexportします。

## Crash/restart conformance gate

#130をv0.3のrecovery modelに対するrelease gateとします。最低でも次のcrashをdeterministic testで扱います。

1. `awaiting_human`
2. `human_active`
3. `verifying`
4. `ready_to_resume` 後、consumer reissue前
5. Browser/Window locatorまたはcapabilityが存在する状態
6. reconnect generation / handleが存在する状態
7. Terminal Human authority中、またはPTY/process exit時
8. checkpoint write interruption / expiry / tamper / principal/adapter mismatch

全ケースでrestart後に古いmutation authorityを利用できないことが必要です。Browser / Window / Terminalは必要に応じてfreshなconsumer-owned target/session reconstructionを要求します。

## v0.3実装順

推奨順序:

1. **#127 checkpoint-store contract** — durable interfaceとfailure semanticsを先に固定
2. **#128 audit contract** と **#129 diagnostics contract** — 共通data-classification ruleを参照しつつ並行可能
3. **#130 crash/restart conformance** — 他contractがrelease-level invariantとしてtest可能になってからclose

## v0.3 exit criteria

次を満たせばv0.3 readyです。

- durable schemaを広げずprovider-neutral checkpoint-store interfaceを導入
- signed-file storeをreference implementationとして維持
- audit eventにversioned / bounded / privacy-reviewed contractがある
- operator diagnosticsにstable shared categoryがあり、target/transport固有detailはscope内に残る
- crash/restart conformanceでstale authority、capability、request state、media/input session、PTY authorityが復元されない
- recoveryは `reissue_and_revalidate` のままでconsumer semantic verificationが必須
- Browser / Window / Terminalの既存integrationがgreen

## v0.3の明示的non-goal

- Desktop Handoff (#125)
- provider-neutral TURN/connectivity productization (#19)
- hosted control plane / execution worker (#12)
- distributed database / queue選定
- active Human sessionのtransparent live migration
- browser/profile/PTY/media restoration
- automatic action replay
- credential vault
- mandatoryなOpenTelemetry/SIEM/vendor integration

これらは将来v0.3 contractを利用できますが、v0.3のauthority/persistence boundaryには含めません。
