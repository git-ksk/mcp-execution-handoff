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
   +---- BrowserHandoffAdapter ---- exact browser/window + WebRTC
   |
   +---- WindowHandoffAdapter ----- exact bounded OS window + WebRTC
   |
   +---- TerminalHandoffAdapter --- bounded consumer-owned PTY + DataChannel WebRTC
   |
   +---- credential-safe external Human provider coordinator
```

consumer integration は **optional ですが、有効化した場合は authoritative** です。CUMG のような consumer は Handoff なしでも通常動作でき、Handoff は必須の execution dependency ではありません。一方、consumer が bounded operation や Target Surface に Handoff を attach した後は、Handoff authority を execution boundary の一部として扱います。Agent/Human authority は常に排他的で、stale/unknown な Handoff state は fail closed とし、runtime/transport unavailable を理由に Handoff を迂回して Agent control を暗黙復帰させてはいけません。domain authorization、operation ledger、quarantine、postcondition verification は consumer が所有し、Handoff は canonical な authority/epoch/ownership/replay/recovery semantics のみを所有します。同じ Handoff state machine を consumer 内へ複製しません。

## 4軸のHandoff taxonomy

アーキテクチャでは、Handoffを4つの独立した軸で整理します。これらは組み合わせて使いますが、同じ意味の言葉ではなく、すべての組み合わせが必ずsupportされるわけでもありません。

### 1. Handoff Semantics

「誰が実行権限を持つか」「どのstateがまだ有効か」「どの条件なら再開できるか」を決める不変のcoreです。すべてのmechanismを同列に並べず、次の4 semantic domainで整理します。

- **Authority state-machine semantics** — `agent` / `human` / `none` の排他的authorityと、`awaiting_human -> human_active -> verifying -> ready_to_resume`、cancel、return-to-Human、explicit resumeの明示transition。
- **Freshness and ownership fencing semantics** — monotonic resource epoch、stale-state拒否、principal binding、exact invocation / canonical argument ownership、initial ownership window後のowner再binding禁止。
- **Completion and continuation semantics** — Human `Done` はmanual step終了だけを意味し、fresh consumer verificationとより厳しいreplay/call-site policyがcontinuation可否を決める。`Done` はsemantic successでもconsequential-action approvalでもない。
- **Recovery semantics** — durable stateはbounded control-plane metadataだけを保持し、checkpoint integrity/expiryを検証し、restart recoveryは常に `reissue_and_revalidate`。stale Agent/Human authorityやbrowser/request stateは復元しない。

Handoff SemanticsはTarget SurfaceやTransportに依存しません。これはtakeover typeではありません。

**Takeover Session Semanticsは別のoptional layerです。** short-lived capability、one-client lease、client generation、reconnect handle、release/revoke/expiry、stale capability拒否はsecurity-criticalですが、invariant authority state machineではなくremote Human-control sessionに属します。intervention + epoch + principalへのbindingを維持しつつ、Native / WebRTC / WebSocket / future transportで共有できても、「security mechanismだから」という理由だけでcore Handoff stateへ昇格させません。

### 2. Human Interaction Policy

「どのtrust/safety boundaryの中でHumanに操作させるか」を表す軸です。現在の実装値は次の2つです。

- `automation_adjacent` — automation-managedな実行surfaceに隣接したままHuman controlを行う
- `credential_safe_external` — automation-managedなcredential surfaceを使うべきでないintervention向けに、Human-onlyな外部boundaryへcontrolを移す

canonical TypeScript APIとして `HumanInteractionPolicyKind`、`HUMAN_INTERACTION_POLICY_KINDS`、`selectHumanInteractionPolicy()` を公開します。既存の `HumanSurfaceKind`、`HUMAN_SURFACE_KINDS`、`selectHumanSurface()` はcompatibility aliasとして維持し、v0.2.0でconsumerを壊しません。

### v0.2 terminology inventory / compatibility decision

v0.2.0のpublic vocabularyはadditiveに収束させます。docsの用語へ合わせるためだけに既存consumerへimport renameを要求しません。

| 既存term / symbol | canonical axis | v0.2.0での判断 |
| --- | --- | --- |
| `HumanInteractionPolicyKind`, `HUMAN_INTERACTION_POLICY_KINDS`, `selectHumanInteractionPolicy()` | Human Interaction Policy | `automation_adjacent` / `credential_safe_external` を表すcanonical public name。 |
| `HumanSurfaceKind`, `HUMAN_SURFACE_KINDS`, `selectHumanSurface()` | Human Interaction Policy | compatibility aliasとして維持。source/runtime compatibilityを保ち、削除はconsumer migration後の明示的なbreaking releaseだけで検討する。 |
| credential-safe external Human surface/provider/runtime | Human Interaction Policy + concrete Human-control boundary | 実際のexternal operator boundaryを指す場合はこの表現を維持する。Target Surface kindではなく、target-service identityをattestもしない。 |
| `BrowserHandoffAdapter` / Browser | Target Surface | consumer-level Browser surfaceのcanonical表現。 |
| `WindowHandoffAdapter` / bounded OS Window | Target Surface | canonicalな `os_window` architecture label。exact PID/window ownershipはfail closedのままで、desktop-wide fallbackはない。 |
| `TerminalHandoffAdapter` / bounded Terminal/PTY | Target Surface | canonicalな `terminal_pty` architecture label。PTY/process ownershipはconsumer側に維持する。 |
| `browser`, `os_window`, `terminal_pty` | Target Surface | 実証済みのdocumentation labelのみ。共通runtime compatibility/diagnostic discriminatorの実需要がまだないため、v0.2.0では `TargetSurfaceKind` をexportしない。 |
| Native, WebRTC, WebSocket; direct ICE / TURN fallback | Transport | Transport family / connectivity behaviorだけを表す。Target Surfaceを決めず、Handoff authorityも変更しない。 |
| `browser-takeover`, `window-takeover`, `terminal-takeover` package subpath; `TakeoverBroker` | compatibility/API naming | consumer breakageを避けるため維持する。これらの“takeover”はhistorical API/product proseで、5つ目のarchitecture axisではない。新しいarchitecture proseではBrowser/Window/Terminal **Handoff** と、必要なら明示的なTransportを使う。 |
| “browser takeover” | product prose / compatibility naming | historical API/moduleまたはbrowser Human-control feature全体を指す場合のみ許容。TransportやHandoff Semanticsの同義語にはしない。 |
| “browser transport” | Transport | Browser Target Surfaceのmedia/inputを運ぶ具体的transport実装だけを指す。Browser自体をtransportとは呼ばない。 |
| “OS takeover”, “desktop takeover”, “window takeover” | Target Surface prose | **bounded OS Window Handoff** を優先する。whole-desktop controlは現在の通常boundary外で、“window-takeover”はcompatibility module nameとしてのみ残す。 |
| 修飾なしの“Human surface” | context-dependent | policy説明では避け、実際のaxisに応じて **Human Interaction Policy** / **Target Surface** / **Human-control session/boundary** を使う。 |
| Human `Done` | Handoff Semantics | completion evidenceだけを意味する。semantic success、authentication success、target-service identity proof、approvalではない。 |
| MCP principal と target-service account/session | Handoff Semantics / consumer authorization boundary | 分離を維持する。HandoffはMCP principal/invocation/epochへbindingし、必要なtarget-service identity/contextはconsumerがfreshに検証する。 |

上記compatibility aliasがv0.2.0で行うpublic renameの全てです。このterminology convergenceではauthority、replay、completion、principal binding、transport selection、exact-window、PTY semanticsを変更しません。consumerのtransport選択もgeneric public Handoff policy APIへ持ち込みません。

### 3. Target Surface

「Humanが何を操作するか」を表す軸です。実consumer evidenceで、現在は本質的に異なる3つのsurface shapeを実証しています。

- `browser` — browser execution/window/session surface
- `os_window` — scopeを限定したOS application/window surface
- `terminal_pty` — 1つのboundedでconsumer-ownedなPTY/session。byte-stream input/output、resize、staged writer drain、process continuity、post-Human Agent state sync必須化を含む

`terminal_pty` は実証済みshapeを説明するarchitecture labelであり、frozenなpublic enum valueではありません。#46がsemantic-domain / Target Surface admission baselineをdocumentし、上記v0.2 compatibility decisionでTarget Surface enumを追加せずpublic terminology convergenceを完了します。別のnative-application/device abstractionは、実consumerで本質的に異なるboundaryが証明されるまでnon-contractualな候補に留めます。architecture上の正式用語は **Target Surface** とし、「takeover type」は説明上の言い回しに留めます。

新しいTarget Surface shapeは、authority、capture/input model、lifecycle、postcondition handlingのいずれかでexecution boundaryが本質的に異なる場合だけ追加します。application technology、product/domain、OS/device、transportが違うだけでは新shapeにしません。authority boundaryが1つのbounded application windowなら `native_app` は `os_window` のまま、`device` は通常host/runtime propertyです。whole `desktop` controlは通常のTarget Surfaceにせず、exact-surface boundaryを広げるため別の明示security reviewを要求します。editor/document/IDEもgeneric authority boundaryではなくproduct categoryです。

Target Surfaceは、具体的なruntime compatibility/diagnostics上の必要性が出るまではdescriptive/documentation-firstに保ちます。3つの実証済みshapeがあること自体はpublic enum導入理由になりません。

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
|    terminal_pty
|
+-- Transport
     Native
     WebRTC
       +-- direct
       +-- TURN fallback
     future: WebSocket / HTTP streaming / WebTransport
```

