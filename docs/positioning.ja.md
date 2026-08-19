# Positioning / 差別化（日本語）

[English](positioning.md)

最終確認: 2026-08-15。

`mcp-execution-handoff` はgenericなHITL framework、approval product、workflow engine、browser automation systemを目指しません。MCP-driven operationの途中でexecution authorityをAgentからHumanへ一時移譲し、その後どの条件で安全にresumeできるかを扱う、小さなsecurity-oriented control-plane runtimeです。

差別化は「Humanのためにpauseできる」こと自体ではありません。それは既存framework/標準にもあります。本projectはhandoff固有のsecurity / replay semanticsを小さく明示的なcontractとして持つ点を軸にします。

## このprojectが責任を持つ問題

- Agent/Human execution authorityの排他
- intervention roundを跨ぐresource epoch fencing
- principal + exact invocation + canonical argsへのownership binding
- bounded signed control-plane checkpoint
- Human completionと独立したexplicit resume policy
- optionalなshort-lived browser takeover capability + one-client lease
- stale execution authority復元ではなくreissue-and-revalidateによるrecovery
- 「Humanがmanual stepを終えた」と「consequential actionを承認した」の厳格な分離

これらをprojectのcompatibility contractとして扱います。他frameworkでも同様のpolicyを構成できる可能性はあります。この文書はscopeの差を説明するもので、独占的な発明や優越性を主張するものではありません。

## MCP標準との関係

現在のMCPにはすでにuser interaction / long-running work向けの標準mechanismがあります。

- MRTRは `input_required` を返し、`inputResponses` を付けてoriginal requestをretryできる
- elicitationはform / URL modeを持ち、URL modeではsensitive interaction dataをMCP client外に保てる
- MCP Tasksはdurable workを `input_required` stateとして表現できる

本projectはこれらを置き換えず、**上にcomposeする**方針です。

追加価値はprotocolそのものではなく、その周囲のapplication stateに対するlibrary-level security contractです。authority ownership、epoch、invocation binding、checkpoint restriction、takeover capability/lease、replay policyを明示します。

将来MCP標準がこれらの一部を十分に定義した場合、独自plumbingを維持するより標準へ寄せて削減することを優先します。

Primary references:

- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://modelcontextprotocol.io/specification/draft/client/elicitation
- https://modelcontextprotocol.io/extensions/tasks/overview

## Workflow / HITL frameworkとの関係

### LangGraph / LangChain HITL

LangGraph interruptはgraph stateをpersistしてexecutionをpause/resumeできます。LangChain HITL middlewareはtool callにapprove/edit/reject等のHuman reviewを追加できます。

本projectはgraph persistence、agent orchestration、generic approval middlewareを置き換えません。より狭く、**temporary execution-authority transfer** のsecurity boundaryと、stale stateやHuman completionをimplicit replay/approvalへ変換しない規則を担当します。

References:

- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://docs.langchain.com/oss/python/langchain/human-in-the-loop

### Microsoft Agent Framework

Microsoft Agent Frameworkはfunction/tool execution前のHuman approval workflowを提供します。

本projectではapprovalとhandoffを意図的に分離します。Humanがlogin / consent / access challenge等をmanualに完了しても、次のconsequential actionを承認したことにはなりません。したがって `Done` は `Approve` ではありません。

Reference:

- https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/human-in-the-loop

### HumanLayer / Agent Control Plane

Agent Control Planeはdurable agent execution、scheduling/control-loop infrastructure、MCP toolへのHuman approval/inputを提供します。

本projectはもっと小さく、scheduler / distributed agent runtime / communication service / Kubernetes control planeではなく、library-levelで再利用するhandoff control-plane primitiveです。

Reference:

- https://github.com/humanlayer/agentcontrolplane

## Browser takeover systemとの関係

### Tencent BrowserSkill

BrowserSkillはshell-capable Agentをreal logged-in browserへ接続し、CAPTCHA / login / confirmation dialog等でHuman takeoverできます。

これはbrowser automation productにHuman-in-loop capabilityを含む構成です。本projectはlayeringを逆にして、以下を守ります。

- coreはbrowser automationを提供しない
- `browser-takeover` はoptional transportのみ
- eligible surface判定 / domain-specific postcondition verificationはconsumer adapter責務
- generic brokerはbounded session/capability/lease mechanicsだけを担当
- takeover locatorにcapabilityを含めない
- capabilityをintervention / epoch / principal / client / expiryへscope
- lease ownerはremote client generation 1つだけで、reload/new tab/new deviceからimplicit reclaimできない。明示的に再認証されたidle-session reconnectだけが新しいfenced generationへrotateできる
- Human completionは後続actionをauthorizeしない

Reference:

- https://github.com/Tencent/BrowserSkill

## Positioning summary

短く表現すると:

> MCP workflow向けsecurity-oriented execution-handoff control plane。authorityをHumanへ一時移譲し、stale stateをfenceし、exact caller/invocationへhandoffをbindし、explicit replay policyの下でのみresumeする。

競争軸はagent orchestration/browser automationの機能量ではなく、**small / auditable / standards-alignedなsecurity semantics** に置きます。

## 差別化を失う方向

以下には寄せません。

- stronger execution semanticsを持たないgeneric `ask_human()` / approval UI wrapper
- LangGraph等と競合するworkflow engine
- browser-agent productと競合するbrowser automation engine
- MCP MRTR / elicitation / Tasksを重複実装するcustom protocol
- provider-specific challenge/login semanticsをgeneric coreへ入れること
- epoch / ownership / capability / replay guaranteeを暗黙に弱めるconvenience API

価値が単に「pauseしてHumanに聞く」だけになった場合、独立projectとしてのboundaryは失われたと判断します。

## Review policy

以下のタイミングで本positioningを再監査します。

- MCP specでMRTR / elicitation / Tasks / request state / security guidanceが変更された時
- roadmap milestoneで新しいgeneric public APIを提案する時
- browser takeover semanticsを大きく変更する時
- 新real adapterのためgeneric contract変更が必要になった時
