# Architecture（日本語）

[English](architecture.md)

## Boundary

`mcp-execution-handoff` はcontrol-plane libraryであり、execution engineではありません。browser / desktop / terminal / device / provider固有のnative operationはconsumer adapter内に残します。

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

## Lifecycle

1. consumerがHuman intervention必須surfaceを検出する。
2. `ExecutionHandoffState.begin()` が単一active interventionを作成し、resource epochを進める。
3. interventionが `awaiting_human` の間に、originating invocationがownerをbindする。
4. Agent authorityを停止し、Humanだけがcontrolをclaimできる。
5. Human completionで `verifying` へ移り、epochを再度進める。
6. consumerがdomain-specific postcondition verificationを行う。
7. verification結果によりHumanへ戻す、fail/cancelする、または `ready_to_resume` にする。
8. resume policyに従い、original operationのsafe replay / fresh semantic reissue / never replayをconsumerが決める。

coreは「challengeが解けた」「login成功」「transaction承認」を推測しません。これらはadapter policyです。

## Durable recovery

checkpointはHMAC保護 + private permissionで、adapter kind / intervention id/status / epoch / resume policy / principal binding / optional action digest / timestamp / expiryだけを保存します。

raw argsやexecution contentは保存しません。recoveryは `reissue_and_revalidate` のみで、old Agent/Human authority、requestState、browser state、takeover capabilityを復元しません。

## MCP bridge

MRTR requestStateはexact tool name、canonical args digest、intervention id、resource epoch、resume strategy、authenticated logical-principal bindingへbindします。

authentication方式自体はlibraryの責務外です。consumerがstableかつnon-secretなprincipal bindingを作って明示的に渡します。

## Credential-safe external Human surface

external Human surfaceはcontrol-plane adapterです。normal browserを使う完全external providerにも、hosted execution planeでbounded Handoff browser brokerを使うproviderにも接続できます。この2つはbrowser trust boundaryが異なるため同一視しません。

`HostedBrowserTakeoverProvider` は既存 `TakeoverBroker` をgeneric `ExternalHumanSurfaceProvider` contractへ橋渡しする小さなproviderです。Handoff側へCDP / Chrome / Maps / target-provider固有概念を追加せず、frame/input実装はconsumer adapterに残します。このmodeはtarget serviceがhosted browser shapeを許容し、実sign-in acceptanceを通した場合だけ利用します。non-automated browserを要求するproviderのbypassには使いません。

consumerはまず通常handoff lifecycleへ入り、Humanへexclusive authorityを渡します。その後にだけ `CredentialSafeHumanSurfaceRuntime.begin()` でexternal operator sessionを作れます。sessionはactive intervention id / resource epoch / principal bindingへbindされ、同時activeは1つだけです。同じbindingでのduplicate beginだけidempotentです。

provider出力から保持するのはprovider kind / intervention id / epoch / principal binding / session id / operator locator / optional expiryのbounded fieldのみです。追加provider dataは保持しません。credential、browser cookie、token、screenshot、DOM/network data、provider固有opaque metadataをcontinuity materialとして使ってはいけません。Hosted broker経由のHuman入力payloadもdurable state / diagnostic / MCP/model output / logへ残しません。

automationを戻す前にconsumerはexternal sessionをrevokeし、そのmode固有のexecution boundaryを確認します。normal-browser providerならbrowser終了とprofile lock解放、hosted browser providerならHuman CDP authority detachとfresh Agent connectionが必要です。その後Human completionを既存の `verifying -> ready_to_resume` lifecycleへ進めます。authentication successはfresh browser stateから再検証し、pre-auth semantic actionをstale replayしません。

どのintervention reasonにこのsurfaceが必要かをpackageは決めません。`selectHumanSurface()` でconsumerごとのidentity-sensitive reason setを設定し、provider固有policyをgeneric coreへ持ち込みません。

## Browser takeover

optional brokerはtransport/sessionだけを担当します。public locatorにcapabilityは含めません。同一origin bootstrapでremote-client leaseを1つだけclaimし、short-lived capabilityを返します。frame/input/doneはcapability + principal binding + client binding一致が必須です。

新しいbindingは既存leaseを暗黙reclaimできません。native clientは明示的なclaim/reconnect APIを利用できます。reconnectにはsame authenticated principal、generation-bound reconnect handle、旧leaseがidleであることが必要です。成功時はclient generationをincrementし、capabilityとreconnect handleを両方rotateするため、旧client generationは即時fenceされます。expired/revoked session、activeな旧client、wrong principal、wrong handle、stale generationはfail closedします。reconnect handleにbrowser contentやtarget-service credential materialは含めません。

WebRTC browser transportではICEをdirect-firstのまま維持し、signaling/data-plane policy全体をHandoffが担当します。Safariはhost candidateのみ、Node/werift peerは明示Cloudflare STUNを使い、dependency内部のdefaultが別third-partyへ暗黙切替されないようにします。TURN設定時もfallback-onlyで、generation範囲内のshort-lived peer credentialを使います。network diagnosticはcandidate type/count・peer state・bounded timingだけを保持し、candidate文字列 / address / SDP / credentialは対象外です。

touch対応SafariではTouch Eventsをgestureのauthoritative streamとし、touch Pointer Eventsの二重送信を抑止します。macOS hostはlogin session内プロセスに適した `CGEventSource(stateID: .combinedSessionState)` を使います。tap/scrollはsession event tap、target-bound keyboard inputは対象PIDが解決できる場合にそのPIDへpostします。これによりconsumer APIを広げず、window-scoped capture/inputとbrowser gesture semanticsを一致させます。

brokerはtakeover可能surfaceを拡張できません。consumer browser adapterが自身のallowlistとcurrent epochで各操作を検証します。

## Consequential action

handoff completionに結合したgeneric approval APIは置きません。consequential actionを実行するconsumerは、exact final actionとcurrent stateへbindした別のexplicit approval mechanismを持つ必要があります。Human completionはmanual step終了の事実であり、後続actionのapprovalではありません。