現在の実例には `browser + automation_adjacent + WebRTC`、bounded `os_window + WebRTC`、`terminal_pty + WebRTC DataChannel` があります。architecture上で組み合わせ可能でも、それだけでsupport済みとはみなしません。各consumer/provider/host pathでacceptance evidenceがある場合だけsupport済みと扱います。direct ICE / TURN relayはtransport outcomeであり、別Target Surface categoryではありません。

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

### MCP principalとtarget-service identityの分離

interventionを所有するauthenticated MCP principalと、target service内でactiveなaccount/sessionは別security domainです。HandoffはMCP principal + invocation + resource epochへcontrol-plane ownershipをbindingしますが、Humanがsign-in、MFA、account selection、CAPTCHA、consentを完了しただけでGoogle/Apple/member/enterprise accountをattestしません。account identityがauthorizationに必要なconsumerは、自分でfresh identity/context verificationを行い、unknown / changed / ambiguousならfail closedします。credential、cookie、session token、MFA/OTP、challenge answerをHandoff stateへコピーしてidentity bindingを作ってはいけません。

single-user deploymentではlogical principalごとにdedicated browser profile/runtimeを使うのが基本です。unrelated principalを同じauthenticated profileへ載せる場合は、明示的なper-principal isolation designが必要です。Human `Done` はtarget-service identity attestationとも、その後のconsequential-action approvalとも別です。

