# mcp-execution-handoff

[English](README.md)

MCP駆動の実行中にHuman interventionが必要になった場合、Agent実行を安全に停止し、Humanへ一時的にauthorityを移し、検証後にpolicyに従ってのみ再開するための小さなTypeScript runtimeです。

**Status:** 2つのreal adapterで再利用性を確認済みのupstreamです。`v0.1.0` は最初のsource releaseです。npm packageは引き続き `private: true` で、npm publishは行っていません。

## 目的

このruntimeは `git-ksk/maps-browser-mcp` で育ったExecution Handoffをsource of truthとして抽出したものです。`git-ksk/japan-cinema-browser-mcp` をsecond real adapterとして通し、Maps固有概念を持ち込まず成立する最小contractだけをpublicにします。

public contractは以下に限定します。

- Agent / Human execution authorityの排他制御
- 単調増加するresource epoch
- 明示的resume policy
- generic execution adapter contract
- signed durable control-plane checkpoint
- MCP MRTR `input_required` requestState binding
- principal + invocation + canonical argsのownership binding
- short-lived capability + one-client leaseを持つoptional browser takeover transport
- normal/non-automated browserを要求するprovider向けのcredential-safe external Human surface coordination

CAPTCHA solver、challenge bypass、credential relay、payment automation、generic browser agent、DOM/network export、consequential actionの自動approvalは提供しません。

## Security invariant

- AgentとHumanが同時にexecution authorityを持たない。
- Human handoffでresource epochを進め、stale stateをfail closedする。
- handoff ownershipをauthenticated logical principalとexact invocation argumentsへbindする。
- `awaiting_human` の初期状態を過ぎたunowned interventionを後からrebindしない。
- durable checkpointはcontrol-plane metadataだけを保存し、raw args、browser text、credential、cookie、CAPTCHA/OTP/MFA answer、payment data、approval receiptを保存しない。
- restart recoveryは必ず `reissue_and_revalidate` で、stale authorityを復元せず、actionをsilent replayしない。
- takeover URLはlocatorのみで、capability secretを含めない。
- capabilityはsession / intervention / resource epoch / principal / remote client binding / expiryへbindする。
- takeover leaseはremote client generation 1つだけ。reload/new tab/new deviceで新しいbindingになってもactive leaseを暗黙reclaimできない。native reconnectは旧leaseがidleになった後だけ、WebRTC browserはsuspend/disconnect時に現generationを明示releaseしてからreconnectする。どちらも同じauthenticated principal + generation-bound reconnect handleを必須とし、fresh client generationへrotateして旧capability/handleを即時fenceする。
- `no-store` / `no-referrer` / nonce-bound CSP client asset / bounded inputを維持する。
- credential-safe external Human controlはHuman authorityが排他的にactiveな間だけ開始でき、automation authorityを戻す前にexternal sessionをrevokeする。
- external Human providerから保持するのはbounded control-plane field（provider kind / intervention / epoch / principal binding / session id / operator locator / optional expiry）のみで、任意provider metadataは破棄する。
- **Human takeover完了は別actionのapprovalではない。** consequential actionのapprovalはconsumer側の別経路で明示的に扱う。
- stateful/consequential actionは、安全なreplayが別途成立しない限りhandoff後に自動replayしない。

詳細は [Architecture 日本語版](docs/architecture.ja.md)、[Positioning 日本語版](docs/positioning.ja.md)、[Roadmap 日本語版](ROADMAP.ja.md)、[Security Policy 日本語版](SECURITY.ja.md)、[Changelog](CHANGELOG.md) を参照してください。

## Resume policy

coreは `replay_safe` / `revalidate` / `confirm_before_execute` / `never_replay` を記録します。MCP bridgeはさらに `retry_original` / `require_fresh_semantic_action` のcall-site strategyを記録します。

consumerは常に厳しい方を採用します。`require_fresh_semantic_action` や `never_replay` がHuman完了だけを理由にautomatic replayへ昇格することはありません。

## Credential-safe external Human surface

Identity providerによっては、software-controlled / embedded browser上でのcredential entry自体を拒否・禁止します。その場合、automation-adjacentな `browser-takeover` をstealth化するのではなく、`CredentialSafeHumanSurfaceRuntime` とpluggable external Human providerを使います。

`CredentialSafeHumanSurfaceRuntime` 自体はremote desktopを実装しません。providerは既存remote-access製品やnormal-browser Human surfaceへのoperator locatorを返せます。consumerはcredential entry前にautomation runtimeを完全停止し、同じdedicated non-default profileをCDP / remote-debugging / automation attachmentなしのnormal browserで起動し、external sessionをrevokeしてnormal browserがprofileを解放するまでautomationを再開しない責任を持ちます。

