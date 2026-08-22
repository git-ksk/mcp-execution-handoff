# アーキテクチャ

[English](architecture.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

## 境界

`mcp-execution-handoff` は、実行そのものを行うengineではなく、実行権限の引き継ぎを管理するcontrol-plane libraryです。browser、desktop、terminal、device、provider固有の実処理は、それぞれのconsumer adapterに残します。

```text
MCP / Agent
   |
   v
MCP bridge ---------------- principal + invocation + args binding
   |
   v
Execution Handoff core ---- authority / epoch / resume policy / checkpoint
   |
   +---- consumer adapter: browser.maps
   |
   +---- consumer adapter: browser.cinema
   |
   +---- optional browser takeover transport
   |
   +---- credential-safe external Human provider coordinator
```

## 4軸のHandoff taxonomy

アーキテクチャでは、Handoffを4つの独立した軸で整理します。これらは組み合わせて使いますが、同じ意味の言葉ではなく、すべての組み合わせが必ずsupportされるわけでもありません。

### 1. Handoff Semantics

「誰が実行権限を持つか」「どのstateがまだ有効か」「どの条件なら再開できるか」を決める不変のcoreです。Agent/Human authorityの排他、resource epoch fencing、principal/invocation ownership binding、限定されたcheckpoint、resume/replay policy、stale reconnect拒否、`reissue_and_revalidate` によるrecoveryなどを含みます。

Handoff SemanticsはTarget SurfaceやTransportに依存しません。これはtakeover typeではありません。

### 2. Human Interaction Policy

「どのtrust/safety boundaryの中でHumanに操作させるか」を表す軸です。現在の実装値は次の2つです。

- `automation_adjacent` — automation-managedな実行surfaceに隣接したままHuman controlを行う
- `credential_safe_external` — automation-managedなcredential surfaceを使うべきでないintervention向けに、Human-onlyな外部boundaryへcontrolを移す

既存TypeScript APIではこれらを `HumanSurfaceKind` と呼びます。ただしdocsでは、実際に操作するsurface（browser / OS window）と混同しないよう、**Human Interaction Policy** を正式な説明用語として使います。このtaxonomyのためだけにpublic APIをrenameする必要はありません。

### 3. Target Surface

「Humanが何を操作するか」を表す軸です。現在実績のあるcategoryは次のとおりです。

- `browser` — browser execution/window/session surface
- `os_window` — scopeを限定したOS application/window surface

terminal/PTYや別のnative-application abstractionは、実consumerで必要性が証明されるまでnon-contractualな将来候補に留めます。architecture上の正式用語は **Target Surface** とし、「takeover type」は説明上の言い回しに留めます。

### 4. Transport

「Human control/media pathをどう届けるか」を表す軸です。現在および将来のfamilyにはNative、WebRTC、将来のWebSocket / HTTP streaming / WebTransportなどがあります。WebRTCの中ではdirect ICEを優先し、TURNは必要時だけ使うfallback connectivity infrastructureです。そのため `WebRTC direct` と `WebRTC + TURN` はTarget Surfaceの種類ではなく、transport/connectivity上の結果です。

```text
Execution Handoff
|
+-- Handoff Semantics
|    authority / epoch / ownership / replay / recovery
|
+-- Human Interaction Policy
|    automation_adjacent
|    credential_safe_external
|
+-- Target Surface
|    browser
|    os_window
|
+-- Transport
     Native
     WebRTC
       +-- direct
       +-- TURN fallback
     future: WebSocket / HTTP streaming / WebTransport
```

現在の実例には `browser + automation_adjacent + WebRTC`、`browser/os_window + credential_safe_external + WebRTC` があります。architecture上で組み合わせ可能でも、それだけでsupport済みとはみなしません。各consumer/provider/host pathでacceptance evidenceがある場合だけsupport済みと扱います。

## ライフサイクル

1. consumerが、Humanによる手動対応が必要なsurfaceを検出する。
2. `ExecutionHandoffState.begin()` が唯一のactive interventionを作成または返し、resource epochを進める。
3. interventionが `awaiting_human` の間に、元の呼び出しをownerとしてbindingする。
4. Agentの実行権限を停止し、Humanだけが排他的にcontrolを取得できる状態にする。
5. Humanが手動作業を完了すると `verifying` へ進み、epochをもう一度進める。
6. consumerが、そのdomainに固有の完了条件を検証する。
7. 検証結果に応じて、再びHumanへ戻す、fail/cancelする、または `ready_to_resume` にする。
8. resume policyを返し、元の処理を再実行してよいか、意味上の新しい操作としてやり直すべきか、再実行してはいけないかをconsumerが判断する。

core自身は「challengeが解けた」「loginに成功した」「transactionが承認された」とは判断しません。これらはconsumer adapter側のpolicyです。

## 永続checkpointと復旧

file checkpointはHMACで保護し、private permissionで保存します。永続化するのは次のような限定されたcontrol-plane metadataだけです。

- adapter kind
- intervention id / status
- epoch
- resume policy
- principal binding
- optional action digest
- timestamp
- expiry

raw argumentsや実行内容は保存しません。restart後の復旧は常に `reissue_and_revalidate` で行い、古いAgent/Human authority、`requestState`、browser state、takeover capabilityは復元しません。

## MCP bridge

MRTRの `requestState` は、次の情報へbindingします。

- exact tool name
- canonical argument digest
- intervention id
- resource epoch
- resume strategy
- authenticated logical-principal binding

利用者をどう認証するかはlibraryの責務ではありません。consumerがstableかつsecretではないprincipal bindingを作成し、明示的に渡します。

## credential-safe external Human surface

external Human surfaceはcontrol-plane adapterです。完全に外部のnormal browserを使うproviderにも、hosted execution plane上で限定されたHandoff browser brokerを使うproviderにも接続できます。この2つはbrowserのtrust boundaryが異なるため、同じものとして扱いません。

`HostedBrowserTakeoverProvider` は既存の `TakeoverBroker` と、汎用的な `ExternalHumanSurfaceProvider` contractを橋渡しする小さなproviderです。Handoff側にCDP、Chrome、Maps、target provider固有の概念は追加しません。frame/inputの実装もconsumer adapter側に残します。この方式を使えるのは、target serviceがhosted browserの形を許容し、実際のsign-in acceptanceを通している場合だけです。non-automated browserを要求するproviderの回避策として使ってはいけません。

consumerはまず通常のhandoff lifecycleへ入り、Humanへ排他的なauthorityを渡します。その後にだけ `CredentialSafeHumanSurfaceRuntime.begin()` でexternal operator sessionを開始できます。このsessionはactive intervention id、resource epoch、principal bindingへ紐づきます。同時にactiveにできるsessionは1つだけで、同じbindingによるduplicate beginのみidempotentです。

providerから受け取って保持する情報は、provider kind、intervention id、epoch、principal binding、session id、operator locator、optional expiryに限定します。余分なprovider dataは保持しません。credential、cookie、token、screenshot、DOM/network data、provider固有のopaque metadataをcontinuity dataとして使ってはいけません。

automationへ権限を戻す前に、consumerはexternal sessionをrevokeし、その方式に固有のexecution boundaryが閉じたことを確認します。normal-browser providerならbrowser終了と専用profile lockの解放、hosted browser providerならHuman側CDP authorityのdetachとfresh Agent connectionが必要です。その後、既存の `verifying -> ready_to_resume` lifecycleへ進めます。認証成功はfresh browser stateから再検証し、認証前の古いsemantic actionをそのまま再実行しません。

どのintervention reasonでこのsurfaceを使うかはpackage側では決めません。`selectHumanSurface()` を使ってconsumerごとにidentity-sensitiveなreasonを設定し、provider固有policyをgeneric coreへ持ち込みません。

## Browser takeover

optional brokerが担当するのはtransportとsession管理だけです。public locatorにはcapabilityを含めません。同一originのbootstrapでremote-client leaseを1つだけclaimし、short-lived capabilityを返します。frame/input/doneの各requestでは、capability、principal binding、client bindingがすべて一致する必要があります。

新しいbindingが、すでに所有されているleaseを暗黙に奪うことはできません。native clientは明示的なclaim/reconnect APIを使えます。reconnectには、同じauthenticated principal、generation-bound reconnect handle、そして以前のleaseがidleであることが必要です。成功するとclient generationを進め、capabilityとreconnect handleを両方rotateします。これにより古いgenerationは即座に無効になります。expired/revoked session、activeな旧client、wrong principal、wrong handle、stale generationはfail closedします。reconnect handleにbrowser contentやtarget-service credentialを含めません。

WebRTC browser transportではdirect-first ICEを維持し、signaling/data-plane policyをHandoff側に閉じ込めます。Safariはhost candidateのみを使い、Node/werift peerはCloudflare STUNを明示的に利用して、dependency内部のdefaultが別third-partyへ勝手に切り替わらないようにします。TURNを設定してもfallback専用で、client generationに紐づくshort-lived peer credentialを使います。network diagnosticにはcandidate type/count、peer state、限定されたtimingだけを残し、candidate文字列、address、SDP、credentialは保存しません。

touch対応SafariではTouch Eventsをgestureの基準とし、touch Pointer Eventsによる二重入力を抑止します。macOS hostでは `CGEventSource(stateID: .combinedSessionState)` を利用し、login中のuser session内で動くprocessに合わせます。tap/scrollはsession event tap、target-bound keyboard inputは対象PIDを解決できる場合にそのPIDへ送ります。consumer APIを広げずに、window単位のcapture/inputとbrowser gestureの意味を一致させるための設計です。

broker自身はtakeover可能なsurfaceを広げません。consumer browser adapterが自身のallowlistと現在のepochに基づいて各操作を検証します。

## 重大操作との分離

handoff完了と結び付いた汎用approval APIは提供しません。重大な操作を実行するconsumerは、最終的に実行する正確なactionと現在stateへ紐づいた、別の明示的なapproval mechanismを用意する必要があります。

Humanが手動作業を終えたことは「interventionが終わった」という事実でしかなく、その後の操作を承認したことにはなりません。