consumerがexpected service account/contextをauthorizationに使う必要がある場合は、より高assuranceな **consumer-specific target-service identity verification gate** を別途持てます。このgateはMCP principal + dedicated profile/runtime + resource epoch + intended semantic actionへ結果をbindingし、credential/tokenを露出せず、identityがunknown / ambiguous / stale / changedならfail closedします。generic Handoff stateにはtarget-service account attestation fieldを持たせません。

実consumerもこの分離を使っています。Mapsはcoarseなauthentication readinessだけを扱い、Google sign-in completionをaccount proofにせずfresh semantic reissue/revalidationを要求します。Japan Cinemaもmember sign-in dataをHandoff stateへ入れず、Human completionをcheckout/purchase authorityへ昇格させません。これらはprovider-specific identity logicをHandoff coreへ移さずgeneric boundaryを実証しています。

どのintervention reasonでこのboundaryを使うかはpackage側では決めません。`selectHumanInteractionPolicy()` を使ってconsumerごとにidentity-sensitiveなreasonを設定し、provider固有policyをgeneric coreへ持ち込みません。`selectHumanSurface()` はcompatibility aliasとして維持します。

## Browser Handoff（compatibility API: browser takeover）

`BrowserHandoffAdapter` はconsumer-levelのfirst-class Browser WebRTC compositionです。bounded WebRTC runtime + broker pairの構築をHandoff内部へ閉じ、generic HTTP-frame start operationは公開しません。consumerはすでにauthorize済みのexact process/window targetと、明示的な `{ tap, scroll, text, key }` input policyを渡し、browser/profileのstart-stop、target-service authentication semantics、checkpoint/restore policy、fresh post-Human verificationは自分で所有し続けます。Input policyはactive takeover session中に不変で、browser clientへbounded booleanだけを返し、OS inputの直前にserver側でも強制するため、UI bugでauthorityが広がることはありません。

