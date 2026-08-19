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

external Human surfaceはcontrol-plane adapterであり、remote desktop実装ではありません。normal browserでのcredential entryを要求するproviderやautomation-adjacent execution environmentを拒否するprovider向けの境界です。

consumerはまず通常handoff lifecycleへ入り、Humanへexclusive authorityを渡します。その後にだけ `CredentialSafeHumanSurfaceRuntime.begin()` でexternal operator sessionを作れます。sessionはactive intervention id / resource epoch / principal bindingへbindされ、同時activeは1つだけです。同じbindingでのduplicate beginだけidempotentです。

provider出力から保持するのはprovider kind / intervention id / epoch / principal binding / session id / operator locator / optional expiryのbounded fieldのみです。追加provider dataは保持しません。credential、browser cookie、token、screenshot、DOM/network data、provider固有opaque metadataをcontinuity materialとして使ってはいけません。

automationを戻す前にconsumerはexternal Human surfaceをrevokeし、consumer固有execution boundaryを確認します。local profile-switch ownerならnormal browser終了とdedicated profile lock解放を確認します。hosted shared-session ownerならexact browser sessionをHuman authority中も維持し、automation clientだけdetachし、Live View handoffをrevokeしてからsame browser sessionへfresh automation attachmentを作ります。browser ownership / provider lifecycleはgeneric coreではなくconsumer責任です。

その後Human completionを既存の `verifying -> ready_to_resume` lifecycleへ進めます。authentication successはfresh browser stateから再検証し、pre-auth semantic actionをstale replayしません。credential/MFA/passkey/cookie/browser-session bearer material/provider API keyはMCP/model/log外に置き、northboundへ出すlocator自体をsecret bearer capabilityにしてはいけません。Passkey/WebAuthnはHuman/provider controlのままでbypassしません。

どのintervention reasonにこのsurfaceが必要かをpackageは決めません。`selectHumanSurface()` でconsumerごとのidentity-sensitive reason setを設定し、provider固有policyをgeneric coreへ持ち込みません。

## Browser takeover

optional brokerはtransport/sessionだけを担当します。public locatorにcapabilityは含めません。同一origin bootstrapでremote-client leaseを1つだけclaimし、short-lived capabilityを返します。frame/input/doneはcapability + principal binding + client binding一致が必須です。

低遅延adapterでは、認証済みHTTP streaming response上のbounded frame streamを任意で使えます。変わるのはframe deliveryだけで、input、principal binding、epoch fencing、client generation、expiry、revocationの意味論は維持します。capture/backpressure policyはbrowser adapterの責務で、CDP / WebRTC / provider lifecycleはgeneric brokerの外です。

新しいbindingは既存leaseを暗黙reclaimできません。native clientは明示的なclaim/reconnect APIを利用できます。reconnectにはsame authenticated principal、generation-bound reconnect handle、旧leaseがidleであることが必要です。成功時はclient generationをincrementし、capabilityとreconnect handleを両方rotateするため、旧client generationは即時fenceされます。expired/revoked session、activeな旧client、wrong principal、wrong handle、stale generationはfail closedします。reconnect handleにbrowser contentやtarget-service credential materialは含めません。

brokerはtakeover可能surfaceを拡張できません。consumer browser adapterが自身のallowlistとcurrent epochで各操作を検証します。

## Consequential action

handoff completionに結合したgeneric approval APIは置きません。consequential actionを実行するconsumerは、exact final actionとcurrent stateへbindした別のexplicit approval mechanismを持つ必要があります。Human completionはmanual step終了の事実であり、後続actionのapprovalではありません。
