# ロードマップ

[English](ROADMAP.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

このロードマップはリリース日程ではなく、プロダクトと公開contractの方向性、および各milestoneの完了条件を示します。必要に応じてpre-1.0 versionを追加します。`0.9` の次が必ず `1.0` である必要もありません。

## 現在のbaseline: v0.4.4

`v0.4.4` が現在のGitHub/source-release baselineです。v0.4.3のpublic-WSS correctness boundaryを維持しつつ、Immediate Hardeningを完了しました。deterministic immutable consumer refresh/staging (#237)、first-valid-frame startupの分離計測とpresentation改善 (#233)、bounded backpressure diagnosticsを伴うhealthy-path 50 ms WSS frame pump (#234)、純正キーボードとSimejiのphysical acceptanceを含むthird-party iOS keyboard replacement-stream互換 (#244)、cadence acceptance中に見つかったstatic-window reconnect blocker (#250) を完了しています。Target Surface、Desktop authority、OS support、transport provider、Browser/Terminal semantics、virtual/remote backend、physical dynamic resizeのscopeは広げません。

npm packageは引き続き `private: true` です。npmへの公開はroadmap上の必須条件ではなく、後述のpublication gateで独立して判断します。

### 現在の作業状態 — 2026-09-04

v0.1.0以降の検証では、実consumer evidenceに基づくconsumer-facing Handoff componentが3本まで揃いました。semantic-domain / Target Surface admission contractは #46でdocument済みで、v0.2 terminology convergenceでは `TargetSurfaceKind` enumをfreezeせずHuman Interaction Policyへcanonical aliasを追加します。

- `BrowserHandoffAdapter` は #70で完成し、canonicalなhigh-level Browser WebRTC compositionです。Human側のBrowser `Done` は #84で即時one-shot化されました。
- `WindowHandoffAdapter` は #85で完成し、CUMGもconsumer-localな `TakeoverBroker` / runtime手組みから移行済みです。merged codeのphysical iPhone acceptanceでは、public Tunnel/TURN relayとsame-LAN directの両方を通過し、stale locator拒否も確認済みです。
- `TerminalHandoffAdapter` は #86で完成しました。CUMGはexperimental PTY authorityとTerminal WebRTC transportの個別compositionをやめ、merged-code real PTY cross-repo E2Eとphysical iPhone Human acceptanceも通過済みです。mobileのconnection / Human authority / verifying表示は #91で明示的かつfail-closedになりました。
- Safari suspend/disconnect後のBrowser WebRTC reconnectは #104でdeterministic化しました。generation releaseをsingle-flight化し、重複lifecycle eventを1本のreconnectへ集約し、active-lease conflictをboundedに観測できます。same-LAN iPhoneのphysical runではbackground/foregroundを3回連続で復帰し、409 loopやblack-frame固定は発生しませんでした。Safari appの完全終了はimplicit lease reclaimを行わず、fresh authorized flowを要求します。
- #40のHTTPS/WSS managed-runtime evaluationは、#152 / #155 / #156でHandoff-ownedなBrowser / Window fallback `WebRTC direct -> WebSocket relay -> optional WebRTC/TURN relay` へ昇格しました。TURNなしのproduction-shaped Cloud Run `run.app`でphysical iPhone Safari acceptanceまでPASSし、bounded Human input、Done、verification/teardown、stale direct/WSS fencingを確認済みです。Maps consumer adoptionは `git-ksk/maps-browser-mcp#147` で別追跡します。
- macOS managed Window/WSS系はv0.4.0 boundaryまで完了しました。#183でreusableなexact-window WSS surfaceとphysical iPhone Safari LocalAuthentication Cancel / benign Approve acceptanceを完了し、#185でmanaged exact-window transport compositionをOS-neutral化、#186でbounded same-process successor-window lineage parity、#184でTarget Surface × OS × transport support matrix / acceptance evidence index / content-free failure・auth-UX conformance gateを完了しました。
- #188でWebRTC/WSS横断のmobile input normalizationを完了し、#143/#210で残っていたmobile composition / precision parityも完了しました。日本語IME replacement、explicit software-keyboard persistence、Backspace/Enter、generated-client syntax gate、physical iPhoneのscroll方向、client-local WSS Aim / precise Tapまでserver authorityを広げず再検証済みです。System Settings authorization-to-successorの別authority investigationは#211へ分離しています。
- #47でmacOS/Linuxのbounded exact-window primitiveを再利用可能にし、whole-desktop fallbackは追加していません。
- #48でbounded Terminal/PTY semantic dogfoodを完了し、Agent/Human staged drain fence、explicit resume、post-Human state sync必須化、Human期間outputのAgent replay禁止を確立しました。
- CUMGはWindowとTerminalの両方で実証済みnon-browser consumerです。

したがって、実証済みの **surface shape** は Browser、bounded OS Window、bounded Terminal/PTY の3つです。ただしこれはpublic `TargetSurfaceKind` enumをfreezeしたという意味ではありません。#46をsemantic-domain / admission baselineとして維持し、v0.2 terminology gateはpolicy軸のcompatibility aliasとdocumentation-firstなTarget Surface labelで完了します。

#42（positioning）、#46（semantic domain / Target Surface admission）、#5（MCP principalとtarget-service identity分離）のdocumentation/design closeoutは完了しました。historical umbrellaの #11 / #13 もsupersededとしてclose済みです。supportするworkはfirst-class bounded Window / WebRTC / WSS evidence、v0.2.x bounded hardening（#124 / #56 / #34完了）、v0.3 recovery / observability（#127〜#130）、post-release v0.3.x maintenance、完了したv0.4.1 Desktop Session boundary (#161)、完了したv0.4.2 expiry maintenance (#226)、完了したv0.4.3 public-WSS correctness line (#232/#235/#240)、v0.4.4 Immediate Hardening release line (#233/#234/#237/#244)、具体化したv0.5.0 connectivity line (#19)、その後のv0.6.0 hosted line (#12)、version未確定のauthority research (#211/#125)へ分離しました。whole-desktopやmandatoryなcustom Native-clientをdefault product scopeには残しません。

#94と#124は完了です。#94では既存のexact-window stateful macOS pointer backendでテスト対象のSystem Settings secure controlを操作でき、privilegedなScreen Sharing / Remote Management fallbackが不要だと確認しました。#124では続いて、明示opt-inのsuccessor-window lineageを追加しました。Human sessionは1つのexact windowから、新規観測された同一processのsuccessorをuniqueに証明できた場合だけauthorityをrotateでき、旧mutable targetはfence、ambiguityはfail closedです。physical iPhone acceptanceでは同じWebRTC sessionのまま `Accessibility -> 追加 (+) -> 開く` へrotateし、chooserがsame-PID focused `AXDialog` / modalかつWindowServer layer 8であることをlineage-only ruleでadmitしました。ordinary exact-one-windowはlayer 0 boundedのままです。現在は#211をnarrow bounded secure-flow researchとして先行し、bounded authority不足がphysical evidenceで証明された場合だけ#125 broader Desktop authorityを検討します。hidden fallbackにはしません。

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
| #172 | v0.3.x recoverable WSS input | **完了。** recoverable helper/ACK failureではbound useだけを終了しvalid WSS sessionを維持、`dispatch_rejected`を返してfailed Human inputをreplayせず、exact authority lossでは従来どおりrevoke。 |
| #143 | v0.3.x mobile composition | **完了。** explicit user-gesture keyboard/compositionをmobile WebRTC/WSSでfirst-class化し、credential/content inspectionは追加しない。 |
| #150 | v0.3.x lifecycle presentation | **完了。** physical LocalAuthentication OK / Cancelでstale frame消去、input fence、neutralな `Verifying…`、consumer verification後だけterminal successを確認。 |
| #188 | v0.3.x mobile input normalization | **完了。** WebRTC/WSSでIME/keyboard/gesture semanticsを統一し、physical iPhoneでWebRTC scroll方向のdriftも検出・修正。 |
| #189 | v0.3.x auth UX feedback | **完了。** credential brokerやTarget Surface authority拡大なしで責務境界とsynthetic no-secret auth lifecycle conformanceを固定。 |
| #210 | v0.3.x WSS mobile-control parity | **完了。** WSS client-local Aim / pan / zoomをphysical acceptanceし、explicit mapped Tapだけがremote inputを出す。server authorityは不変。 |
| #183 | v0.4 macOS WSS surface | **完了。** ordinary WindowとLocalAuthentication Cancel / benign Approveでreusable macOS exact-window WSS-onlyをphysical acceptance。WebRTC/ICE/STUN/TURNやdesktop fallbackは構築しない。 |
| #184 | v0.4 component baseline | **完了。** executable support/acceptance matrixとP0 failure-injection/auth-UX gateをchecked-inし、unsupported combinationをexplicit/fail-closedに固定。 |
| #185 | v0.4 managed composition | **完了。** managed exact-window transport compositionをOS-neutral化し、consumerからLinux/macOS concrete WSS construction選択を除去。 |
| #186 | v0.4 WSS successor lineage | **完了。** physical iPhone Safariでbounded same-process successor rotation、stale-generation fencingを実証。 |
| #211 | Authority Research — Bounded Secure Flow | **OPEN。** System Settings authorization → independently admitted successorをnarrowに検証。generic secure-UI / desktop fallbackは禁止。 |
| #161 | v0.4.1 Desktop Session / Display Backend | **完了 / v0.4.1 boundary。** internalなWindow-only physical backend boundaryでpersistent session/display continuityとviewer/transport generationを分離。viewer scalingとphysical display resizeを別能力にし、後者はunsupported。Desktop authority / public subpath / virtual・remote backendは追加しない。 |
| #226 | v0.4.2 maintenance | **完了 / v0.4.2 gate。** expired credential-safe Human surfaceをfenceし、matching stale retryは明示fail、fresh issuanceは別の `begin()` を必須とし、Human input / authorityをreplay・復活させない。 |
| #232 | v0.4.3 public WSS reliability | **完了 / v0.4.3。** physical iPhone Safari managed-WSSの純正キーボードで日本語IME replacement、通常文字、Backspace、Enter 1回=改行1回、scroll、DoneまでHuman textをlogせずacceptance済み。 |
| #235 | v0.4.3 public WSS reliability | **完了 / v0.4.3へcarry。** bodyless authorized `HEAD` takeover probeを維持し、managed client patchingをGET-onlyのままにする。 |
| #240 | v0.4.3 public WSS reliability | **完了 / v0.4.3 gate。** public HTTPS gateway probe、GET、bootstrap、WSS upgrade、first frame、benign input、Done、stale fencingをcommitted consumer-ready `dist` で一体検証済み。 |
| #233 | v0.4.4 Immediate Hardening | **完了 / v0.4.4。** startupをtransport ready、host first-valid-frame、Safari decode/presentationへ分離計測し、最初のvalidated macOS JPEGを再利用。physical iPhone startup acceptance済み。 |
| #234 | v0.4.4 Immediate Hardening | **完了 / v0.4.4。** healthy-path defaultを50 ms pumpへ改善し、single-flight/latest-frame-winsを維持。physical iPhone acceptance runではdropped frame 0 / backpressure 0。 |
| #237 | v0.4.4 Immediate Hardening | **完了 / v0.4.4 operational contract。** source-checkout / npm-archive consumerをdeterministicにrefresh/stageし、pin/lock不一致はfail closed、失敗時rollback、native-helper rebuild signalを提供。deploy/trafficはconsumer-ownedのまま。 |
| #244 | v0.4.4 Immediate Hardening | **完了 / v0.4.4。** shared WebRTC/WSS Browser input normalizationでthird-party `insertText` replacementを扱い、`keyCode=229`単独では正しさを推定しない。純正キーボード＋Simejiをphysical acceptance済み。 |
| #250 | v0.4.4 reconnect blocker | **完了 / v0.4.4。** fresh WSS generationではauthority-bound helperのlatest exact-window frameを即時再利用し、旧generationのnext-frame waitをcancel。静止画面でもcontent change待ちせずreconnect復帰する。 |
| #227 | Host Parity Backlog — Windows Browser | **OPEN / version未確定。** bounded Windows Browser Handoff parityの将来work。support claim前に専用Windows + mobile physical acceptanceを必須とする。 |
| #228 | Host Parity Backlog — Linux successor lineage | **OPEN / version未確定。** Linux-native successor-window lineage parityの将来work。現行Linux exact-window supportはblockしない。 |
| #125 | Authority Research — Desktop Escalation | #211または別physical workflowでbounded Window/successor authority不足が証明された場合だけbroader explicit Human-only Desktop Handoffを設計。Windowからのsilent fallbackは禁止。 |
| #19 | v0.5.0 provider-neutral connectivity | 既存Cloudflare/coturn seamを土台に、Handoff-owned provider-neutral relay/connectivity設定を仕上げる。 |
| #12 | v0.6.0 hosted topology | bounded durable stateとoutbound worker connectivityを持つprovider-neutral hosted control plane + stateful worker topologyを定義。 |

## Product Readiness — 独立したcross-cutting track

Product ReadinessはTransport/Hosted maturityやnpm publicationとは別軸です。現在のsource-release
JavaScript artifactはclean committed-`dist/` gate (#159)でconsumer-readyとなり、Target Surface / transport
support inventory、acceptance-evidence index、failure injection、synthetic auth-UX lifecycle gateは完了した#184配下でmachine-check済みです。release-significantなconsumer evidenceではexact consumer +
Handoff revisionを記録し、deterministic / consumer integration / physical component / physical dogfoodを区別します。

native helper deliveryは明示的なprovenance/integrity gateが整うまでsource/deployment-ownedです。macOS deploymentは
review済みSwift/Xcode build、persistent TCCに必要なstable code-sign identity、controlled device permissionを所有し、
Linux deploymentはpin済みOS/runtime dependency baselineと対応するexact-window acceptanceを所有します。将来prebuilt
binaryを配布する場合はsigning/notarizationまたはdistro/ABI/provenance/rollbackをproduct-ready claim前のgateにします。

upgrade/rollbackでstale locator/capability/generation/media/input authorityを復元しません。durable recoveryは
`reissue_and_revalidate` のままで、semantic verification/replay policyはconsumer-ownedです。#237は完了し、immutable consumer refresh/stagingをdeterministicに標準化しました。deploy、readiness、traffic switch、credential、consumer semanticsはHandoffへ移していません。次のplanned release workは #19 のprovider-neutral connectivity boundaryです。Human-visible lifecycle品質も
このtrackに含め、#150は完了済みです。physical OK / Cancel evidenceでexact target消失時にstale LocalAuthentication presentationを消去し、semantic successはconsumer-ownedのまま維持することを確認しました。

詳細は [Product Readiness / consumer compatibility](docs/product-readiness.ja.md) を参照してください。

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

## v0.4.2 source release

`v0.4.2` が現在の **GitHub source release** です。#226だけをrelease-significant scopeとするboundedなv0.4.x maintenance patchです。credential-safe external Human surfaceのdeclared expiryをcached surfaceのhard cutoffとして扱い、stale locatorをactiveとして返さず、already-expired provider grantもrejectし、fresh provider issuanceには別の明示 `begin()` を要求します。stale providerへのbest-effort cleanupでHuman intervention完了、Agent authority復帰、Human input replay、target-service authentication attestationは行いません。

releaseはmilestone `v0.4.2 — Maintenance` (#13) で追跡します。#227（Windows Browser Handoff parity）/ #228（Linux successor-window lineage parity）はversion未確定かつnon-blockingのままです。新しいTarget Surface、OS support claim、Desktop authority、transport provider claim、public package subpath、npm publicationは追加しません。

## v0.4.1 source release

`v0.4.1` は1つ前の **GitHub source release** です。compatibleなv0.4.x architecture patchとして、#161で既存Physical Window pathをinternal Desktop Session / Display Backend boundaryへ載せ、application/session continuity、physical display attachment、Human viewer attachment generation、transport/client generationを分離します。viewer disconnect/reconnectでapplication/Desktop Sessionを破棄せず、viewer scalingはphysical display resizeではなく、stale generation / retargetingはfail closed、Human inputはreplayせず、disconnectはDoneを意味せず、semantic successは引き続きconsumer verificationが確定します。

releaseはmilestone `v0.4.1 — Desktop Session Boundary` (#8) で追跡します。#220はWSS container acceptanceの全stepを維持したままjob timeoutだけを20分から40分へ延長します。Desktop authority、public package subpath、virtual/remote backend、Browser/Terminal semantic change、physical dynamic-resize supportは追加しません。npm publicationも別gateで、`private: true` を維持します。

repeatableなsource-release checklistとnpm publicationとの分離は [リリース手順](RELEASING.ja.md) を参照してください。

## v0.4.0 source release

`v0.4.0` は以前の **GitHub source release** です。v0.3 Recovery / Observability boundaryを維持し、post-v0.3のbounded transport/component workとしてmacOS exact-window WSS / LocalAuthentication WSS、Human inputをreplayしないmanaged recoverable WSS、mobile keyboard / Aim / scroll parity、executable Target Surface × OS × transport / auth-UX conformance、consumer verification中のstale secure-frame fencingをsource baselineへ昇格しました。

releaseはmilestone `v0.4.0 — Source Release` とIssue #213で追跡されました。当時はprovider-neutral relay/connectivity (#19)、hosted topology (#12)、Desktop Session / Display Backend (#161)、explicit Desktop authority (#125)、bounded System Settings successor investigation (#211)を後続workとして残しており、#161はauthorityを広げずv0.4.1で完了しました。npm publicationは別gateのままで、`private: true` を維持します。

repeatableなsource-release checklistとnpm publicationとの分離は [リリース手順](RELEASING.ja.md) を参照してください。

## v0.3.0 source release

`v0.3.0` は以前の **GitHub source release** です。完了したv0.3 Recovery / Observability contractをsource baselineへ昇格し、v0.2.0後にmergeしたsecure-system Window admission、same-process successor-window lineage、Window media quality、Linux editable-region parity、現行Cloudflare TURN credential contractも含みます。

releaseはmilestone `v0.3.0 — Source Release` とIssue #145で追跡されました。non-blockingな `v0.3.x — Maintenance & Durability` follow-upで進めたlifecycle/product UX、recoverable WSS、mobile input/composition、repository/package hardeningは現在v0.4.0 source boundaryへ取り込まれています。npm publicationは別gateのままで、`private: true` を維持します。

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
- #125は#211または同等のnarrow authority researchでbounded Window/successor authorityでは表現できない具体的workflowが証明された場合にだけ進める、別のexplicit Human-only Desktop authority investigationとして維持する
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

## v0.3.x — Maintenance & Durability

milestone `v0.3.x — Maintenance & Durability` は完了済みのv0.3後non-blocking maintenance lineです。2026-09-04時点でtracked Issue 8件はすべてclose済みです。v0.3.0のauthority / recovery contractを維持し、**暗黙にbroader Human-control authorityを追加せず、source release gateにもなりませんでした。**

v0.4.0へcarryしたrelease-significant maintenanceはすべて完了しました: recoverable WSS input (#172)、mobile keyboard/composition (#143)、stale LocalAuthentication presentation (#150)、auth-UX responsibility/conformance (#189)、WSS Aim / precise-tap parity (#210)。

完了済みmaintenanceにはさらにsigned-file durability (#141)、roadmap/worktree hygiene (#142/#144)、bounded initial LocalAuthentication admission (#147)、product-readiness / clean consumer-artifact gate (#151/#159)、managed WSS keyboard observability (#181)、cross-transport mobile input normalization (#188)があります。

このlineの完了discipline:

- 各変更で既存principal / epoch / lease / generation / Target Surface authority invariantを維持する;
- UX改善はHuman observability/interactionを改善してよいが、`Done`推定、Human input replay、credential/content露出、Window/Desktop authority拡大は行わない;
- deterministic testと必要なphysical acceptanceをclaim対象exact revisionへ紐づける;
- source release/taggingとnpm publicationは別decisionのまま維持する。

2026-09-05時点で `v0.3.x — Maintenance & Durability`、`v0.4.2 — Maintenance`、`v0.4.3 — Public WSS Reliability`、`v0.4.4 — Immediate Hardening` のrelease lineは完了済みです。OPENは6件で、`v0.5.0 — Provider-Neutral Connectivity` (#19)、`v0.6.0 — Hosted Worker Topology` (#12)、authority research 2件 (#211/#125)、version未確定host parity 2件 (#227/#228) に明示分類済みです。今後もIssue作成時にroadmap分類し、未所属のまま実装を進めない運用とします。

## v0.4.2 — Maintenance

`v0.4.2` は `v0.4.1` の次に置く完了済みbounded maintenance source releaseです。release-significant scopeは、Maps Browser MCPのdogfoodで見つかったcredential-safe external Human surface lifecycle bug #226だけに意図的に限定します。

目的は、expiredまたはprovider側でstaleになったcached Human surfaceをactiveとして再利用しないことです。authorityを広げず、transport roadmapも変更しません。

scope:

- #226 — **完了:** 既存intervention / epoch / principal / generation contractのままexpired credential-safe external surfaceをrejectし、fresh issuanceは別の明示callを要求する;
- no-replay、stale-authority fencing、target/window authority loss時のfail-closed、content-free diagnosticsを維持する;
- stale/expired provider surfaceに対するdeterministicなconsumer recovery behaviorを文書化する。

`v0.4.2` から明示的にdeferするもの:

- #227 — Windows Browser Handoff parityは将来のhost coverageとして有用だが、新しいphysical OS support claimを追加し、専用Windows + mobile acceptanceが必要なためpatch release gateにはしない。
- #228 — Linux successor-window lineage parityはLinux Window capabilityを広げ、Linux-native lineage evidenceとphysical acceptanceが必要なためpatch release gateにはしない。

完了条件:

- #226のdeterministic expiry/staleness coverageがexact release revisionでgreen;
- expired cached locatorをactiveとして返さず、Human input/authorityをreplay・復活させない;
- relevant consumer regression evidenceを紐づける;
- `v0.4.2` で新しいTarget Surface、OS support、Desktop authority、transport provider claimを追加しない;
- npm publicationは別decisionのまま維持する。

## v0.4.3 — Public WSS Reliability

`v0.4.3` は `v0.4.2` 直後の短期source-release lineとして完了しました。post-releaseのconsumer dogfoodで見つかったpublic managed-WSS correctness gapを、v0.5 connectivityへ進む前に上流で修正・gate化しています。milestone `v0.4.3 — Public WSS Reliability` は意図的に狭いままです。

release-significant scope:

- #235 — **完了・すでに `main`:** authorized bodyless HEAD takeover probeを維持し、GET-only client patchingを保つ。
- #240 — **完了:** public Linux/Cloud Run-equivalent WSS-onlyで HEAD -> GET -> bootstrap -> WSS -> first frame -> benign input -> Done -> stale fencing を1本のdeterministic gateにし、committed consumer-ready `dist` artifactで実行する。
- #232 — **完了:** physical iPhone Safari managed-WSSの日本語IME replacement regressionをshared/browser-input layerで修正し、Human textをlogせずphysical acceptanceを再実施する。

release結果として #235 / #240 / #232 はすべて完了しました。physical iPhone Safari managed-WSSでは、同一release lineageでAim、通常文字、Backspace、Enter 1回=改行1回、純正キーボードの日本語IME replacement、scroll、Doneまでacceptance済みです。このevidenceをthird-party iOS keyboardへ一般化せず、異なるreplacement streamは #244 で追跡します。

完了条件:

- #232 / #240がexact candidate revisionで完了し、#235相当regressionがcomposed public WSS gateで検知できる;
- physical iPhone Safari managed-WSSでnormal text、日本語composition replacement、Enter、Backspaceがgreen;
- public HEAD / GET / bootstrap / WSS lifecycleがdeterministicで、stale/wrong-principal pathはfail closed;
- Human-input replay、credential/content logging、authority拡大、hidden WebRTC insertion、新しいTarget Surface/OS claimを追加しない;
- source-release consumer artifact gateを維持し、npm publicationは別decisionのまま。

## v0.4.4 — Immediate Hardening

`v0.4.4` は `v0.4.3` の次、`v0.5.0` の前に置く完了済みbounded hardening source-release lineです。milestone `v0.4.4 — Immediate Hardening` はplanned 4件に加え、physical cadence acceptance中に見つかったreconnect correctness blocker 1件も完了しました。upgrade運用、WSS startup/steady-state品質、third-party iOS keyboard互換を改善しつつ、Target Surface、authority、transport provider、npm publicationのscopeは広げていません。

release結果:

1. #237 — **完了:** deterministic consumer refresh/stagingでdeclared immutable source/package identityを更新し、stale/mismatched pinはfail closed、lock refresh失敗はrollback、native-helper rebuildを明示signal。Maps Browser MCPのnpm-archive型とCUMGのsource-checkout型で実consumer staging evidenceを取得し、deploy/trafficはconsumer-ownedを維持。
2. #233 — **完了:** first-valid-frame startupをconnect→ready、host capture、Safari ready→first `img.onload`へcontent-freeに分離計測し、最初のvalidated macOS JPEGを捨てず初回frameへ再利用。physical iPhone Safari startup acceptance済み。
3. #234 — **完了:** Window WSS healthy pathをdefault 50 ms pumpへ改善し、single-flight/latest-frame-winsとbounded active backpressure diagnosticsを維持。physical iPhone acceptanceではdropped frame 0 / backpressure event 0。
4. #244 — **完了:** shared WebRTC/WSS Browser input normalizationでthird-party ordinary `insertText` replacement streamを扱い、`keyCode=229`をcorrectness根拠にしない。physical iPhone Safariで純正日本語キーボードとSimejiを同一verified runでacceptance済み。
5. #250 — **完了 blocker:** reconnectで旧generationのpending next-frame waitをcancelし、latest still-authoritative exact-window frameをfresh generationへ即時再利用。静止画面でもcontent mutationを待たず表示復帰する。

releaseは `private: true` のsource-onlyを維持し、npm publication、consumer deploy/readiness/traffic switchは別decisionのままです。

## Host Parity Backlog — version未確定

#227 / #228はroadmap上で分類済みworkとして維持しますが、具体的consumer needと必要なphysical acceptanceが揃ってreleaseへ載せる根拠ができるまでversion未確定とします。`v0.4.4` / `v0.5.0` / `v0.6.0` はblockしません。

## v0.5.0 — Provider-Neutral Connectivity

`v0.5.0` はboundedな `v0.4.4` hardening releaseの次に予定するfeature source release lineです。milestone `v0.5.0 — Provider-Neutral Connectivity` は意図的にscopeを絞り、#19が所有します。

目的は、WebRTC discovery / relay connectivityを **Handoff-ownedかつprovider-neutralなdeployment boundary** として確立することです。consumer-facing Browser / Window lifecycleは変えず、Human-control authorityも広げません。

scope:

- 既存ICE credential/provider seamをprovider-neutral connectivity / relay boundaryへ整理する;
- direct-first挙動とbrowser/server gathering policyをHandoff側で明示的に管理する;
- Cloudflare Realtime TURNをproduct abstractionではなく1つのprovider implementationとして扱う;
- consumer APIを変えずにcoturn / self-hosted providerを追加できる形にする;
- relay secret、provider選択、STUN/TURN詳細、candidate policyをMCP tool引数/結果、model context、consumer config、log、durable checkpointへ出さない;
- silentなcross-vendor failoverを禁止し、provider変更を明示的なdeployment/security decisionにする;
- identifier/content-freeなbounded connectivity diagnosticsだけを許可する;
- generation fencing、one-client ownership、revoke、Human-input non-replay、consumer-owned semantic verificationを維持する。

完了条件:

- #19 acceptance criteriaをexact release candidate revisionで完了する;
- established consumerからprovider選択logic / TURN credential handlingが消えている;
- direct-only / relay-enabledの両方がdeterministicで、provider failure時もfail closedを維持する;
- Cloudflareと少なくとも1つのprovider-neutral/self-hosted implementation shapeを同じHandoff-owned seamで実証する;
- hosted ingress/tunnelとWebRTC relay/TURNの責務分離を明文化する;
- relevant deterministic / consumer-integration / physical evidenceをexact candidate revisionへ紐づける;
- npm publicationは別decisionのままとし、独立gateを明示完了しない限り `private: true` を維持する。

## v0.6.0 — Hosted Worker Topology

`v0.6.0` はv0.5.0 connectivity boundaryの後に進めるhosted architecture lineです。milestone `v0.6.0 — Hosted Worker Topology` は#12が所有し、#19で確立したprovider-neutral connectivity contractを再定義せず利用します。

目的は、hosted Handoff/MCP control planeとstateful browser/desktop execution workerを分離しつつ、同じintervention / authority / reconnect / revoke / semantic-verification contractを維持することです。

scope:

- provider-neutral hosted control-plane + stateful execution-worker topologyを定義する;
- private/local workerへpublic inbound listenerを要求しないようauthenticated **outbound** worker connectivityを優先する;
- worker registration / intervention routingをauthenticated worker identity、principal、epoch、current generationへbindする;
- durable化するのはbounded control-plane metadataだけとし、frame、typed secret、credential、cookie、任意target contentは非durableのままにする;
- duplicate ownership、stale reconnect、worker liveness、reassignment、revocation propagation、latest-frame/backpressureをfail closedで定義する;
- persistent browser/profile/session storageをdisposable control-plane instanceから分離する;
- local-only、hosted-control-plane + local worker、hosted-control-plane + remote/stateful workerのreference shapeを文書化する。

完了条件:

- #12 acceptance directionがhosted-control-plane + local workerとhosted-control-plane + remote/stateful workerの両方で通る;
- reference topologyでworkerにpublic inbound listenerを要求しない;
- disconnect/reconnect後もepoch、one-client ownership、stale-generation fencingを維持する;
- Done/Cancel/expiryでrelayとlocal execution capabilityをAgent resume前にrevokeする;
- Human completion後もfresh Agent readiness/revalidationを必須にする;
- v0.6.0でimplicit Desktop authorityを追加せず、#125を前提条件にしない。

## Authority Research — version未確定

Authority拡張はv0.5.0 → v0.6.0のtransport/hosted release lineから意図的に分離します。ここはresearch / decision gateであり、release versionを予約しません。

### #211 — Bounded Secure Flow

milestone `Authority Research — Bounded Secure Flow` では、System Settings authorization → independently admitted successorというexact flowだけを狭く調査します。generic secure-UI authorityやDesktop fallbackを追加せず、bounded Window authorityのままproveまたはrejectすることを優先します。

- reviewed narrow extensionが必要と証明されない限り、既存LocalAuthentication / same-process successor-lineage contractを維持する;
- credential contentはtransientのままlog / checkpoint / model contextへ出さない;
- unknown / ambiguous / stale / Cancel / timeout / identity changeはfail closed;
- authorization成功後もindependently proven successorにだけ継続でき、arbitrary UIへは遷移しない;
- このresearchはv0.5.0 / v0.6.0をblockしない。

### #125 — Desktop Escalation

milestone `Authority Research — Desktop Escalation` はdesign / research gateのまま維持します。internal Desktop Session / Display Backend boundaryが存在することだけを理由に、broader Human-only Desktop Handoffをreleaseへ予定しません。

#211または別の具体的physical workflowで、重要なHuman workflowをbounded Window/successor authorityでは安全に表現できないと証明された場合だけdesignを越えて進めます。将来Desktop authorityを導入する場合も、explicit request、Human-only、display/session change時fail closed、Agent resume前revokeを必須とし、Window failureからのautomatic fallbackにはしません。

authority順序は **#161完了 → #211 narrow proof/rejection → concrete physical necessityがある場合だけ#125** です。

## v1.0までのinteroperability / transport方向

具体化済みv0.5.0 / v0.6.0の先では、次を継続します。

- MCP MRTR / Elicitation / Tasksなど標準の進化を追跡し、標準で置き換えられるproject-specific plumbingを削減する;
- 実用上可能な範囲で複数MCP client/server implementationと検証する;
- first-class Browser / Window / Terminal componentを維持し、consumerがlow-level transport internalsではなくbounded lifecycle/target semanticsへ依存できる状態を保つ;
- capability / lease / origin / expiry / revocation / reconnect-handle rotation / client-generation fencingのtransport conformanceを拡張する;
- historical #11 / #13 closeout decisionを維持し、whole-desktop controlやmandatory custom Native-client pathをdefault product scopeにしない;
- 追加のlow-latency / native / WebTransport pathは、現在のWebRTC/WSS acceptanceでは得られない新しいevidenceがある場合だけ検証する。

### Transport familyの方向性

Human takeover transportはconsumerごとのforkにせず、同じbroker authority / lifecycle contractの背後で差し替え可能なsiblingとして維持します。想定するfamilyは次のとおりです。

- **Native** — 専用native operator client。性能・制御の上限は高いが、専用appのinstallが必要。
- **WebRTC** — browser向けlow-latency transportの主系統。到達可能ならdirect ICEを優先し、WAN/NATで必要な場合だけoptional TURN providerへfallbackする。TURNはinfraでありHandoff coreの必須要件にはしない。
- **WebSocket** — supportedなHTTPS/WSS managed-runtime transport。historical acceptanceではdirect WebRTCの次に使ったが、現在のmanaged policyでは先頭・後段・単独のいずれにも配置できる。WSS legではTURNを必須にせず、既存exact-window host helper、one-client lease、generation fencing、revoke、bounded latest-frame policyを再利用する。
- **HTTP streaming + bounded input request** — 必要ならcorrectness / deployability重視の簡易fallbackまたはdiagnostic pathとして検討する。性能上の本命にはしない。
- **WebTransport / HTTP/3** — deployment platformが適切なend-to-end pathを提供できるようになった場合の将来low-latency候補。core semanticsを変更せずoptional transportとして扱う。

ICE / SDP / RTP / DataChannel、WebSocket framing / backpressure、将来のWebTransport stream / datagramなどtransport固有mechanismはtransport実装内部へ閉じ込めます。consumerは下層network protocolではなく、locator / start / reconnect / revoke系のlifecycle semanticsへ依存し続けます。

Issue #40で初期WebSocket managed-runtime evaluationを完了し、physical iPhone SafariのWSS操作、bounded latest-frame/drop挙動、Cloud Run application reachabilityを確認しました。その後 #155 / #156で実証済みprimitiveをHandoff-owned Browser / Window managed fallbackへ昇格し、authority/session stackを二重化せず再利用しています。各transitionでは旧transportをrevoke/fenceしてからfresh generation/capabilityへauthorityを移します。

productionで実証済みdefaultは `WebRTC direct -> WebSocket relay -> optional relay-capable WebRTC` のままです。managed Browser / Window compositionはtransport選択をexactな有限ordered policyとして表現し、stale direct-WebRTC / WSS generationはfail closed、admit済みinputはtransport間でreplayせず、disconnectはDoneを意味せず、fallback後もexact process/windowとHuman input policyを維持します。#152をproduction-shaped Cloud Run physical evidence baselineとして保持し、`experiments/websocket-cloud-run/COMPARISON.md`では未計測の数値latency claimを行いません。

v0.7 / v0.8 / v0.10など後続pre-1.0 versionはevidence-drivenに決めます。具体的なcompatibility / maturity boundaryが存在するときだけversionを追加し、番号を埋めるためには予約しません。

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