`processId` は必須です。`windowId` 未指定ならplatform hostがそのprocessからeligible windowを厳密に1つ解決します。明示 `windowId` 指定時は、そのexact windowが同じprocess所有であることをhost側で再検証します。Linuxではさらに各Human mutation直前に、同じX11 windowのPID ownership / visibilityを確認してbounded geometryを更新します。target消失、別processによるwindow id再利用、focus failure、ownership mismatch時は別windowを選ばずhostをfenceします。primary pointer injectionはmechanism-onlyの別境界とし、standalone Xlib/libXtst childが1本のpersistent X11 connectionを維持してMOVE / DOWN / UP / CANCELを直列化し、各mutationを `XSync` 後にackします。PID / XID / geometry / active / focus authorityはNode hostだけが保持し、失敗したgestureを `XSendEvent`、DOM/CDP、xdotool pointer fallbackで継続しません。none / ambiguous / disappearance / ownership mismatchでdesktop capture/inputへfallbackすることはありません。

Adapterの `start()` が返すshort-lived locatorはreadiness証明ではありません。Runtime readinessの正本は既存WebRTC prepare/connect pathで、host-window / first-media-frame gateを通るまでusable answerを返しません。Transport failureは明示され、canonical adapterがHTTP screenshot pollingへsilent switchすることはありません。

WebRTCのmedia/input generation authorityとHuman completion authorityは分離します。completion-only HMAC capabilityはsession / intervention / epoch / principal / expiryへbindingしますが、release済みmedia generationにはbindingしません。そのため同じauthenticated principalはdisconnect後にshort-lived locatorをreloadして `Done` を押せますが、stale frame/input capabilityが再び有効になることはありません。Completionは最初にtransportをfence/revokeし、その後だけadapterのoptional consumer callbackへfresh verification開始を通知します。Callback failure時は同じcompletion-only capabilityでretryでき、成功後のduplicate deliveryはidempotentです。`Done` はあくまでcompletion evidenceであり、認証成功やapprovalではありません。

low-level optional `TakeoverBroker` はcustom compositionを明示的に必要とする場合のtransport/session primitiveです。public locatorにはmedia/input capabilityを含めません。同一originのbootstrapでremote-client leaseを1つだけclaimし、short-lived generation capabilityを返します。legacy HTTP frame/input/done operationは引き続きmatching capability / principal binding / client bindingを必要とし、canonical WebRTC completion pathだけが上記のcompletion-only capabilityを使います。

新しいbindingが、すでに所有されているleaseを暗黙に奪うことはできません。native clientは明示的なclaim/reconnect APIを使えます。reconnectには、同じauthenticated principal、generation-bound reconnect handle、以前のleaseがidle/releasedであることが必要です。成功するとclient generationを進め、capabilityとreconnect handleを両方rotateします。Browser WebRTC recoveryはSafariの重複lifecycle/failure triggerを1本のreconnectへ集約し、exact-generation releaseを待ち、active-lease conflict retryをboundedにし、generationをまたぐHuman input replayを行いません。same-LAN iPhone physical acceptanceではbackground/foregroundを3回連続復帰し、409 loopやblack-frame固定は発生しませんでした。browser app完全終了ではmemory-only reconnect stateを復元せずfresh authorized flowを要求します。expired/revoked session、activeな旧client、wrong principal、wrong handle、stale generationはfail closedします。reconnect handleにbrowser contentやtarget-service credentialを含めません。

Browser Target Surfaceを運ぶWebRTC transportではdirect-first ICEを維持し、signaling/data-plane policyをHandoff側に閉じ込めます。Safariはhost candidateのみを使い、Node/werift peerはCloudflare STUNを明示的に利用して、dependency内部のdefaultが別third-partyへ勝手に切り替わらないようにします。TURNを設定してもfallback専用で、client generationに紐づくshort-lived peer credentialを使います。network diagnosticにはcandidate type/count、peer state、限定されたtimingだけを残し、candidate文字列、address、SDP、credentialは保存しません。

モバイルの密集UI向けにはclient-sideの **Aim（照準）モード** も用意します。Aimを有効にすると表示だけをbounded 4×へ拡大し、映像drag/pinchはローカルpan/zoomに限定されremote inputを送りません。中央crosshairへ対象を合わせ、明示的な `Tap` controlを押した時だけ既存のserver-side `tap` policyを通る1回のremote tapを送ります。reconnect / orientation change / teardownではAimとview transformをresetし、consumer semantic verificationやserver input authorityは一切広げません。

