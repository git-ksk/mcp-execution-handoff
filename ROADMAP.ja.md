# ロードマップ

[English](ROADMAP.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

このロードマップはリリース日程ではなく、プロダクトと公開contractの方向性、および各milestoneの完了条件を示します。必要に応じてpre-1.0 versionを追加します。`0.9` の次が必ず `1.0` である必要もありません。

## 現在のbaseline: v0.1.0

`v0.1.0` は最初のsource releaseです。次の2つの実consumerで検証したうえで、このrepositoryをupstream source of truthとして確立しました。

- `git-ksk/maps-browser-mcp`
- `git-ksk/japan-cinema-browser-mcp`

npm packageは引き続き `private: true` です。npmへの公開はroadmap上の必須条件ではなく、後述のpublication gateで独立して判断します。

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
- pre-1.0で避けられないbreaking fixがある場合のmigration note

完了条件: documented security invariantを維持し、両consumerでgreenであること。

## v0.2 — 3つ目のconsumerでcontractを検証

候補scope:

- 可能なら性質の異なるworkflow/domainの3つ目の実consumerでcontractを検証
- public API追加前にadapter frictionを記録
- authority / epoch / ownership / resume policy / request-state bindingのcompatibility fixtureをformalize
- consumer固有semanticを漏らさず公開できるextension pointを整理

完了条件:

- 3つの実consumerでdeterministic testがgreen
- 3つ目のconsumerのためにgeneric `src/` へproduct-specific conceptを入れず再利用できる
- adapter都合でsecurity invariantを弱めない
- 新しいpublic surfaceには少なくとも2つの独立した実use caseがある

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
- browser-takeover transport mechanicsとcore lifecycle semanticsの分離をさらに明確化
- capability / lease / origin / expiry / revocation / reconnect-handle rotation / client-generation fencingのtransport conformance test強化
- generic remote-desktop productへ広げず、low-latency push/latest-frame transportとminimal native Human Takeover reference clientを検証

具体的なworkが決まった時点でversionを割り当てます。必要なら `0.5`、`0.6`、`0.10` 以降も使用します。

## v1.0 — stable contract milestone

`v1.0` はsecurity / compatibility contractが成熟し、consumerが日常的なbreaking changeを心配せず依存できる状態を意味します。特定の日付、pre-1.0 release数、npm publicationには紐付けません。

最低限の完了条件:

- core authority / epoch / ownership / resume / checkpoint semanticsをstable contractとして文書化
- compatibility / migration policyを文書化し、実運用で確認済み
- 3つ以上の実consumerでgeneric boundaryを検証し、複数application domainを含む
- MCP標準との重複を再監査し、不要なprotocol duplicationがない
- browser takeoverがoptional / transport-onlyのまま
- Human completionと重大操作のapprovalが分離されたまま
- automatic replayがconsumer policyで明示的に制限されたまま
- CI / Dependency Review / CodeQL / secret scanning / security reportingが運用中
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
- 重大操作のautomatic approval / replay
- generic coreへのprovider-specific policy

詳細は [位置づけ](docs/positioning.ja.md)、[アーキテクチャ](docs/architecture.ja.md)、[セキュリティポリシー](SECURITY.ja.md) を参照してください。
