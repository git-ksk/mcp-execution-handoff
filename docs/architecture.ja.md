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

## Browser takeover

optional brokerはtransport/sessionだけを担当します。public locatorにcapabilityは含めません。同一origin bootstrapでmemory-only remote-client leaseを1つだけclaimし、short-lived capabilityを返します。frame/input/doneはcapability + principal binding + client binding一致が必須です。

reloadでは新しいin-memory client bindingになるため、既存leaseをreclaimできません。fresh Human round/sessionが必要です。

brokerはtakeover可能surfaceを拡張できません。consumer browser adapterが自身のallowlistとcurrent epochで各操作を検証します。

## Consequential action

handoff completionに結合したgeneric approval APIは置きません。consequential actionを実行するconsumerは、exact final actionとcurrent stateへbindした別のexplicit approval mechanismを持つ必要があります。Human completionはmanual step終了の事実であり、後続actionのapprovalではありません。