touch対応SafariではTouch Eventsをgestureの基準とし、touch Pointer Eventsによる二重入力を抑止します。macOS hostでは `CGEventSource(stateID: .combinedSessionState)` を利用し、login中のuser session内で動くprocessに合わせます。tap/scrollはsession event tapを使います。exact native windowでは、ordinary non-secure AppKit text controlに限り、focused window・focused elementのPID・non-web ancestryを再検証したうえでboundedな `AXSelectedText` commitを先に試します。unsupported controlは既存のtarget-PID keyboard-event経路を維持し、ownershipまたはexact-window不一致時はfallbackせずfail closedします。text routingの診断は bounded なstage (`native_ax` / `pid_keyboard` / `event_creation_failure` / `activation_rejected` / `native_boundary_rejected`) だけを保持し、Human text、座標、target/process/window identity、session identityは保持しません。consumer APIを広げずに、window単位のcapture/inputとbrowser gestureの意味を一致させるための設計です。

broker自身はtakeover可能なsurfaceを広げません。consumer browser adapterが自身のallowlistと現在のepochに基づいて各操作を検証します。

## Window handoff

`WindowHandoffAdapter` はnon-browserのbounded window向けfirst-class componentです。BrowserとWindowは、exact process/window binding、short-lived locator/session lifecycle、direct-first ICE + optional TURN fallback、reconnect/client-generation fencing、revoke、privacy-bounded transport diagnosticsという最小のinternal bounded-window WebRTC/session coreだけを共有します。browser profile / authentication policyはBrowser facadeに残し、Window componentへ漏らしません。

Window adapterはpositiveな `processId`、必要ならexact `windowId`、明示的でboundedな `{ tap, scroll, text, key }` Human input policyを要求します。display-wide / whole-desktop fallbackはありません。`processId`だけならeligibleなowned windowを厳密に1つ解決し、`windowId`指定時はそのprocess ownershipを再検証します。target消失、ambiguity、ownership mismatch、input host failure時はscopeを広げずHuman transportをfenceします。

実non-browser consumerはCUMGです。CUMGはconsumer-localな `TakeoverBroker` + WebRTC runtime手組みから `WindowHandoffAdapter` へ移行しつつ、authorization / quarantine / replay / semantic verificationはCUMG側に維持しています。merged-code physical iPhone acceptanceではpublic Cloudflare Tunnel/TURN relayとsame-LAN directの両方を通過し、stale locator rejectionも確認済みです。#85は完了しており、今後のWindow workはfirst-class adapter境界の再証明ではなくbounded capabilityの拡張として扱います。

### macOS Window input-backend capability contract

通常のmacOS Window Handoff backendは、引き続き **bounded exact-window Human input** です。Apple Screen Sharing / Remote Management、VNC server、trusted-HID daemon、Agent向けmutation APIではありません。現在のcapability contractは次の通りです。

- mutableなHuman inputの直前に、同じexact process/window frameを毎回revalidateしてactivateする。ambiguity、target消失、ownership change、activation failureはinput拒否でfail closedする
- pointer inputはlogin session内の `combinedSessionState` からstatefulな `CGEvent` mouse move/button lifecycleを作り、exact-window revalidation後にだけ `cghidEventTap` へpostする。disconnect/revoke/expiryではpressed stateをfail-closedにreleaseする
- ordinary non-secure native textだけは別のbounded AX selected-text routeを利用できる。secure text field / web contentは対象外で、credentialやauthorization secretをHandoff input capabilityにしない
- input policyは既存の明示 `{ tap, scroll, text, key }` Human policyを維持する。Agentへgeneral trusted-HID、desktop、TCC、authorization、credential-injection primitiveを公開しない
- **secure UIへのhidden fallbackは存在しない**。exact system controlがこのbounded backendを拒否した場合はfail closedのままにする。desktop-wideまたはprivileged remote-control authorityが本質的に必要な将来backendは、Window Handoffから暗黙選択せず、別の明示review済みescalationとして導入する

