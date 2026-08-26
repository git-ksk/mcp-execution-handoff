# ロードマップ

[English](ROADMAP.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

このロードマップはリリース日程ではなく、プロダクトと公開contractの方向性、および各milestoneの完了条件を示します。必要に応じてpre-1.0 versionを追加します。`0.9` の次が必ず `1.0` である必要もありません。

## 現在のbaseline: v0.1.0

`v0.1.0` は最初のsource releaseです。次の2つの実consumerで検証したうえで、このrepositoryをupstream source of truthとして確立しました。

- `git-ksk/maps-browser-mcp`
- `git-ksk/japan-cinema-browser-mcp`

npm packageは引き続き `private: true` です。npmへの公開はroadmap上の必須条件ではなく、後述のpublication gateで独立して判断します。

### 現在の作業状態 — 2026-08-25

v0.1.0以降の検証では、実consumer evidenceに基づくconsumer-facing Handoff componentが3本まで揃いました。ただし最終的なTarget Surface用語は #45/#46 がcloseするまで意図的に固定しません。

- `BrowserHandoffAdapter` は #70 で完了し、canonicalなhigh-level Browser WebRTC compositionです。
- `WindowHandoffAdapter` は実装済みで、CUMGもconsumer-localな `TakeoverBroker` / runtime手組みから移行済みです。merged codeでiPhone + Cloudflare Tunnel/TURN acceptanceとstale locator拒否まで通過しています。#85に残るのはfirst-class adapterでのsame-LAN direct再Acceptanceだけです。
- `TerminalHandoffAdapter` は #86 で完了しました。CUMGはexperimental PTY authorityとTerminal WebRTC transportを別々にcomposeせず、first-class adapterだけを利用します。merged-code real PTY cross-repo E2Eとphysical iPhone Human acceptanceも通過済みです。
- #47でmacOS/Linuxのbounded exact-window primitiveを整理し、whole-desktop fallbackを追加せず共通化しました。
- #48でbounded Terminal/PTY semanticsを実dogfoodし、staged Agent/Human drain fence、explicit resume、post-Human state sync必須化、Human期間outputをAgentへreplayしない境界を確立しました。
- CUMGはWindowとTerminalの両方でprovenなnon-browser consumerです。

したがって、実証済みの **surface shape** は Browser、bounded OS Window、bounded Terminal/PTY の3つです。ただしこれはpublic `TargetSurfaceKind` enumや最終命名をfreezeしたという意味ではありません。#46でsemantic admission criteriaを整理し、#85の残るdirect evidenceを閉じた後に #45でterminology/public APIを収束します。

既知follow-upは限定的です。#85はfirst-class Windowのsame-LAN direct physical rerun、#91はbackend lifecycleが正常完了していてもSafari上で「Connecting」に見え続ける可能性があるTerminal mobile UI/status ambiguityを追跡します。いずれもauthority / epoch / replay / privacy boundaryを弱める課題ではありません。

## 基本原則

1. **標準を優先する。** MCP-nativeなMRTR、Elicitation、Tasksなどを優先し、同じ意味を持つ独自protocolを安易に増やさない。
2. **利便性よりsecurity invariantを優先する。** principal/invocation binding、epoch fencing、authority排他、限定されたcheckpoint、capability lifetime、one-client lease、replay restrictionはcompatibility requirementとして扱う。
3. **generic contractをconsumer policyより小さく保つ。** domain detection、provider policy、postcondition verification、native execution、重大操作のapprovalはconsumer責務に残す。
4. **実consumerで抽象化を証明する。** synthetic exampleだけを根拠に新しいpublic abstractionを固定しない。
5. **handoffはapprovalではない。** Human completionが別の重大操作を暗黙に承認することはない。
6. **browser takeoverはoptionalのままにする。** browser transportがなくてもcoreが成立する状態を維持する。
7. **bypass productにしない。** CAPTCHA solving、anti-bot evasion、credential relay、stealth/fingerprint spoofing、payment automationは明示的な非目標として維持する。

## v0.1.x — 現在のbaselineを固める

対象:

- bug / security fix
- 現在のcontractを維持するspec alignment fix
- docs / diagnostics改善
- Maps / Japan Cinemaで見つかったregression coverage
- Target Surface内部をrefactorしている間もcross-platform portability gateとreal-browser acceptanceを維持
- pre-1.0で避けられないbreaking fixがある場合のmigration note

完了条件: documented security invariantを維持し、既存の2実consumerでgreenであること。

## v0.2 — 3つ目のconsumerとTarget Surface contractを検証

現在のscopeとcloseout:

- Browser / Window / Terminalをfirst-class consumer-facing componentとして維持し、異なるmedia/stream mechanicsをprematureなgeneric surface interfaceへ無理に押し込めない
- #85のmerged-code same-LAN direct Window acceptanceを完了し、すでに通過済みのpublic Tunnel/TURN physical evidenceも維持する
- CUMGを `WindowHandoffAdapter` / `TerminalHandoffAdapter` 利用へ固定し、canonical authority/session/transport orderingはHandoff、authorization / PTY-process containment / quarantine / semantic verificationはCUMGに残す
- authority / epoch / ownership / resume policy / request-state binding / stale surface-session fencingのcompatibility fixtureをformalizeする
- #46/#45でstable terminologyとpublic Target Surface discriminatorが本当に必要かを決める。3adapterが存在するだけではpublic enumを要件にしない

Target Surface admissionは引き続きevidence-basedです。provenな Browser / bounded OS Window / bounded Terminal-PTY shapeと比べて、authority boundary、capture/input model、lifecycle、postcondition handlingが本質的に異なる場合だけ新shapeとして認めます。別app・別OS・別device・別transport・別deploymentというだけでは追加理由にしません。

完了条件:

- Browser / Window / Terminal componentがdeterministic testとreal consumer integrationでgreenを維持
- first-class Window adapterでexact targetに対する Agent → Human → verifying → Agent を必要な両connectivity baselineで実証
- Terminal/PTYがshell/process runnerへ広がらずbounded session/stream componentのままで、real PTY / iPhone evidenceを再現可能
- CUMGがHandoff experimental internalsではなくfirst-class Window/Terminal componentだけへ依存
- #46/#45でsemantic-domain / terminologyの最終判断を文書化し、security invariantを弱めない
- 将来generic surface APIを追加する場合、target-specific mechanicsより小さいabstractionであるevidenceとcompatibility strategyを持つ

npm publicationは **v0.2の完了条件ではありません**。

## v0.3 — 永続化とobservabilityの境界

候補scope:

- control-plane metadataだけを保存する制約を維持したpluggable durable-checkpoint storage interfaceの検討
- sensitive execution contentをlogせず統合できるaudit / observability hookの整理
- operator / test向けevent / diagnostic shapeの安定化
- crash / restart conformance coverageの強化

完了条件:

- generic API経由でraw action arguments、credential、browser content、challenge answer、payment dataを永続化できない
- recoveryはstale execution authority復元ではなく `reissue_and_revalidate` を維持する
- observability追加が新しいsecret/content exfiltration pathを作らない

## v0.4+ — MCP interoperabilityとtransport成熟

候補scope:

- MCP MRTR / Elicitation / Tasksの進化を追跡し、標準で置き換えられる独自plumbingを削減
- 実用上可能な範囲で複数MCP client/server implementationと検証
- first-class Browser / Window / Terminal component familyを維持し、consumerがlow-level broker / WebRTC / PTY-authority internalsを手組みせずbounded lifecycle / target semanticsへ依存できる状態を保つ
- capability / lease / origin / expiry / revocation / reconnect-handle rotation / client-generation fencingのtransport conformance test強化
- generic remote-desktop productへ広げず、low-latency push/latest-frame transportとminimal native Human Takeover reference clientを検証

### Transport familyの方向性

Human takeover transportはconsumerごとのforkにせず、同じbroker authority / lifecycle contractの背後で差し替え可能なsiblingとして維持します。想定するfamilyは次のとおりです。

- **Native** — 専用native operator client。性能・制御の上限は高いが、専用appのinstallが必要。
- **WebRTC** — browser向けlow-latency transportの主系統。到達可能ならdirect ICEを優先し、WAN/NATで必要な場合だけoptional TURN providerへfallbackする。TURNはinfraでありHandoff coreの必須要件にはしない。
- **WebSocket** — TURNを不要にできるHTTPS-only managed-runtime path（Cloud Runのようなdeploymentを含む）の第一候補。既存のexact-window host helper、one-client lease、generation fencing、revoke、bounded latest-frame policyを再利用する。
- **HTTP streaming + bounded input request** — 必要ならcorrectness / deployability重視の簡易fallbackまたはdiagnostic pathとして検討する。性能上の本命にはしない。
- **WebTransport / HTTP/3** — deployment platformが適切なend-to-end pathを提供できるようになった場合の将来low-latency候補。core semanticsを変更せずoptional transportとして扱う。

ICE / SDP / RTP / DataChannel、WebSocket framing / backpressure、将来のWebTransport stream / datagramなどtransport固有mechanismはtransport実装内部へ閉じ込めます。consumerは下層network protocolではなく、locator / start / reconnect / revoke系のlifecycle semanticsへ依存し続けます。

WebSocket experimentの主なacceptance questionは、HTTPS-only managed runtimeだけでphysical mobile Human takeoverが実用になり、かつTCP/video backlogをboundedに保てるかです。slow clientでもmemoryをboundedにしlatest-frame/drop semanticsを維持し、reconnectではstale authorityを復活させず必ずgenerationをrotateします。このworkはIssue #40で追跡します。

現在のexperimental sequenceではphysical Acceptance完了までAPIをprivateに保ちます。bounded channel coreとHandoff-owned Node HTTPS/WSS ingressは、brokerと同じ`TakeoverSessionManager`へprivateに結線済みです。WSSには明示的なroute markerを持たせ、同一live locatorをlegacy HTTP / Native / WebRTCからclaimできないようにし、broker revokeではWSS channelも閉じ、Human Doneでは既存completion hookより先にshared generationをfenceします。privateなGeneric Window compositionではexact process/window targetをserver側だけに保持し、frame/inputはexact-window host-helper surfaceだけへ渡し、認証済みWSS clientがactiveになる前はcaptureせず、exact capture revalidation失敗時はsessionをrevokeします。privateなGeneric Browser compositionではprincipal-boundなHandoff-owned WSS pageを提供し、bounded JPEG/PNG frameとtap/scroll/text/key/Doneだけを扱い、target process/window identityやtransport selectionをconsumerへ露出しません。real Linux exact-window helperを使うphysical iPhone Safari WSS AcceptanceはHTTPS/WSS public Tunnel経由で通過し、tap/text/scroll/submit/Doneはcontent-freeなserver-side evidenceでも確認済みです。slow-clientは10,000 frame backlog stressでlatest-frame/drop semanticsを固定しています。同じacceptance imageはCloud Run内でもhealthyです。初期にはGoogle Frontend 404がありましたが、その後 `asia-northeast1` のpublic routeはphysical iPhone Safariからacceptance applicationまで到達し、そこで返った `takeover_unavailable` からacceptance専用のstale locator再利用bugを特定しました。このbugは `/start` ごとにfresh locatorへrotateし、`old locator -> 404` / `fresh locator -> 200` を保証する修正で解消済みです。Cloud Runで2回目のHuman操作一式は再実施せず、physical action evidenceは既に通過したiPhone HTTPS/WSS run、Cloud Run evidenceはapplication reachabilityとdeterministic fresh-locator/container acceptanceとして区別して記録します。証拠取得後、temporary Cloud Run acceptance serviceは削除しました。WebRTC direct / TURNとの同一session数値latency比較は保存されていないため、`experiments/websocket-cloud-run/COMPARISON.md`では根拠のない数値性能主張を行わずoperational comparisonを記録します。WebRTCからWebSocketへのautomatic downgradeは行いません。

具体的なworkが決まった時点でversionを割り当てます。必要なら `0.5`、`0.6`、`0.10` 以降も使用します。

## v1.0 — stable contract milestone

`v1.0` はsecurity / compatibility contractが成熟し、consumerが日常的なbreaking changeを心配せず依存できる状態を意味します。特定の日付、pre-1.0 release数、npm publicationには紐付けません。

最低限の完了条件:

- core authority / epoch / ownership / resume / checkpoint semanticsをstable contractとして文書化
- compatibility / migration policyを文書化し、実運用で確認済み
- 3つ以上の実consumerでgeneric boundaryを検証し、複数application domainを含む
- Target Surface boundaryをsynthetic exampleだけでなく実consumerで検証済み
- MCP標準との重複を再監査し、不要なprotocol duplicationがない
- browser takeoverがoptional / transport-onlyのまま
- Human completionと重大操作のapprovalが分離されたまま
- automatic replayがconsumer policyで明示的に制限されたまま
- CI / cross-platform portability gate / Dependency Review / CodeQL / secret scanning / security reportingが運用中
- documented invariantを無効化する既知security issueが未解決でない

## npm publication gate

npm publishはdelivery decisionであり、maturity signalではありません。`v0.1.0` のようにsource releaseだけを成立させることもできます。

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
