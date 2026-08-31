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

local power-loss hardeningとして、signed-file providerは新しい `0600` temporary fileへ書き込み、そのfileを `fsync` してからatomic renameし、Node / filesystemがdirectory `fsync`をsupportするplatformではparent directoryもflushします。`clear()` もunlink成功後に同じparent directoryをflushし、directory entryの永続化前にdurable deletion成功とはclaimしません。通常のfile / directory barrier failureは同期的な `write()` failureとしてそのまま伝播するため、active Human intervention中なら `ExecutionHandoffRuntime` が既存のcheckpoint write failureと同様にauthorityをcancel / fenceしてからerrorが返ります。directory barrierが `EINVAL` / `ENOTSUP` / `EOPNOTSUPP` で明示的にunsupportedな場合はprovider自体を使用不能にはしませんが、renameのcrash-durability claimだけが弱くなります。Windowsでもfile `fsync`は必須ですが、portableなdirectory-handle `fsync`保証はclaimしません。最も強いlocal filesystem境界にはprivate `0700` checkpoint directoryを事前作成してください。今回のrecursive directory creationが全ancestor directory entryまでdurably flushするとはclaimせず、filesystem固有の `fsync` / rename semanticsを超える普遍的なsudden-power-loss保証もしません。

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

### Deterministic restart conformance matrix

#130ではfirst-class deterministic testでrestart境界を固定します。process restartは、in-memoryのauthority / transport objectをすべて破棄し、durable checkpoint storeだけを残してfresh adapter/runtimeを再構築する形でmodel化します。target/session objectはrestart境界を跨いでコピーしません。

| crash / loss point | surviving state | restart後 | 必須の次手 |
| --- | --- | --- | --- |
| `awaiting_human` | bounded checkpointのみ | intervention / Human leaseは再構築されない | consumer target/sessionを再構築し、cancelまたはfresh Human roundを開始 |
| `human_active` | bounded checkpointのみ | 旧Human authority / transportは消失 | target stateを再読込し、必要な場合だけfresh Human roundを開始 |
| `verifying` | bounded checkpointのみ | crash前verification authorityは復元されない | consumerがfresh semantic/postcondition verificationを実施 |
| reissue前の `ready_to_resume` | bounded checkpointのみ | Agent auto-resume / action replayなし | revalidate後、通常lifecycleから明示reissue |
| Browser / Window locator、capability、generation、reconnect handle | いずれもdurableではない | restart後の旧page/capability/reconnect requestは拒否 | revalidation後にfresh first-class adapter session / locatorを発行 |
| Terminal Human-active中のconsumer restart | PTY byte / queue / locator / transport authorityは残らない | fresh PTY/session generationは旧intervention/transportを持たず、旧queued Human inputも読めない | fresh consumer-owned PTY/sessionを再構築し、Agent利用前にstate同期 |
| Human-active中のTerminal PTY/process exit | replacement PTYは生成しない | authority=`none`、lifecycle=`verifying`、session dead | dead-session stateからverify/cancelし、そのPTYへAgent/Human inputを復活させない |
| tamper / expiry / principal mismatch / adapter mismatch | reject対象のbounded metadataのみ | fail closedまたはrecordなし | 原因確認またはfresh lifecycle開始。validationを緩めない |
| checkpoint write interruption | partially trusted recovery recordなし | write errorを返す前にactive interventionをcancel/fence | fresh consumer stateから再構築・再検証 |

conformance fixtureではsimulated restart直前にTerminal Human inputをqueueし、fresh adapterから取得できないことも証明します。generic recovery経由でHuman-period byteがAgentへreplayされることはありません。

### Restart後のoperator guidance

1. `recover()` は**hint**として扱い、resumeやtarget mutationのpermissionにはしない。active interventionは再生成されない。
2. consumerの通常ownership pathからtarget/sessionを再構築する。Browser / Windowはfresh locator/capability generationを発行し、Terminalはfresh consumer-owned PTY/session generationを使う。
3. targetの現在semantic/postcondition stateを再読込する。crash前の `Done` / `verifying` / `ready_to_resume` checkpointは意図したaction完了の証明ではない。
4. identity / ownership / target state / postconditionがunknown・changed・ambiguousならfail closedし、replayではなくcancelまたはfresh Human roundを選ぶ。
5. TerminalはHuman-period stateをdiscard/re-readし、通常のAgent-state synchronization boundaryをacknowledgeしてからAgent input/observation/resizeを再開する。旧processのqueued Human input/outputはreplayしない。
6. recovered workをconsumerが明示的に解決した後だけcheckpointをclearする。audit / diagnostics snapshotはobservability dataのままで、recovery authorityにはしない。

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