#94では#99/#101のstateful macOS pointer修正後に前提を再検証しました。physical failureの原因はWebRTCや `CGEvent` pathではなくpre-input AX gateでした。System SettingsのAccessibility windowはexact geometryでactive/focusedだった一方、`AXRaise` が `kAXErrorAttributeUnsupported` (`-25205`) を返し、Handoffがactivation aidをmandatoryなauthority proofとして誤ってrejectしていました。`AXRaise` はbest-effortへ変更し、admission自体は引き続き同一processがactiveで、focused AX windowがexact capture boundsと一致することを必須にします。macOS 26.5のphysical iPhone acceptanceでは、この修正後に `Privacy & Security > Accessibility` の **追加** controlをactivateしてsystem file chooserを開けました。chooserは別focused windowになりましたがcaptureは元のbounded Accessibility windowのままで、target/desktop fallbackは追加していません。probeではTCC entry、permission value、password、credential、authorization decisionを変更していません。したがって、このcontrolのためにScreen Sharing / Remote Managementという第2backendが必須という前提は反証されています。Apple自身もScreen Sharing / Remote Managementをdesktop-control機能として説明しているため、これをWindow Handoffのsilent fallbackへ入れるとexact-window contractを越えてauthorityを広げます。

実装比較でも、privilegedな別backendを増やすより現行backend familyを維持する根拠が得られました。AppleのCore Graphics documentationはHID event tapと、HID / remote-control eventがlogin sessionへ入るsession tapを区別しています。SunshineのmacOS input backendはstateful mouse eventをCore GraphicsのHID tapへpostし、RustDeskは `CombinedSessionState` からmacOS virtual inputを構築してCore Graphics event-tap pathを使います。成熟したremote-control実装でもevent-tap詳細には差がありますが、Screen Sharing / Remote ManagementをHandoffへ取り込む根拠になるexact-window-safeな別privileged APIは確認できませんでした。参照: [Apple CGEventTapLocation](https://developer.apple.com/documentation/coregraphics/cgeventtaplocation)、[Apple Screen Sharing](https://support.apple.com/guide/mac-help/mh11848/mac)、[Sunshine macOS input](https://github.com/LizardByte/Sunshine/blob/master/src/platform/macos/input.cpp)、[RustDesk input service](https://github.com/rustdesk/rustdesk/blob/master/src/server/input_service.rs)。

## Terminal / PTY handoff

`TerminalHandoffAdapter` はexactly 1つのboundedでconsumer-ownedなPTY/session向けfirst-class componentです。実証済みTerminal authority machineとDataChannel-only WebRTC transportをcomposeし、2つ目のauthority FSMを作りません。shell spawn、cwd/env/job-control policy、consumer process supervision、terminal transcript永続化もHandoffの責務にはしません。

lifecycleはgeneric byte tunnelより強く制約します。`begin()` はAgent input / observation / resizeを先にfenceし、そのfence前にadmit済みだったwriteをconsumerがdrainします。Human claimはdrain完了とexact transport readinessの後だけ可能です。ordered Human `Done` はeventをconsumerへ返す前にHuman transportをfenceし、その後consumerがadmit済みHuman writeをdrainするまでverificationは成功できません。explicit resume後も `agentStateSynchronizationRequired` を維持し、consumerがHuman期間outputやPTY assumptionを破棄・再読込してfresh state syncをackするまでAgent PTY operationをfenceします。disconnectはDoneではなく、PTY exitからreplacement sessionを作らず、Human期間outputをAgentへreplayしません。

CUMGは現在 `TerminalHandoffAdapter` だけをconsumeし、runtime/production stagingから `ExperimentalTerminalPtyAuthority` / `ExperimentalTerminalWebRtcTakeover` への直接依存を外しています。PTY allocation、Unix descendant containment、process truth、bounded PTY I/O、content-free verificationはCUMG責務です。merged Handoff/CUMG codeでreal `/bin/cat` cross-repo WebRTC E2Eとphysical iPhone Human acceptanceをfirst-class adapter経由で通過済みです。physical runは外部Cloudflare TunnelかつTURN設定ありでしたが、selected ICE pairは記録していないため、そのTerminal run自体がTURN relayを選択したとは主張しません。#91でmobile status表示のambiguityは解消し、Safariはtransport readiness、Human authority待ち、Human active、verifying/failureをbackend authority lifecycleを弱めず明示するようになりました。

## 重大操作との分離

handoff完了と結び付いた汎用approval APIは提供しません。重大な操作を実行するconsumerは、最終的に実行する正確なactionと現在stateへ紐づいた、別の明示的なapproval mechanismを用意する必要があります。

Humanが手動作業を終えたことは「interventionが終わった」という事実でしかなく、その後の操作を承認したことにはなりません。
