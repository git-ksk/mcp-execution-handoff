# mcp-execution-handoff

[English](README.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

MCPで動く処理の途中でHumanによる手動操作が必要になったとき、Agentの実行を安全に止めて一時的にHumanへ権限を移し、明示的な検証とpolicy確認を通過した場合だけ処理を再開するための、小さなTypeScript runtimeです。

**Status:** 再利用可能なupstreamとして検証済みです。`v0.2.0` が現在のGitHub/source release baselineで、`v0.1.0` は最初のsource releaseです。npm packageは引き続き `private: true` で、npmには公開していません。

## このプロジェクトが必要な理由

このruntimeは `git-ksk/maps-browser-mcp` で生まれました。その後、2つ目の実consumerである `git-ksk/japan-cinema-browser-mcp` でも、Maps固有の概念を持ち込まず同じcontractが成立することを確認できたため、共通部分をupstreamとして切り出しました。

公開するcontractは意図的に狭くしています。

- AgentとHumanの実行権限を排他的に管理する
- resource epochを単調増加させ、古いstateを無効化する
- resume policyを明示する
- 汎用的なexecution adapter contractを提供する
- 署名付きのdurable control-plane checkpointを扱う
- MCP MRTRの `input_required` と `requestState` をbindingする
- principal、invocation、canonical argumentsへownershipをbindingする
- short-lived capabilityとone-client leaseを持つoptionalなBrowser Handoff / bounded Human-control transportを提供する
- normal/non-automated browserが必要なprovider向けに、credential-safe external Human surfaceをcoordinationする

一方で、CAPTCHA solver、challenge bypass、credential relay、payment automation、generic browser agent、remote-desktop platform、DOM/network export、重大操作のautomatic approvalは提供しません。Browser/Window Human-control transportはoptionalなbounded componentでありproduct定義そのものではありません。詳細は [位置づけ](docs/positioning.ja.md) を参照してください。

## Packages / modules

```text
src/core/
  lifecycle.ts     Agent/Human authority, resource epoch, resume policy
  adapter.ts       minimal execution adapter contract
  invocation.ts    canonical invocation digest
  owner.ts         principal + invocation ownership binding
  checkpoint.ts    signed durable control-plane metadata only
  runtime.ts       checkpoint/recovery coordinator
  audit.ts         bounded metadata audit contract
  human-surface.ts credential-safe external Human provider contract

src/mcp/
  mrtr.ts          requestState helpers + input_required schema/prompt

src/browser-takeover/
  session.ts       locator, short-lived capability, one-client lease
  broker.ts        optional bounded remote browser-control surface
```

## セキュリティ上の不変条件

- AgentとHumanが同時に実行権限を持たない。
- Human handoffを開始するとresource epochを進め、古いstateはfail closedする。
- handoff ownershipは、認証済みlogical principalと正確なinvocation argumentsへbindingする。
- MCP principalとtarget service/browser内でactiveなidentityは別security domainとして扱う。Human completionはtarget-service accountのattestationではなく、必要なidentity確認はconsumer固有のfresh verificationで行い、credential/token passthroughを使わない。
- `awaiting_human` の初期状態を過ぎた後に、owner未設定のinterventionを別ownerへ付け替えない。
- durable checkpointへ保存するのは限定されたcontrol-plane metadataだけ。raw action arguments、browser text、credential、cookie、CAPTCHA/OTP/MFA answer、payment data、approval receiptは保存しない。
- restart後のrecoveryは常に `reissue_and_revalidate`。古い実行権限を復元せず、actionを黙って再実行しない。
- Browser Handoff locator（compatibility takeover URL API）はlocatorだけを含み、capabilityはauthenticated same-origin bootstrapの後にだけ返す。
- capabilityはsession、intervention、resource epoch、principal、remote client binding、有効期限へscopeする。
- takeover leaseを所有できるのは1つのremote client generationだけ。reload/new tab/new deviceによる新しいbindingが、既存leaseを暗黙に奪うことはできない。native reconnectは旧leaseがidleになった後だけ、WebRTC browserはsuspend/disconnect時に現在generationを明示releaseしてからreconnectする。どちらも同じauthenticated principalとgeneration-bound reconnect handleを要求し、新しいclient generationへrotateすると同時に古いcapability/handleを即時無効化する。
- takeover responseでは `no-store`、`no-referrer`、nonce-bound CSP client asset、bounded inputを維持する。
- credential-safe external Human controlはHuman authorityがすでに排他的な間だけ開始でき、automation authorityを戻す前にexternal sessionをrevokeする。
- external Human providerから保持する情報は、provider kind、intervention/epoch/principal binding、session id、operator locator、optional expiryなどの限定されたcontrol-plane fieldだけとし、余分なprovider metadataは破棄する。
- **Human takeoverの完了は、別actionへの承認ではない。** 重大操作にはconsumer側で別の明示的approval mechanismが必要。
- stateful / consequential actionは、安全なreplayが別途確認できない限りhandoff後に自動再実行しない。

詳細は [アーキテクチャ](docs/architecture.ja.md)、[Recovery / Observability](docs/recovery-observability.ja.md)、[位置づけ](docs/positioning.ja.md)、[ロードマップ](ROADMAP.ja.md)、[リリース手順](RELEASING.ja.md)、[セキュリティポリシー](SECURITY.ja.md)、[Changelog](CHANGELOG.md) を参照してください。

## Resume policy

coreは次のいずれかを記録します。

- `replay_safe` — 検証後、同じ処理を再実行してよいかconsumerが判断できる
- `revalidate` — 実行前に現在のsemantic/resource stateをもう一度検証する必要がある
- `confirm_before_execute` — 重大操作の前に別の明示的approval flowが必要
- `never_replay` — 中断したactionを自動再実行してはいけない

MCP bridgeはcall-site strategyとして次も記録します。

- `retry_original`
- `require_fresh_semantic_action`

consumerは常に、より厳しい結果を採用します。特に `require_fresh_semantic_action` や `never_replay` が、Humanが手動作業を終えたという理由だけでautomatic replayへ変わることはありません。

## Credential-safe external Human surface

identity providerによっては、software-controlled browserやembedded browserでのcredential入力を拒否・禁止します。その場合、automationに隣接したtransportを「より見つかりにくくする」方向へ強化してはいけません。`CredentialSafeHumanSurfaceRuntime` はpluggableなHuman-only surfaceをcoordinationしますが、具体的なbrowser trust boundaryはproviderごとに異なります。

normal non-automated browserを要求するproviderでは、consumerはautomationを完全に停止し、同じ専用non-default profileをCDP / remote-debugging attachmentなしでnormal browserとして起動します。external sessionのrevokeとprofile lockの解放を確認するまでautomationを復元しません。

hosted browser execution planeでtarget serviceがbrowser automation infrastructureを明示的に許容している場合、`HostedBrowserTakeoverProvider` は **automation-compatibleなHuman-control boundary** に限ってbounded `TakeoverBroker` を利用できます。ただし、CDPを隠したりnormal browser相当に変えたりする機能ではありません。automation-managed browserを拒否するcredential surfaceで、normal-browser boundaryの代わりに使ってはいけません。

Humanが入力したtextはin-memory Human transport/input adapterだけを通し、MCP/model result、durable state、diagnostic、log、process argvへ入れません。

normal-browser pathのlifecycleは次のとおりです。

```text
automation profile + CDP
  -> identity-sensitive intervention
  -> Human authority becomes exclusive
  -> stop automation browser completely
  -> open same dedicated profile in normal browser (no CDP)
  -> Human authenticates through an external provider
  -> revoke/close external provider session
  -> close normal browser and verify profile lock release
  -> relaunch automation browser
  -> fresh readiness / semantic validation
  -> never replay stale pre-auth state
```

credential-safe browser handoffでは、このlifecycleをOS共通ルールとして扱います。Humanはautomation-managed browserではなくnormal browser processを使います。macOSとLinuxで異なるのはOS/window capture-input helperだけです。

Linux hostはtarget PIDに属するX11 windowを厳密に1つだけ解決し、そのwindowだけをbounded CPU H.264 pipelineでcaptureします。window discovery / PID ownership / geometry / activation / focusはNode側のfail-closed policyとして維持します。primary pointerのmotion / down / upだけは、小型standalone Xlib/libXtst helperへ委譲し、1 Handoff hostの間は1本のX11 connectionを維持して、各XTEST mutationを `XSync` 完了後にackします。scroll / key / textは既存のbounded OS/window pathを維持し、WebRTC generation / TURN / revoke machineryもそのまま再利用します。Human textはprivate stdin / transient clipboardだけを通し、clipboardはすぐclearします。Browser/profile persistenceはconsumer/deployment側の責務であり、Handoffのcontinuity stateにはしません。

`selectHumanInteractionPolicy()` は、sign-in / consentなどconsumerが設定したreasonを `credential_safe_external` へrouteし、それ以外を `automation_adjacent` に残すcanonical policy helperです。既存consumer向けに `selectHumanSurface()` はsource/runtime-compatible aliasとして維持します。どのreasonがidentity-sensitiveかはcoreでは決めません。

## First-class surface component

consumer-facingなcomponent familyを明示しています。共通化できるHandoff semanticsは共有しますが、異なるtarget mechanicsを1つのgeneric runnerへ無理に押し込みません。

| Component | Boundary | 現在のevidence |
| --- | --- | --- |
| `BrowserHandoffAdapter` | exact browser/window + WebRTC上のbounded Human input | #70で完了。既存browser consumerとphysical mobile transport acceptanceをbaselineとして維持します。 |
| `WindowHandoffAdapter` | exact bounded OS application window。desktop fallbackなし | #85で完成しCUMGも利用中。merged-code physical iPhone acceptanceはpublic Tunnel/TURN relayとsame-LAN directの両方を通過し、stale locator拒否も確認済みです。 |
| `TerminalHandoffAdapter` | 1つのconsumer-owned bounded PTY/session + DataChannel WebRTC | #86で完了。CUMGはexperimental部品の直接compositionから移行済みで、merged-code real PTY E2Eとphysical iPhone Human acceptanceも通過済みです。#91でmobileのconnection / Human authority / verifying stateを明示的かつfail-closedにしました。 |

これらadapterの存在だけでgenericなpublic Target Surface enumをfreezeしません。実証済みsurface shapeはBrowser / bounded OS Window / bounded Terminal-PTYの3つです。#46がsemantic-domain / Target Surface admission baselineをdocumentし、v0.2 terminology convergenceではこのlabelをdocumentation-firstのまま維持しつつ、Human Interaction Policyだけをcompatibility-safeなpublic nameへ収束します。どのcomponentでもHuman `Done`はtransport/lifecycle stepの完了evidenceに過ぎず、semantic successや重大操作のapprovalではありません。

## Browser Handoff（compatibility module: `browser-takeover`）

Standaloneなbrowser MCP consumer向けのcanonical high-level WebRTC compositionは `BrowserHandoffAdapter` です。consumerが渡すのはintervention / principal binding、exact target process/window、明示的でboundedなHuman input policy、自分で所有するbrowser/profile lifecycleで、HandoffがWebRTC runtime + broker compositionを内部で構成します。Consumer-facing surfaceは `start()` / `revoke()` / HTTP routing + bounded diagnosticsに絞り、canonical Browser Handoffがlegacy HTTP frame/input transportへsilent downgradeすることはありません。Locator発行はcontrol-plane setupに過ぎず、media/input pathがusableになる前にhost-window readinessとfirst-media-frame gateを通ります。Browser profile persistence、target-service authentication、post-Human checkpoint / verificationはconsumer責務のままです。

```ts
import { BrowserHandoffAdapter } from "mcp-execution-handoff/browser-takeover";

const browserHandoff = new BrowserHandoffAdapter({
  takeover: { enabled: true, publicBaseUrl, ttlMs: 60_000 },
  runtime: { hostExecutable, displayName }, // Linux/X11 hostではdisplayNameを指定
  onComplete: async ({ interventionId, epoch }) => {
    // ここではHuman authorityはすでにfence済み。consumer-ownedなfresh verificationだけ開始する。
    await beginFreshVerification(interventionId, epoch);
  }
});

const locator = browserHandoff.start({
  intervention: { id: interventionId, epoch },
  principalBinding,
  target: { processId, ...(windowId ? { windowId } : {}) },
  inputPolicy: { tap: true, scroll: true, text: false, key: false }
});
```

Authenticatedな `/takeover/*` HTTP requestは `browserHandoff.handle(...)` へrouteします。`inputPolicy` はtakeover sessionへbindingされ、OS inputの前にserver側で強制されます。browser UI側でも許可されていないkeyboard/input controlを隠してdefense in depthにします。optionalな `onComplete` callbackはHuman transport authorityをfenceした後にだけ呼ばれ、consumer-ownedなfresh verification開始のsignalに限定します。認証成功や重大操作の成功・承認を意味しません。ICE / STUN / TURN provider選択やrelay credentialは `start()` に渡さず、Handoff deployment/runtime側の責務に留めます。

`BrowserHandoffAdapter` と `WindowHandoffAdapter` は同じinternal bounded-window WebRTC/session coreを共有します。Browserはbrowser-policy facadeのままで、shared coreが所有するのはexact target binding、WebRTC/session/reconnect/revoke、bounded diagnosticsだけです。

## Window handoff

非browserのapplication windowには、first-class high-level componentとして `WindowHandoffAdapter` を使います。positiveなtarget process、必要ならexact window id、そして明示的でboundedなHuman input policyが必須です。このadapterからdisplay-wide/desktop fallbackへ広がる経路はありません。`processId`だけならeligibleなowned windowを厳密に1つだけ解決する必要があり、`windowId`も指定した場合は既存host boundaryがそのexact ownershipを再検証します。target消失、ambiguity、ownership mismatchはfail closedです。

macOSのpointer inputは、exact-window revalidation後にstateful `CGEvent` / `cghidEventTap` を使うbounded pathのままです。#94ではmacOS 26.5のSystem Settings Accessibility **追加** controlを現行pathでactivateできることを確認したため、Screen Sharing / Remote Managementをprivileged / desktop-wide fallbackとして追加しません。fail-closed boundaryの詳細はarchitectureのinput-backend contractを参照してください。

```ts
import { WindowHandoffAdapter } from "mcp-execution-handoff/window-takeover";

const windowHandoff = new WindowHandoffAdapter({
  takeover: { enabled: true, publicBaseUrl, ttlMs: 60_000 },
  runtime: { hostExecutable, displayName },
  onComplete: async ({ interventionId, epoch }) => {
    // Human transportはfence済み。application stateはconsumerがfreshにverifyする。
    await beginFreshWindowVerification(interventionId, epoch);
  }
});

const locator = windowHandoff.start({
  intervention: { id: interventionId, epoch },
  principalBinding,
  target: { processId, windowId },
  inputPolicy: { tap: true, scroll: true, text: false, key: false }
});
```

interventionが必要な理由、application/process lifecycle、semantic verification、replay/resume policyはconsumer責務のままです。Handoffはshort-lived locator、one-client session、exact bounded windowのmedia/input transport、direct-first WebRTC/TURN、reconnect generation fence、revokeを所有します。Human `Done`はHuman transport stepの終了だけを意味し、application successやapprovalではありません。

## Terminal / PTY handoff

`TerminalHandoffAdapter` は、1つのboundedでconsumer-ownedなPTY/session向けのfirst-class componentです。Handoffはshellをspawnせず、cwd / env / job-control semanticsも所有しません。accepted済みPTY authority state machineとDataChannel-only WebRTC/TURN transportを1つにcomposeし、実際のPTY/processとcontent-free postcondition verificationはconsumer側に残します。

process境界を持つconsumerでも使えるよう、drainは明示的なstaged contractです。`begin()` はHuman locatorを返す前にAgent authorityをfenceします。consumerはそのfence前にadmit済みだったAgent writeを物理的にdrainし、完了後だけ `claimHumanAfterAgentDrain()` を呼びます。orderedなHuman `Done` は `nextHumanEvent()` が返す前にtransport側でfenceされ、Handoff authorityも直ちに `verifying` へ移ります。その後consumerがadmit済みHuman writeをdrainし、`confirmHumanDrain()` を呼ぶまでverificationは成功できません。

```ts
import { TerminalHandoffAdapter } from "mcp-execution-handoff/terminal-takeover";

const terminalHandoff = new TerminalHandoffAdapter({
  binding: { sessionId, sessionGeneration, principalBinding },
  takeover: { enabled: true, publicBaseUrl, ttlMs: 60_000 }
});

const { intervention: awaiting, locator } = terminalHandoff.begin();
await pty.drainAgentWrites();
// authenticatedな /takeover/terminal/* を terminalHandoff.handle(request, boundPrincipal) へrouteする。
await waitUntil(() => terminalHandoff.transportStatus(awaiting).transportReady);
const human = terminalHandoff.claimHumanAfterAgentDrain(awaiting);

const event = terminalHandoff.nextHumanEvent(human);
if (event?.kind === "input") await pty.writeHuman(event.data);
if (event?.kind === "resize") await pty.resize(event.rows, event.cols);
if (event?.kind === "done") {
  await pty.drainHumanWrites();
  const drained = terminalHandoff.confirmHumanDrain(event.verifying);
  const ready = terminalHandoff.reportVerification(drained, await verifyPtyPostcondition());
  const resume = terminalHandoff.resume(ready);
  if (resume.sessionAlive && resume.agentStateSynchronizationRequired) {
    await invalidateAndReloadAgentPtyState();
    terminalHandoff.acknowledgeAgentStateSynchronization();
  }
}
```

Human-visibleなPTY outputは、exact Human interventionがauthorityを持つ間だけ `pushHumanOutput()` で送ります。input/output byteはephemeralなmethod/DataChannel bufferにだけ存在し、generic Handoff checkpoint / audit / diagnostics / model contentへ入りません。disconnectは`Done`ではなく、Agent authorityを自動復帰させません。exact PTY exitはそのadapter instanceをterminalに閉じ、replacement sessionを生成しません。explicit resume後もconsumerがfresh state synchronizationをackするまでAgent input / observation / resizeはfenceされたままです。このsync境界でconsumerはHuman-period outputやcwd / env / job / prompt assumptionを必要に応じてdiscard/re-readします。

direct-first ICE、TURN fallback、one-client lease、stale generation/capability rejectionはHandoffが所有します。PTY allocation、descendant containment、process exit truth、shell/program policy、semantic verificationはconsumer責務のままです。このadapterを公開しただけでWindows ConPTY descendant containment parityを主張しません。

`TakeoverBroker` は、HTTP frame mode、Native composition、custom transport assemblyを明示的に必要とするconsumer向けのlow-level transport/session primitiveとして残します。brokerがinterventionについて知るのは `{ id, epoch }` だけで、principal bindingとbrowser adapterはconsumerから明示的に渡します。Maps URL、Cinema provider、CAPTCHA分類、provider policyはgeneric layerへ入りません。

native operator client向けには明示的なclaim/reconnect pathも提供します。ただしreconnectはimplicit lease transferではありません。以前のclientがidleで、authenticated principalが一致し、generation-bound reconnect handleも一致した場合だけ新generationへrotateできます。成功すると旧capabilityと旧reconnect handleを即時無効化します。reconnect handleはcontinuity用control-plane metadataであり、target-service credentialやbrowser/session contentを含みません。

Browser Target Surface向けのoptional WebRTC transportは、signaling、H.264/RTP、DataChannel input、Safari lifecycle、reconnect fencingをHandoff内部へ閉じ込めます。macOS hostはScreenCaptureKit / CoreGraphics、Linux hostはisolated X11 display + exact target-window capture + bounded CPU H.264 + OS/window inputを使います。

モバイルの密集UI向けにはclient-sideの **Aim（照準）モード** も用意します。Aimを有効にすると表示だけをbounded 4×へ拡大し、映像drag/pinchはローカルpan/zoomに限定されremote inputを送りません。中央crosshairへ対象を合わせ、明示的な `Tap` controlを押した時だけ既存のserver-side `tap` policyを通る1回のremote tapを送ります。reconnect / orientation change / teardownではAimとview transformをresetし、consumer semantic verificationやserver input authorityは一切広げません。

Safari transportは最大1280×720に制限します。現在のacceptanceではmacOS hostは30 fps、Linux CPU hostは既定15 fpsです。WebRTC locatorは選択したhost capture surfaceを `playsinline` videoへ直接表示します。1×ではtap/swipeをそのsurfaceへの直接操作へ変換します。小さいmobile画面での精密操作向けに、Handoff所有のboundedな1×〜4× local view transformも持ち、zoom buttonまたは2本指pinch/panで拡大できます。zoom中の1本指dragはlocal panだけを行い、これらのview gestureからtarget tap/scrollは送信しません。静止tapだけをtransform後のvideo boundsから同じexact captured windowへ逆変換します。browser/page zoomやtarget-window identityは変更せず、reconnect/orientation changeでlocal transformをresetします。hidden browser input bridgeはiOS keyboardを使ってtext/Backspaceを送ります。

touch対応SafariではTouch Eventsをswipeのauthoritative pathとし、touch Pointer Eventsは二重入力防止のため無視します。consumerはruntimeをtarget processへbindingでき、その場合はon-screenの対象windowを厳密に1つだけ解決できることを要求し、captureとinputを同じwindow boundsへ限定してdesktop全体を公開しません。legacy HTTP frame/input UIへfallbackすることもありません。

background、peer disconnect、explicit suspendではpeerを破棄し、そのclient generationをreleaseします。foregroundでmediaを復旧する場合はfresh generationを取得してから新peerを作ります。reconnectはSafariの重複lifecycle/failure triggerをsingle-flightへ集約し、exact generation release完了を待ち、active-lease conflict retryをboundedにし、generationをまたぐHuman inputのqueue/replayは行いません。same-LAN iPhoneのphysical runではbackground/foregroundを3回連続で復帰し、409 loopやblack-frame固定は発生しませんでした。browser appを完全終了するとmemory-only reconnect stateが失われるため、implicit lease transferではなくfresh authorized flowを要求します。media/input authorityとは別のprincipal / intervention / epoch / expiry-boundなcompletion-only capabilityにより、同じauthorized locatorをreloadしてもstale generationを復活させず `Done` だけ配送できます。`Done` はtransport authorityをfenceしてからconsumer completion callbackへ通知し、認証成功やapprovalとは扱いません。Linux hostでは明示PID/window bindingを実際に検証し、各Human mutation直前にも同じX11 windowのPID ownershipとbounded geometryを再検証します。target消失やownership変更時はtransportをfenceし、別windowやdesktopへscopeを広げません。LinuxのXTEST helperはmechanism-onlyで、boundedなroot座標とbutton lifecycleだけを受け取り、PID / XID / title / session authorityは保持しません。`XSendEvent` を使わず、primary gesture失敗時にxdotoolへ自動fallbackもしません。

物理iPhone Safariで、same-LAN direct WebRTCとcellular/4G TURN relayの両方をacceptance済みです。window-scoped video、別Mac appがfrontmostな状態からのtarget-window再activation、tap/focus、text、Backspace、scroll、Done/revoke後のstale locator拒否まで確認しています。completion-onlyなreload recoveryはdeterministic testで固定済みです。boundedなclient-side precision zoom/panも実装・transform/gesture regressionで固定し、次のmobile UX gateはportraitでのphysical precision acceptanceです。target-window resizeやより広いkeyboard compositionはfollow-upで、transport baselineの前提条件ではありません。

direct-first ICEは両peerで明示します。relay provider未設定時はSafari/browser側をhost-only (`iceServers: []`) に保ち、Node/werift側だけreview済みの明示STUNを使ってdependencyの暗黙default STUNを排除します。optional TURNはfallback専用で、productionでは `iceTransportPolicy: all` を維持しrelay-onlyにはしません。

HandoffはCloudflare Realtime TURNとself-hosted coturn TURN RESTの両方をoptional providerとして扱えます。どちらもgeneration binding後にbrowser/server別のshort-lived credentialを発行し、TURN usernameやmetadataへprincipal / intervention / client identityを含めません。coturn adapterは `timestamp:random` usernameと `base64(HMAC-SHA1(shared-secret, username))` を使い、coturnの `use-auth-secret` と互換にします。coturnにはcredential単位の即時revoke APIがないため、Handoff authorityは即時revokeしつつ、relay credential自体は同じgeneration expiryまでで自然失効させます。

raw candidate文字列、IP address、SDP、credential、framebuffer、Human inputはdiagnosticやdurable control-plane artifactへ保存しません。diagnosticはcandidate type/count、peer state、bounded timingに限定します。

consumerは引き続き次を担当します。

- Human takeoverを許可するsurfaceの判定
- native browser/device operationの制限
- postcondition verification
- authenticationとlogical principalの導出
- sensitive dataがMCP/tool arguments/logへ流れないようにすること

## 開発

Node.js 20以上が必要です。

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm audit --audit-level=moderate
```

テストはdeterministicに保ち、実サービスのCAPTCHA/challengeを意図的に発生させません。

## Upstream検証結果

2つの実consumerによる抽出gateは満たしています。

- `git-ksk/maps-browser-mcp` が1つ目の実consumerとしてgreen
- `git-ksk/japan-cinema-browser-mcp` が2つ目の実consumerとしてgreen
- generic `src/` contractにMaps / Google / Cinema / provider / Chrome / CDP固有概念なし
- authority / epoch / ownership / checkpoint / takeover lease / capability / CSP / replay invariantをdeterministic testで維持
- 両consumerがこのrepositoryのimmutable commitをpinし、clean-install CIを通過

このrepositoryをExecution Handoffのupstream source of truthとして扱います。`v0.2.0` が現在の **GitHub/source release only** baselineです。Browser、bounded OS Window、bounded Terminal/PTYをfirst-class source componentとして確立しつつ、Target Surface labelはdocumentation-firstのまま、Human Interaction Policyのcompatibility-safe aliasも維持します。npm publishは別判断のままで、`private: true` を維持しています。詳細は [リリース手順](RELEASING.ja.md) を参照してください。

## License

MIT