### Managed Browser / Window takeover diagnostics

managed direct WebRTC -> WebSocket relay -> optional WebRTC relay のtroubleshootingは、generic operator v1とは別のstable / strict schema `ManagedOperatorDiagnosticsSnapshot` で扱います。Browser / Windowはいずれも同じ `managedOperatorDiagnosticsSnapshot()` を公開します。これによりclosed-worldなgeneric operator v1へtransport固有fieldを無理に追加せず、consumerごとの独自diagnostics contractも不要にします。managed fallback無効時も同じschemaで `idle` / `none` のempty snapshotを返します。

managed snapshotに入るのはboundedなcontrol-plane factだけです。current / previous transport、generation / transition count、fallback reason、WSS channel state / failure / disconnect class、frames observed / sent / dropped、exact-window surface failure、input attempt / stage / boundary stage、helper stop / crash / exit classification、exact-window authority boundary（`valid` / `lost`）、WSS session disposition（`none` / `retained` / `revoked`）を扱います。event historyは最大64件で、transport transition、WSS open/degraded/failed、capture recovery、input dispatch failure、helper restart、authority loss、session retained/revokedのbounded enumだけを保持します。

`parseManagedOperatorDiagnosticsSnapshot()` はclosed-worldです。unknown field、free-form reason、上限超過counter、unknown enumはrejectします。credential、MFA/OTP/passkey、cookie/token/capability、Human input text、framebuffer/browser content、PID/window identity、principal/intervention/session identity、IP/ICE/SDP/TURN credential、account identity、timestamp、arbitrary messageを格納するfieldはありません。diagnostics eventはprocess-memory evidenceに限定し、authorityの復元・拡張には使いません。exact-window ownership / visibility / geometry / target lossは引き続きfail-closeで、failed Human inputをdiagnostics経由でreplayすることもありません。

physical acceptanceでは同じsnapshotを takeover開始前、managed fallback後、failure直後、completion後の4点で取得します。`Session unavailable` という症状だけからinput recoveryを推定せず、failure snapshotを修正判断の根拠にします。 productionへの自動exportが必要なconsumerは `onManagedOperatorDiagnosticEvent` を指定できます。callbackが受け取るのは同じbounded `{ kind }` eventだけで、callback exceptionはcontainされるobserve-only contractです。authorityのgrant / revoke / restore / widenには影響しません。consumerはこの通知をtriggerに `managedOperatorDiagnosticsSnapshot()` を読み、strict snapshotだけをoperator log / telemetryへexportできます。

### Privacy / boundedness / compatibility

`parseOperatorDiagnosticsSnapshot()` をstrict v1 validatorとします。extra field、false-parity field、上限超過count、session/intervention/principal id、PID/window identity、credential/token、SDP/candidate/IP、framebuffer/media、Human input、PTY/browser/page content、account identity、capability、timestamp、free-form message payloadを入れる経路は拒否します。

stable v1 parserは意図的にclosed-worldです。fieldのrename/remove、新しいroot/namespace fieldの追加、enum意味変更はv1を黙って広げず新schema versionを要求します。既存transport-local diagnosticsはそれぞれのtyped API内で進化できますが、cross-surfaceでstableなoperator contractは明示v1 projectionだけです。

operator summaryのdefault retentionはprocess-memoryです。永続化してもrecovery stateにはなりません。authority、locator/capability、client generation、media/input session、PTY authority、semantic verificationを再構築するためにreplayしてはいけません。operator systemがdiagnosticsを永続化する場合はstable parserを通過した値（または別途review済みallowed projection）だけを保存します。#128 auditは別のevent contractであり、execution transcriptでもgeneric diagnostics storeでもありません。
