# プロジェクトの位置づけと差別化

[English](positioning.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

最終確認: 2026-08-26

`mcp-execution-handoff` は、汎用的なHuman-in-the-loop framework、approval product、workflow engine、browser automation systemを目指すプロジェクトではありません。

MCPで動く処理の途中で、Agentだけでは進められない、またはAgentに進めさせるべきではない場面に到達したとき、実行権限を一時的にHumanへ移し、その後どの条件なら安全に再開できるかを扱う、小さなsecurity-oriented control-plane runtimeです。

差別化の中心は「Humanのためにpauseできること」ではありません。それ自体は既存のframeworkやMCP標準にもあります。このプロジェクトでは、handoffに特有のsecurity / replay semanticsを、狭く明示的なcontractとして持つことを重視します。

## このプロジェクトが責任を持つ範囲

再利用可能な境界として、次を扱います。

- AgentとHumanの実行権限を同時に成立させない
- interventionを跨いで古いstateを無効化するresource epoch fencing
- principal、正確なinvocation、canonical argumentsへのownership binding
- 保存内容を限定したsigned control-plane checkpoint
- Human completionとは独立した明示的なresume policy
- optionalなshort-lived browser takeover capabilityと単一client lease
- stale authorityを復元せず、`reissue_and_revalidate` で復旧すること
- 「Humanが手動作業を終えた」と「Humanが重大操作を承認した」を厳格に分離すること

これらはこのプロジェクトのcompatibility contractです。他のframeworkでも同様のpolicyを構成できる可能性はあります。この文書は責任範囲を説明するもので、独占的な発明や優越性を主張するものではありません。

## Taxonomy: coreと周辺軸の分離

本プロジェクトでは、次の4軸を分けて扱います。

1. **Handoff Semantics** — authority、epoch、ownership、replay/resume、recovery。security-orientedな不変のcoreであり、差別化の中心です。
2. **Human Interaction Policy** — Humanがどのtrust boundaryで操作するか。現在の実装値は `automation_adjacent` と `credential_safe_external` です。既存TypeScript APIでは `HumanSurfaceKind` と呼びます。
3. **Target Surface** — Humanが何を操作するか。現在の実証済みshapeはbrowser、bounded OS/window、bounded Terminal/PTYです。このevidenceだけでpublic enumをfreezeしません。
4. **Transport** — Human control/media pathをどう届けるか。NativeやWebRTCなどが該当し、direct ICEかTURN fallbackかはWebRTC connectivityの違いです。

この4つは同じレベルの「takeover type」ではありません。特にbrowser takeoverはcoreそのものではなく、core semanticsの周囲にあるoptionalなHuman-control surface/transport capabilityです。architectureでは **Target Surface** を正式用語とし、policy軸は実際の操作対象と混同しないよう **Human Interaction Policy** と呼びます。

canonicalな4軸モデルとsupport条件は [アーキテクチャ](architecture.ja.md#4軸のhandoff-taxonomy) を参照してください。

## MCP標準との関係

現在のMCPには、user interactionやlong-running work向けの標準mechanismがすでにあります。

- Multi Round-Trip Requests (MRTR) は `input_required` を返し、`inputResponses` を付けて元のrequestをretryできる
- Elicitationはform modeとURL modeを持ち、URL modeでは機微なinteraction dataをMCP clientの外側に置ける
- MCP Tasksはdurable workが `input_required` stateへ入ることを表現できる

このプロジェクトは、それらを置き換えるのではなく**組み合わせて使う**方針です。

追加する価値はprotocol自体ではありません。protocolの周囲にあるapplication stateへ、authority ownership、epoch、invocation binding、checkpoint restriction、takeover capability/lease、replay policyというlibrary-levelのsecurity contractを与えます。

将来MCP標準がこれらの仕組みを十分に定義するようになった場合は、独自実装を残すより標準へ寄せ、重複部分を削除することを優先します。

Primary references:

- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://modelcontextprotocol.io/specification/draft/client/elicitation
- https://modelcontextprotocol.io/extensions/tasks/overview

## Workflow / HITL frameworkとの関係

### LangGraph / LangChain HITL

LangGraphのinterruptはgraph stateを保存し、処理をpauseして外部入力からresumeできます。LangChainのHITL middlewareはtool callにapprove/edit/rejectなどのHuman reviewを追加できます。

`mcp-execution-handoff` はgraph persistence、agent orchestration、汎用approval middlewareを置き換えません。より狭く、**実行権限を一時的にHumanへ移す境界**と、古いstateやHuman completionが暗黙のreplay/approvalへ変換されないための規則を担当します。

References:

- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://docs.langchain.com/oss/python/langchain/human-in-the-loop

### Microsoft Agent Framework

Microsoft Agent Frameworkは、function/tool executionの前にHuman approvalを挟むworkflowを提供します。

このプロジェクトではapprovalとhandoffを意図的に分離します。Humanがlogin、consent、access challengeなどを手動で完了しても、Agentが次に行う重大操作を承認したことにはなりません。そのため、このプロジェクトでは `Done` は `Approve` を意味しません。

Reference:

- https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/human-in-the-loop

### HumanLayer / Agent Control Plane

Agent Control Planeはdurable agent execution、scheduling/control-loop infrastructure、MCP toolへのHuman approval/inputなどを提供します。

`mcp-execution-handoff` はそれより意図的に小さく保ちます。scheduler、distributed agent runtime、communication service、Kubernetes control planeではなく、library-levelで再利用するhandoff primitiveです。

Reference:

- https://github.com/humanlayer/agentcontrolplane

## 責任境界による比較

以下はfeature数やsecurity superiorityの比較ではなく、「どのresourceと責任を誰が所有するか」の違いを整理するものです。

### Remote desktop system

RustDeskやApache Guacamoleのようなsystemは、device / session / desktop自体をHuman-controlled resourceとして扱うのが中心です。`mcp-execution-handoff` は既存MCP execution context内の1つのbounded interventionとしてHuman controlを扱い、authorityをintervention + resource epoch + principal + exact invocationへbindingします。default Window contractがunrelated desktopへ黙ってscopeを広げることもありません。したがってremote desktopとHandoffは異なるlayerを解いています。

### Browser takeover / cloud browser system

browser platformはbrowser runtime、session persistence、automation stack、Human live-view/takeover planeを1つのproductとして所有する場合があります。Handoffではbrowser/profile lifecycleとtarget-service authentication semanticsはconsumer責務のままです。optional Browser Handoff componentはbounded Human controlとsession fencingを提供しますが、fresh semantic verificationはtransport外に残します。

### Integrated agent sandbox / execution platform

より大きなexecution platformはsandbox / VM / browser / desktop、agent runtime、Human interaction surface、routingをまとめて所有できます。Handoffは意図的に小さく保ち、既存MCP consumer/runtimeへ組み込み、consumerのprocess/profile/authorization ownershipを維持します。execution platformそのものにはなりません。

### HITL / approval system

approval/interrupt frameworkは処理をpauseしてHuman decision/inputを求められます。Handoffが担当するのはtemporary **execution-authority transfer** とfreshness / ownership / replay fencingです。Human `Done` はmanual interventionの終了だけを意味し、後続のconsequential actionをapproveせず、stale semantic actionをreplay可能にも変えません。

## Browser takeover systemとの関係

### Tencent BrowserSkill

BrowserSkillはshell-capable Agentを実際にlogin済みのbrowserへ接続し、CAPTCHA、login、confirmation dialogなどでHuman takeoverを行えます。

これはbrowser automation productにHuman-in-loop機能を組み込む構成です。`mcp-execution-handoff` は逆に、browser automationをcoreから切り離します。

- coreはbrowser automationを提供しない
- `browser-takeover` はoptional transportに限定する
- takeover可能なsurfaceの判定とdomain固有の完了確認はconsumer adapterが行う
- generic brokerは限定されたsession / capability / lease管理だけを担当する
- takeover locatorにはcapabilityを含めない
- capabilityをintervention / epoch / principal / client / expiryへscopeする
- leaseを所有できるのは1つのremote client generationだけで、reload/new tab/new deviceから暗黙に奪い直せない
- 明示的に再認証されたidle-session reconnectだけが、新しいfenced generationへrotateできる
- Human completionは後続actionをauthorizeしない

Reference:

- https://github.com/Tencent/BrowserSkill

## 要約

短く表すと、次のようなプロジェクトです。

> MCP workflow向けのsecurity-oriented execution-handoff control plane。実行権限をHumanへ一時移譲し、古いstateをfenceし、handoffを正確なcaller/invocationへbindingし、明示的なreplay policyの下でだけ処理を再開する。

競争軸はagent orchestrationやbrowser automationの機能量ではなく、**小さく、監査しやすく、標準と整合するsecurity semantics** に置きます。

## 差別化を失う方向

次のような方向には広げません。

- 強いexecution semanticsを持たない汎用 `ask_human()` / approval UI wrapper
- LangGraphなどと競合するworkflow engine
- browser-agent productと競合するbrowser automation engine
- MCP MRTR / Elicitation / Tasksと重複するcustom protocol
- provider固有のchallenge/login semanticsをgeneric coreへ入れること
- epoch / ownership / capability / replay保証を暗黙に弱めるconvenience API

価値が単に「pauseしてHumanに聞ける」だけになった場合、このプロジェクトは独立した境界を失ったと判断します。

## 再確認するタイミング

次のときは本positioningを再監査します。

- MCP specでMRTR / Elicitation / Tasks / request state / security guidanceが変更されたとき
- roadmap milestoneで新しいgeneric public APIを提案するとき
- browser takeover semanticsを大きく変更するとき
- 新しいreal adapterのためにgeneric contract変更が必要になったとき
