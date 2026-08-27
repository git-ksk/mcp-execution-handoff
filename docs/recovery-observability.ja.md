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

`HandoffCheckpointStore` をprovider-neutralなpersistence boundaryとします。contractは意図的に同期型の `write(checkpoint)` / `read()` / `clear()` の3つだけです。`read()` は `unknown` を返します。backendはpersistence mechanismであって、schema validatorやrecovery authority providerではありません。`ExecutionHandoffRuntime` が返却値を毎回strictに再parseし、extra fieldを拒否し、runtime自身のclockでexpiryを検証したうえでadapter / principal bindingを確認し、最終的にも `reissue_and_revalidate` だけを返します。

`SignedFileHandoffCheckpointStore` はこのinterfaceを実装するlocal reference implementationとして維持します。既存の `load()` / `recover()` / operator-revalidation helperもsource compatibilityのため残しますが、runtime本体はprovider-neutral interfaceだけに依存します。

### Storage failure semantics

checkpoint-store contractを同期型にするのは意図的です。methodが正常returnした時点でprovider自身のdurability contract上そのstorage operationが完了しており、throwした場合は未完了として扱います。v0.3ではasync / best-effort writeをdurable fencingとして暗黙に扱いません。

- active intervention中の `write()` failureは呼び出し元へ伝播し、同時にruntimeがそのHuman interventionをcancel / fenceして既存のfail-closed behaviorを維持する
- `read()` failure、malformed record、expired recordはfail closedで伝播し、authorityは一切復元しない
- `clear()` failureも成功扱いせず伝播する。explicit clear自体はauthority transitionではないため、adapterの現在authorityは変更せず、callerがdurable-state cleanup failureを処理する
- 将来async storeを許可する場合は、awaited write/clear completion、crash point、cancellation、sink failure semanticsを別contractとして先に定義する必要がある

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

Auditはdurable-friendlyな **generic control-plane event stream** であり、execution transcriptではありません。v0.3では既存event名 `checkpoint_written` / `checkpoint_cleared` / `recovery_requested` を維持したままschema **version 1** をstable化します。runtimeがemitするeventはすべて `version: 1` を持ちます。event-name stringはpre-v0.3 baselineと互換ですが、audit recordを直接constructしていたconsumerはversioned shapeへ移行する必要があります。

v1 unionは意図的に狭くします。

- common fieldはschema version、enumerated event type、bounded adapter kind、non-negative integer timestampだけ
- checkpoint/recovery eventは既存checkpoint contractにあるbounded intervention id、epoch、stable non-secret principal binding、optional action digestだけを必要に応じて追加可能
- free-form message / reason / payload、target identity、transport identity、consumer-domain objectは持たない
- strict parserはextra fieldやoversized/newline-bearing identifierを黙ってserializeせず拒否する

`ExecutionAuditSink.record()` は同期型のままです。Auditは **observe-only** であり、sink成功はsemantic verification / approval / authority stateの証明ではありません。sink failureもauthorityのgrant / revoke / restoreやcheckpoint/recovery本体の成否を変更してはいけません。`ExecutionHandoffRuntime` は全v1 event classでsink exceptionをcontainし、optionalな `onAuditSinkFailure` へも `{ version, eventType }` だけを通知できます。このfailure callback自体のerrorもcontainします。core内部にはunbounded retry/backpressure queueを作りません。production sinkがasync exportする場合は、自身のbounded queue / durability contractの背後で実装し、`record()` はboundedにreturnまたはthrowする必要があります。

`MemoryExecutionAuditSink` はsimple test/reference sinkとして維持し、strict validation済みeventの最新256件だけを保持します。`NOOP_EXECUTION_AUDIT` も維持します。

Human completionは重大操作のapproval eventとしては記録しません。consumer business event、authentication fact、payment approval record、target-service audit requirementはgeneric library contractの外です。Browser / Window / Terminalはいずれもmedia、input、PTY byte、process/window identity、target-service contentをaudit sinkへ露出せず同じv1 contractを利用できます。

### Auditへ入れてはいけないcontent

v1 parserはextra fieldをstrictに拒否し、raw action argument、Human input、PTY/browser/page content、framebuffer/media、credential/cookie/token、OTP/MFA/challenge answer、payment data、approval receipt、takeover capability/requestState/reconnect state、SDP/candidate/IP address、free-form execution messageの保存経路にしません。

## Operator diagnostics boundary

Diagnosticsはtroubleshooting / acceptance向けで、durable reconstruction向けではありません。v0.3ではfirst-class Browser / Window / Terminal adapterの `operatorDiagnosticsSnapshot()` と `OperatorDiagnosticsSnapshot` により、**version 1 operator summary** をstable化します。

stable v1 envelopeは意図的にidentifier-freeです。

- `version: 1`
- diagnostic sourceは `browser_handoff` / `window_handoff` / `terminal_handoff` のみ。これはdiagnostics producerを示す値であり、**public Target Surface semantic enumをfreezeするものではない**
- generic healthは `idle` / `starting` / `available` / `degraded` / `failed` のみ
- optional failure categoryは `target` / `transport` / `input` / `recovery` のbounded categoryだけ
- generic execution stateを実際に所有するTerminalだけ、execution authorityとintervention phaseを持てる
- target / transport固有detailはfalse parityへflattenせず明示namespaceへ残す

### Namespaced projection

Browser / Windowの `webrtc` transport projectionに含めるのは次だけです。

- validation済みevent count（最大128）
- 存在する場合の最新bounded peer state
- aggregate ICE candidate **type count** のみ（各最大64）

詳細WebRTC stage string、duration series、media profile、latency sample、provider名、candidate/address、target identityはstable operator summaryへコピーしません。既存 `diagnosticsSnapshot()` / `latencySnapshot()` APIはtransport固有troubleshooting / physical acceptance用として変更せず維持します。#129は既存詳細APIを置換せず、その上にstable projectionを追加します。

Terminalは2つのtarget-specific namespaceを使います。

- `terminal_session`: session alive / Human disconnected / Agent-state synchronization-required のboolean
- `terminal_webrtc`: ready / disconnected / completed / faulted のbooleanと、既存transport上限64件にboundedされたqueued-event count

Terminalの `sessionId`、session generation、intervention epoch/id、principal binding、PTY byte、client generationはexportしません。Browser / Window operator summaryにはexecution authority / lifecycle fieldを捏造しません。これらfacadeはgeneric execution state machineを所有していないためです。

### Privacy / boundedness / compatibility

`parseOperatorDiagnosticsSnapshot()` をstrict v1 validatorとします。extra field、false-parity field、上限超過count、session/intervention/principal id、PID/window identity、credential/token、SDP/candidate/IP、framebuffer/media、Human input、PTY/browser/page content、account identity、capability、timestamp、free-form message payloadを入れる経路は拒否します。

stable v1 parserは意図的にclosed-worldです。fieldのrename/remove、新しいroot/namespace fieldの追加、enum意味変更はv1を黙って広げず新schema versionを要求します。既存transport-local diagnosticsはそれぞれのtyped API内で進化できますが、cross-surfaceでstableなoperator contractは明示v1 projectionだけです。

operator summaryのdefault retentionはprocess-memoryです。永続化してもrecovery stateにはなりません。authority、locator/capability、client generation、media/input session、PTY authority、semantic verificationを再構築するためにreplayしてはいけません。operator systemがdiagnosticsを永続化する場合はstable parserを通過した値（または別途review済みallowed projection）だけを保存します。#128 auditは別のevent contractであり、execution transcriptでもgeneric diagnostics storeでもありません。
