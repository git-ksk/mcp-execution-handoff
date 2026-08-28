# ロードマップ

[English](ROADMAP.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

このロードマップはリリース日程ではなく、プロダクトと公開contractの方向性、および各milestoneの完了条件を示します。必要に応じてpre-1.0 versionを追加します。`0.9` の次が必ず `1.0` である必要もありません。

## 現在のbaseline: v0.3.0

`v0.3.0` が現在のGitHub/source-release baselineです。v0.2.0のfirst-class Browser / bounded OS Window / bounded Terminal-PTY source componentを維持し、完了済みbounded Window / Linux / media hardeningに加えて、Recovery / Observability boundaryとしてprovider-neutral bounded checkpoint storage、privacy-bounded audit / operator diagnostics v1、`reissue_and_revalidate`だけを許すdeterministic crash/restart conformanceをbaselineへ含めます。

npm packageは引き続き `private: true` です。npmへの公開はroadmap上の必須条件ではなく、後述のpublication gateで独立して判断します。

### 現在の作業状態 — 2026-08-28

v0.1.0以降の検証では、実consumer evidenceに基づくconsumer-facing Handoff componentが3本まで揃いました。semantic-domain / Target Surface admission contractは #46でdocument済みで、v0.2 terminology convergenceでは `TargetSurfaceKind` enumをfreezeせずHuman Interaction Policyへcanonical aliasを追加します。

- `BrowserHandoffAdapter` は #70で完成し、canonicalなhigh-level Browser WebRTC compositionです。Human側のBrowser `Done` は #84で即時one-shot化されました。
- `WindowHandoffAdapter` は #85で完成し、CUMGもconsumer-localな `TakeoverBroker` / runtime手組みから移行済みです。merged codeのphysical iPhone acceptanceでは、public Tunnel/TURN relayとsame-LAN directの両方を通過し、stale locator拒否も確認済みです。
- `TerminalHandoffAdapter` は #86で完成しました。CUMGはexperimental PTY authorityとTerminal WebRTC transportの個別compositionをやめ、merged-code real PTY cross-repo E2Eとphysical iPhone Human acceptanceも通過済みです。mobileのconnection / Human authority / verifying表示は #91で明示的かつfail-closedになりました。
- Safari suspend/disconnect後のBrowser WebRTC reconnectは #104でdeterministic化しました。generation releaseをsingle-flight化し、重複lifecycle eventを1本のreconnectへ集約し、active-lease conflictをboundedに観測できます。same-LAN iPhoneのphysical runではbackground/foregroundを3回連続で復帰し、409 loopやblack-frame固定は発生しませんでした。Safari appの完全終了はimplicit lease reclaimを行わず、fresh authorized flowを要求します。
- #40のHTTPS/WSS managed-runtime evaluationは、#152 / #155 / #156でHandoff-ownedなBrowser / Window fallback `WebRTC direct -> WebSocket relay -> optional WebRTC/TURN relay` へ昇格しました。TURNなしのproduction-shaped Cloud Run `run.app`でphysical iPhone Safari acceptanceまでPASSし、bounded Human input、Done、verification/teardown、stale direct/WSS fencingを確認済みです。Maps consumer adoptionは `git-ksk/maps-browser-mcp#147` で別追跡します。
- #47でmacOS/Linuxのbounded exact-window primitiveを再利用可能にし、whole-desktop fallbackは追加していません。
- #48でbounded Terminal/PTY semantic dogfoodを完了し、Agent/Human staged drain fence、explicit resume、post-Human state sync必須化、Human期間outputのAgent replay禁止を確立しました。
- CUMGはWindowとTerminalの両方で実証済みnon-browser consumerです。

したがって、実証済みの **surface shape** は Browser、bounded OS Window、bounded Terminal/PTY の3つです。ただしこれはpublic `TargetSurfaceKind` enumをfreezeしたという意味ではありません。#46をsemantic-domain / admission baselineとして維持し、v0.2 terminology gateはpolicy軸のcompatibility aliasとdocumentation-firstなTarget Surface labelで完了します。

#42（positioning）、#46（semantic domain / Target Surface admission）、#5（MCP principalとtarget-service identity分離）のdocumentation/design closeoutは完了しました。historical umbrellaの #11 / #13 もsupersededとしてclose済みです。supportするworkはfirst-class bounded Window / WebRTC / WSS evidence、v0.2.x bounded hardening（#124 / #56 / #34完了）、v0.3 recovery / observability（#127〜#130）、後続の明示authority / transport / hosted work（#125 / #19 / #12）へ分離しました。whole-desktopやmandatoryなcustom Native-clientをdefault product scopeには残しません。

#94と#124は完了です。#94では既存のexact-window stateful macOS pointer backendでテスト対象のSystem Settings secure controlを操作でき、privilegedなScreen Sharing / Remote Management fallbackが不要だと確認しました。#124では続いて、明示opt-inのsuccessor-window lineageを追加しました。Human sessionは1つのexact windowから、新規観測された同一processのsuccessorをuniqueに証明できた場合だけauthorityをrotateでき、旧mutable targetはfence、ambiguityはfail closedです。physical iPhone acceptanceでは同じWebRTC sessionのまま `Accessibility -> 追加 (+) -> 開く` へrotateし、chooserがsame-PID focused `AXDialog` / modalかつWindowServer layer 8であることをlineage-only ruleでadmitしました。ordinary exact-one-windowはlayer 0 boundedのままです。Desktop authorityは#125の別escalationとして扱い、hidden fallbackにはしません。

### v0.2.0後のroadmap Issue map

#119のrelease gateはv0.2.0 tag / GitHub Releaseの検証後にclose済みです。#94も完了し、継続するdurable backlogには明示的なv0.3 Recovery & Observability milestoneも追加しました。

| Issue | Roadmap配置 | 現在の扱い |
| --- | --- | --- |
| #56 | v0.2.x media quality | **完了。** macOS Window専用 `window_text` でsourceをupscaleせず、bounded ceilingのみ≤1920×1080 / 5 Mbps / 30 fpsへ引き上げ、backpressure不変のままphysical iPhone direct + TURN relay acceptanceを通過。 |
| #34 | v0.2.x cross-platform parity | **完了。** Linux WebRTCでread-only AT-SPI helperをtarget process ancestry + exact-window geometryへbindし、boundedなeditable-region / focus hintだけを配信。accessible text / name / value、DOM / CDP / credentialは取得せず、accessibility unavailable / ambiguous時はempty / non-editableへfail closed。 |
| #127 | v0.3 durable recovery | **完了。** `HandoffCheckpointStore` を同期型provider-neutral contractとして導入し、load値はuntrustedのままHandoffがstrict再検証。signed-file store互換を維持し、recoveryは `reissue_and_revalidate` のみ。 |
| #128 | v0.3 audit | **完了。** 既存checkpoint/recovery event名を維持したstable v1 strict audit union、field/cardinality上限、256件memory reference sink、observe-onlyなsink failure semanticsを固定。 |
| #129 | v0.3 diagnostics | **完了。** Browser / Window / Terminalへidentifier-freeなstable v1 operator summaryを追加し、generic bounded health/failure categoryと `webrtc` / `terminal_session` / `terminal_webrtc` namespaceへ固有factを分離。既存詳細diagnosticsも互換維持。 |
| #130 | v0.3 restart conformance | **完了 / v0.3 recovery gate。** 全persisted lifecycle phase、Browser / Window旧locator/capability/generation/reconnect拒否、Terminal Human-active restart / PTY exit、checkpoint tamper/mismatch/expiry、write interruptionをdeterministic first-class testでcoverageし、stale authority / Human input replayなしを固定。 |
| #125 | v0.4+ Desktop authority | #124で安全に表現できないworkflow向けに、明示的Human-only Desktop Handoff escalationを設計。Windowからのsilent fallbackは禁止。 |
| #19 | v0.4+ transport maturity | 既存Cloudflare/coturn seamを土台に、Handoff-owned provider-neutral relay/connectivity設定を仕上げる。 |
| #12 | v0.4+ hosted topology | bounded durable stateとoutbound worker connectivityを持つprovider-neutral hosted control plane + stateful worker topologyを定義。 |

## 基本原則

1. **標準を優先する。** MCP-nativeなMRTR、Elicitation、Tasksなどを優先し、同じ意味を持つ独自protocolを安易に増やさない。
2. **利便性よりsecurity invariantを優先する。** principal/invocation binding、epoch fencing、authority排他、限定されたcheckpoint、capability lifetime、one-client lease、replay restrictionはcompatibility requirementとして扱う。
3. **generic contractをconsumer policyより小さく保つ。** domain detection、provider policy、postcondition verification、native execution、重大操作のapprovalはconsumer責務に残す。
4. **実consumerで抽象化を証明する。** synthetic exampleだけを根拠に新しいpublic abstractionを固定しない。
5. **handoffはapprovalではない。** Human completionが別の重大操作を暗黙に承認することはない。
6. **Browser Handoffはoptionalのままにする。** Browser Target SurfaceやBrowser固有transportがなくてもcoreが成立する状態を維持する。
7. **bypass productにしない。** CAPTCHA solving、anti-bot evasion、credential relay、stealth/fingerprint spoofing、payment automationは明示的な非目標として維持する。

## v0.1.x — historical maintenance line

対象:

- bug / security fix
- 現在のcontractを維持するspec alignment fix
- docs / diagnostics改善。#42でresponsibility-boundary positioning baselineは確立済み
- Maps / Japan Cinemaで見つかったregression coverage
- Target Surface内部をrefactorしている間もcross-platform portability gateとreal-browser acceptanceを維持
- pre-1.0で避けられないbreaking fixがある場合のmigration note

完了条件: documented security invariantを維持し、既存の2実consumerでgreenであること。

## v0.3.0 source release

`v0.3.0` が現在の **GitHub source release** です。完了したv0.3 Recovery / Observability contractをsource baselineへ昇格し、v0.2.0後にmergeしたsecure-system Window admission、same-process successor-window lineage、Window media quality、Linux editable-region parity、現行Cloudflare TURN credential contractも含みます。

releaseはmilestone `v0.3.0 — Source Release` とIssue #145で追跡します。v0.3.x maintenanceの #141〜#144 は明示的にnon-blockingで、このtagとは分離します。npm publicationも別gateのままで、`private: true` を維持します。

repeatableなsource-release checklistとnpm publicationとの分離は [リリース手順](RELEASING.ja.md) を参照してください。

## v0.2.0 source release

`v0.2.0` は以前の **GitHub source release** です。`v0.1.0` 以降、first-class Browser / Window / Terminal componentとWindow/Terminal package subpathまでpublic surfaceが本質的に拡張したため、pre-1.0 minor boundaryとして扱います。

releaseはmilestone `v0.2.0 — Source Release` とIssue #119で追跡し、tag / GitHub Release検証後にclose済みです。#124 / #56 / #34で直近のv0.2.x bounded-hardening setは完了です。専用milestone `v0.3 — Recovery & Observability` は #127〜#130、#125 / #19 / #12は後続のauthority / transport / deployment maturityです。npm publicationは明示的に別gateで、`private: true` を維持します。

repeatableなsource-release checklistとnpm publicationとの分離は [リリース手順](RELEASING.ja.md) を参照してください。

## v0.2 — Target Surface contractとbounded host hardening

現在のscopeとcloseout:

- Browser / Window / Terminalをfirst-class consumer-facing componentとして維持し、異なるmedia/stream mechanicsをprematureなgeneric surface interfaceへ無理に押し込めない
- #85で完了したsame-LAN directとpublic Tunnel/TURN relayの両physical Window evidence、およびstale locator拒否を維持する
- #94の完了evidenceを維持する。exact-window Human-only macOS inputでテスト対象secure System Settings controlが通り、privileged / desktop fallbackは不要
- #124の完了evidenceを維持する。exact-oneをdefaultのまま、opt-in same-process lineageは旧targetをfenceしてuniqueに証明したsuccessorだけへrotateする。physical iPhoneの `Accessibility -> 追加 (+) -> 開く` はdesktop/display fallbackなしで通過済み
- #125は#124で安全に表現できないworkflowのevidenceが出た場合に備えた、別の明示的Human-only Desktop authority investigationとして維持する
- #56の完了evidenceを維持する。Browser compatibilityは≤1280×720 / 3 Mbpsのまま、macOS Windowのみno-upscale ≤1920×1080 / 5 Mbps、newest-frame backpressure不変でphysical iPhone direct / TURN relayを通過済み。#34もread-only AT-SPIをprocess/window geometryへbindし、bounded editable/focus metadataだけを扱い、DOM / CDP / credential露出なしでLinux parityを完了
- CUMGを `WindowHandoffAdapter` / `TerminalHandoffAdapter` 利用へ固定し、canonical authority/session/transport orderingはHandoff、authorization / PTY-process containment / quarantine / semantic verificationはCUMGに残す
- authority / epoch / ownership / resume policy / request-state binding / stale surface-session fencingのcompatibility fixtureをformalizeする
- #5でdocumentしたMCP principalとtarget-service identityの境界を維持し、Handoffをservice-account attestation APIにはしない
- #46のsemantic-domain / Target Surface admission decisionをarchitecture baselineとし、v0.2ではHuman Interaction Policyへcanonical name + compatibility aliasを追加しつつTarget Surfaceはdocumentation-firstに維持する。3adapterが存在するだけではpublic enumを要件にしない

Target Surface admissionは引き続きevidence-basedです。provenな Browser / bounded OS Window / bounded Terminal-PTY shapeと比べて、authority boundary、capture/input model、lifecycle、postcondition handlingが本質的に異なる場合だけ新shapeとして認めます。別app・別OS・別device・別transport・別deploymentというだけでは追加理由にしません。

完了条件:

- Browser / Window / Terminal componentがdeterministic testとreal consumer integrationでgreenを維持
- first-class Window adapterでexact targetに対する Agent → Human → verifying → Agent を必要な両connectivity baselineで実証
- Terminal/PTYがshell/process runnerへ広がらずbounded session/stream componentのままで、real PTY / iPhone evidenceを再現可能
- CUMGがHandoff experimental internalsではなくfirst-class Window/Terminal componentだけへ依存
- #46をsemantic-domain / Target Surface admission baselineとして維持し、完了済みv0.2 terminology convergenceでcompatibilityとsecurity invariantを維持する
- 将来generic surface APIを追加する場合、target-specific mechanicsより小さいabstractionであるevidenceとcompatibility strategyを持つ

npm publicationは **v0.2の完了条件ではありません**。

## v0.3 — Recovery & Observability

milestone `v0.3 — Recovery & Observability` では、既存のsigned checkpoint、audit sink、bounded diagnostics、`reissue_and_revalidate` semanticsをproduction-gradeなoperator contractへ昇格します。**新しいTarget SurfaceやHuman-control authorityは追加しません。**

追跡Issue:

- #127 — **完了:** provider-neutral / synchronous / bounded checkpoint-store contract。signed-file storeをreference implementationとして維持し、load値はHandoff側で再検証
- #128 — **完了:** stable / privacy-bounded v1 execution audit contract、strict field bounds、bounded memory sink、observe-only sink failure semantics
- #129 — **完了:** Browser / Window / Terminal横断のidentifier-free stable v1 operator summary。target / transport固有factはnamespace分離し、既存詳細diagnosticsも維持
- #130 — **完了:** deterministic first-class crash/restart conformanceとrelease-level stale-authority gate

実装順は #127 を先に行い、共通data-classification boundaryが具体化した後に #128 / #129 を並行し、最後に #130 をconformance gateとして閉じます。

完了条件:

- generic durable schemaを広げずprovider-neutral checkpoint-store interfaceを導入
- raw action argument、Human input、PTY/browser/media content、credential/token、challenge answer、payment data、approval receipt、live transport capabilityをgeneric checkpoint/audit/diagnostics stateから構造的に除外
- audit eventにversioned / bounded / privacy-reviewed contractと明示的sink failure/backpressure behaviorがある
- operator diagnosticsは本当に共有できるstable categoryを提供し、transport/Target Surface固有detailはscope内、default retentionはprocess-memoryのまま
- Browser / Window / Terminalのrestart conformanceでstale Agent/Human authority、locator/capability、generation/reconnect handle、requestState、media/input session、PTY authorityが復元されない
- recoveryは `reissue_and_revalidate` を維持し、必要に応じてfresh consumer-owned target/session reconstructionを要求し、semantic verificationを省略しない

データ分類、restart state machine、実装順、non-goalは [Recovery / Observability boundary](docs/recovery-observability.ja.md) を参照してください。

## v0.4+ — MCP interoperabilityとtransport成熟

候補scope:

- MCP MRTR / Elicitation / Tasksの進化を追跡し、標準で置き換えられる独自plumbingを削減
- 実用上可能な範囲で複数MCP client/server implementationと検証
- first-class Browser / Window / Terminal component familyを維持し、consumerがlow-level broker / WebRTC / PTY-authority internalsを手組みせずbounded lifecycle / target semanticsへ依存できる状態を保つ
- capability / lease / origin / expiry / revocation / reconnect-handle rotation / client-generation fencingのtransport conformance test強化
- #19でprovider-neutral connectivity/relay boundaryを仕上げ、ICE/TURN/provider選択をconsumerへ露出しない
- #160でmanaged WSSのinteraction jankを計測・改善し、latest-frame backpressure / exact-window authority / privacy boundaryは弱めない
- #161でpersistent application/session stateとphysical / virtual / remote display attachmentを分離するDesktop Session / Display Backend boundaryを定義し、#125のbroader Desktop authorityより先にsession/display責務を固める
- #12でbounded durable stateとauthenticated outbound worker connectivityを持つhosted control-plane + stateful execution-worker topologyを定義する
- #13のcloseout decisionを維持する。historical Thin Takeover / mandatory custom Native-client umbrellaはaccepted WebRTC pathと完了済みWSS evaluationにsupersedeされ、将来native-clientが必要なら新しいnarrowなevidence-based Issueとして起こす
- #11のcloseout decisionを維持する。first-class bounded Windowと #94 secure UI / #124 successor-window lineage / #56 media qualityが旧full-desktop/provider-latency umbrellaをsupersedeする。#125で明示Desktop authorityを調査しても、desktop-wide controlはdefault Window boundary外のままにする
- 追加のlow-latency push/latest-frame / native Human Takeover pathは、現在のWebRTC/WSS acceptanceでは得られない新しいevidenceがある場合だけ検証する

### Transport familyの方向性

Human takeover transportはconsumerごとのforkにせず、同じbroker authority / lifecycle contractの背後で差し替え可能なsiblingとして維持します。想定するfamilyは次のとおりです。

- **Native** — 専用native operator client。性能・制御の上限は高いが、専用appのinstallが必要。
- **WebRTC** — browser向けlow-latency transportの主系統。到達可能ならdirect ICEを優先し、WAN/NATで必要な場合だけoptional TURN providerへfallbackする。TURNはinfraでありHandoff coreの必須要件にはしない。
- **WebSocket** — direct WebRTCの次に使うsupportedなHTTPS/WSS managed-runtime fallback。WSS legではTURNを必須にせず、既存のexact-window host helper、one-client lease、generation fencing、revoke、bounded latest-frame policyを再利用する。
- **HTTP streaming + bounded input request** — 必要ならcorrectness / deployability重視の簡易fallbackまたはdiagnostic pathとして検討する。性能上の本命にはしない。
- **WebTransport / HTTP/3** — deployment platformが適切なend-to-end pathを提供できるようになった場合の将来low-latency候補。core semanticsを変更せずoptional transportとして扱う。

ICE / SDP / RTP / DataChannel、WebSocket framing / backpressure、将来のWebTransport stream / datagramなどtransport固有mechanismはtransport実装内部へ閉じ込めます。consumerは下層network protocolではなく、locator / start / reconnect / revoke系のlifecycle semanticsへ依存し続けます。

Issue #40で初期WebSocket managed-runtime evaluationを完了し、physical iPhone SafariのWSS操作、bounded latest-frame/drop挙動、Cloud Run application reachabilityを確認しました。その後 #155 / #156で実証済みprimitiveをHandoff-owned Browser / Window managed fallbackへ昇格し、authority/session stackを二重化せず再利用しています。これはtransparentなsocket downgradeではなく、各transitionで旧transportをrevoke/fenceしてからfresh generation/capabilityへauthorityを移す明示的なtransitionです。

現在のsupported managed orderは `WebRTC direct -> WebSocket relay -> optional WebRTC/TURN relay` です。Browser / Window consumerは単一のHandoff lifecycle abstractionを使い続け、WebSocket / ICE / TURN providerを選択しません。stale direct-WebRTC / WSS generationはfail closed、transport間でadmit済みinputをreplayせず、disconnectはDoneを意味せず、fallback後もexact process/windowとHuman input policyは変わりません。#152はruntime revision `43d4624e16fb878260145767b4f2b6f103b3f822` でproduction-shaped Cloud Run `run.app` physical iPhone Safari gateをTURNなしで完了しました。direct-WebRTC unavailableから`websocket_relay`を選択し、tap / text / Backspace / scroll / Enter / semantic submit / Done、verification / teardown、stale direct / WSS locator・generation fencingまでPASSし、bounded verifierは `MANAGED_PHYSICAL_ACCEPTANCE_OK` を返しています。PR #157はaccepted runtimeと同期済みverifier/distを含み、CI gateは全greenです。目視できたWSS interaction jankはcorrectnessをblockしないfollow-up #160として分離しています。WebRTC direct / TURNとの同一session数値latency比較は未記録のため、`experiments/websocket-cloud-run/COMPARISON.md`では根拠のない数値性能主張を行いません。

具体的なworkが決まった時点でversionを割り当てます。必要なら `0.5`、`0.6`、`0.10` 以降も使用します。

## v1.0 — stable contract milestone

`v1.0` はsecurity / compatibility contractが成熟し、consumerが日常的なbreaking changeを心配せず依存できる状態を意味します。特定の日付、pre-1.0 release数、npm publicationには紐付けません。

最低限の完了条件:

- core authority / epoch / ownership / resume / checkpoint semanticsをstable contractとして文書化
- compatibility / migration policyを文書化し、実運用で確認済み
- 3つ以上の実consumerでgeneric boundaryを検証し、複数application domainを含む
- Target Surface boundaryをsynthetic exampleだけでなく実consumerで検証済み
- MCP標準との重複を再監査し、不要なprotocol duplicationがない
- Browser Handoffはoptionalのまま、Browser Target SurfaceとTransportをgeneric coreから分離する
- Human completionと重大操作のapprovalが分離されたまま
- automatic replayがconsumer policyで明示的に制限されたまま
- CI / cross-platform portability gate / Dependency Review / CodeQL / secret scanning / security reportingが運用中
- documented invariantを無効化する既知security issueが未解決でない

## npm publication gate

npm publishはdelivery decisionであり、maturity signalではありません。`v0.1.0` / `v0.2.0` / `v0.3.0` のようにsource releaseだけを成立させることもできます。

`private: false` へ変更、またはnpm publishする前に最低限次を確認します。

- package nameとpublic export surfaceをそのrelease向けに意図的に確定
- package installがsource consumerと同じchecked buildを再現
- provenance / release automation / least-privilege publishing credentialを設定
- publish artifactに意図したfileだけが入り、secret/private endpointを含まない
- public package APIへのSemVer impactを文書化
- exact package artifactを2つ以上の実consumerで検証
- rollback / deprecation procedureを文書化

npm初回公開versionは `0.1.x` / `0.2.0` / それ以降のどれでもよく、roadmapでは固定しません。

## 対象外

- CAPTCHA/challenge solving / bypass
- anti-bot evasion / stealth / fingerprint spoofing / proxy rotation
- credential / OTP / MFA / payment dataのMCP transport
- generic browser automation engine
- generic remote-desktop / device-wide computer-use infrastructure
- 重大操作のautomatic approval / replay
- generic coreへのprovider-specific policy

詳細は [位置づけ](docs/positioning.ja.md)、[アーキテクチャ](docs/architecture.ja.md)、[セキュリティポリシー](SECURITY.ja.md) を参照してください。