```text
automation profile + CDP
  -> identity-sensitive intervention
  -> Human authority exclusive
  -> automation browser完全停止
  -> same dedicated profileをnormal browserで起動（CDPなし）
  -> external provider経由でHuman認証
  -> external provider session revoke/close
  -> normal browser終了 + profile lock解放確認
  -> automation browser再起動
  -> fresh readiness / semantic validation
  -> stale pre-auth stateをreplayしない
```

`selectHumanSurface()` は、consumerが設定したsign-in / consent等のreasonだけを `credential_safe_external` に振り分ける小さなpolicy helperです。どのreasonがidentity-sensitiveかをgeneric coreは決めません。

## Browser takeover

`browser-takeover` はoptionalです。brokerが知るintervention情報は `{ id, epoch }` のみで、principal bindingとbrowser adapterはconsumerから明示的に渡します。Maps URL、Cinema provider、CAPTCHA分類、provider policyはgeneric layerへ入りません。

native operator client向けには明示的なclaim/reconnect pathも提供します。ただしreconnectはimplicit lease transferではありません。旧clientがidleで、authenticated principalが一致し、generation-bound reconnect handleが一致した場合だけ新generationへrotateします。成功時は旧capabilityと旧reconnect handleを即時無効化します。reconnect handleはcontinuity用control-plane metadataであり、target-service credentialやbrowser/session contentを含めません。

optionalなWebRTC browser transportはsignaling / H.264 RTP / DataChannel input / Safari lifecycle / reconnect fencingをHandoff内部へ閉じ込めます。初期Safari acceptance profileは1280×720 / 30 fpsのConstrained Baseline H.264です。WebRTC locatorは選択されたhost capture surfaceを`playsinline` videoへ直接表示し、そのsurfaceへのtap/swipeを直接操作へ変換します。touch対応SafariではTouch Eventsをswipeのauthoritative pathとし、touch Pointer Eventsは二重入力防止のため無視します。consumerはruntimeをtarget processへbindでき、その場合はon-screenの対象windowが厳密に1つだけ解決できることを要求し、ScreenCaptureKit captureとinputを同じwindow boundsへcropしてdesktop全体は公開しません。文字入力とBackspaceはiOS keyboardを使い、旧HTTP frame/input UIのScroll / Tab / Send等へfallbackしません。background / peer disconnect / explicit suspendではpeerを破棄してそのclient generationをreleaseし、foreground復帰はfresh generationを取得してから新peerを作ります。`Done` はtransport teardownより先にbroker generationをrevokeし、認証成功とは扱いません。

direct-first ICEは両peerで明示します。Safari/browser側はhost-only (`iceServers: []`) のままとし、STUN不達がnon-trickle browser gatheringの待ち時間を増やさないようにします。Node/werift側は `stun:stun.cloudflare.com:3478` を明示し、weriftの暗黙default STUNをreview可能なCloudflare network-metadata trust boundaryへ置き換えます。このSTUN requestではserver側public network addressがCloudflareへ見える可能性がありますが、principal / intervention / client identifierは送信しません。optionalなCloudflare Realtime TURNはpeerごとのshort-lived credentialを使うfallbackのみで、`iceTransportPolicy: all` を維持しrelay-onlyにはしません。raw candidate文字列 / IP address / SDP / credential / framebuffer / Human inputはdiagnosticやdurable control-plane artifactにせず、diagnosticはcandidate type/count・peer state・bounded timingだけに限定します。

surface eligibility、native browser restriction、postcondition verification、authentication/principal derivation、sensitive data境界はconsumer adapter側の責務です。

## 開発

Node.js 20以上。

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm audit --audit-level=moderate
```

テスト目的でlive CAPTCHA/challengeを意図的に発生させません。

## Upstream検証結果

2 real adapterによる抽出gateは満たしました。

- `git-ksk/maps-browser-mcp` がfirst real consumerとしてgreen
- `git-ksk/japan-cinema-browser-mcp` がsecond real consumerとしてgreen
- generic `src/` contractにMaps / Google / Cinema / provider / Chrome / CDP固有概念なし
- authority / epoch / ownership / checkpoint / takeover lease / capability / CSP / replay invariantをdeterministic testで維持
- 両consumerがこのrepositoryのimmutable commitをpinし、clean-install CIを通過

このrepositoryをExecution Handoffのupstream source of truthとして扱います。`v0.1.0` は、2つのreal adapterでの検証後に確定した最初の **source release** です。npm publishは別判断のままで、`private: true` を維持しています。

## License

MIT
