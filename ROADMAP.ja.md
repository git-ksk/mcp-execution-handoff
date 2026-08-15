# Roadmap（日本語）

[English](ROADMAP.md)

このroadmapはrelease日程ではなく、product / contractの方向性とexit criteriaを定義します。必要ならpre-1.0 versionを追加します。`0.9` の次が必ず `1.0` である必要もありません。

## 現在のbaseline: v0.1.0

`v0.1.0` は最初のsource releaseです。以下2つのreal adapterで検証後、このrepositoryをupstream source of truthとして確立しました。

- `git-ksk/maps-browser-mcp`
- `git-ksk/japan-cinema-browser-mcp`

npm packageは引き続き `private: true` です。npm publishはroadmap上の必須条件ではなく、下記の独立したpublication gateで判断します。

## Guiding principles

1. **Standards first.** MCP-nativeなMRTR / elicitation / Tasks等を優先し、並行する独自protocol semanticsを安易に増やさない。
2. **Security invariants before convenience.** principal/invocation binding、epoch fencing、authority排他、bounded checkpoint、capability lifetime、one-client lease、replay restrictionはcompatibility requirementとして扱う。
3. **Generic contractをconsumer policyより小さく保つ。** domain detection、provider policy、postcondition verification、native execution、consequential-action approvalはconsumer責務のままにする。
4. **Real adapterで抽象化を実証する。** synthetic exampleだけを根拠にpublic abstractionを固定しない。
5. **Handoffはapprovalではない。** Human completionを別のconsequential actionの承認にしない。
6. **Browser takeoverはoptional。** browser transportなしでもcoreが成立する状態を維持する。
7. **Bypass productにしない。** CAPTCHA solving、anti-bot evasion、credential relay、stealth/fingerprint spoofing、payment automationは明示的な非目標のままにする。

## v0.1.x — established baselineのhardening

対象:

- bug / security fix
- current contractを維持するspec alignment fix
- docs / diagnostics改善
- Maps / Japan Cinemaから得たregression coverage
- pre-1.0で避けられないbreaking fixがある場合のmigration note

Exit condition: documented security invariantを維持し、両real consumerがgreenであること。

## v0.2 — third adapterによるcontract validation

候補scope:

- 可能なら性質の異なるworkflow/domainのthird real adapterでcontractを検証
- public API追加前にadapter frictionを記録
- authority / epoch / ownership / resume policy / requestState bindingのcompatibility fixtureをformalize
- consumer semanticを漏らさず安定公開できるextension pointを整理

Exit criteria:

- 3つのreal adapterでdeterministic consumer testがgreen
- third adapterのためにgeneric `src/` へproduct-specific conceptを入れず再利用できる
- adapter都合でsecurity invariantを弱めない
- 新しいpublic surfaceには少なくとも2つの独立したreal use caseがある

npm publishは **v0.2のexit criterionではありません**。

## v0.3 — persistence / observability boundary

候補scope:

- bounded control-plane metadata制約を維持したpluggable durable-checkpoint storage interfaceの検討
- sensitive execution contentをlogせず統合できるaudit / observability hookの整理
- operator / test向けevent / diagnostic shapeの安定化
- crash / restart conformance coverageの強化

Exit criteria:

- generic API経由でraw action args、credential、browser content、challenge answer、payment dataを永続化できないこと
- recoveryはstale execution authority復元ではなくreissue-and-revalidateを維持
- observability追加がsecret/content exfiltration pathを作らないこと

## v0.4+ — MCP interoperability / transport maturity

候補scope:

- MCP MRTR / elicitation / Tasksの進化を追跡し、標準が代替できる独自plumbingは削減
- 実用上可能な範囲で複数MCP client/server implementationとの検証
- browser-takeover transport mechanicsとcore lifecycle semanticsの分離をさらに明確化
- capability / lease / origin / expiry / revocationのtransport conformance test強化

具体的なworkが決まった時点でversionを割り当てます。必要なら `0.5` / `0.6` / `0.10` 以降も使用します。

## v1.0 — stable contract milestone

`v1.0` はsecurity / compatibility contractをconsumerがroutine breaking changeなしで依存できる成熟度を意味します。特定の日付、pre-1.0 release数、npm publishには紐付けません。

最低exit criteria:

- core authority / epoch / ownership / resume / checkpoint semanticsをstable contractとして文書化
- compatibility / migration policyを文書化し実際に運用済み
- 3つ以上のreal adapterでgeneric boundaryを検証し、複数application domainを含む
- MCP標準との重複を再監査し、不要なprotocol duplicationがない
- browser takeoverがoptional / transport-onlyのまま
- Human completionとconsequential-action approvalが分離されたまま
- automatic replayがconsumer policyで明示的に制限されたまま
- CI / Dependency Review / CodeQL / secret scanning / security reportingが運用中
- documented invariantを無効化する既知security issueが未解決でない

## npm publication gate

npm publishはdelivery decisionであり、maturity signalではありません。`v0.1.0` のようにsource releaseだけを成立させられます。

`private: false` またはnpm publish前に最低限以下を確認します。

- package nameとpublic export surfaceをそのrelease向けに意図的に確定
- package installがsource consumerと同じchecked buildを再現
- provenance / release automation / least-privilege publishing credentialを設定
- publish artifactに意図したfileだけが入り、secret/private endpointがない
- public package APIへのSemVer impactを文書化
- exact package artifactを2つ以上のreal consumerで検証
- rollback / deprecation procedureを文書化

npm初回公開versionは `0.1.x` / `0.2.0` / それ以降のどれでもよく、roadmapでは固定しません。

## Out of scope

- CAPTCHA/challenge solving / bypass
- anti-bot evasion / stealth / fingerprint spoofing / proxy rotation
- credential / OTP / MFA / payment dataのMCP transport
- generic browser automation engine
- consequential actionのautomatic approval / replay
- generic coreへのprovider-specific policy

詳細は [Positioning](docs/positioning.ja.md)、[Architecture](docs/architecture.ja.md)、[Security Policy](SECURITY.ja.md) を参照してください。
