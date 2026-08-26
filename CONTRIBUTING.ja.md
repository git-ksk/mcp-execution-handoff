# コントリビューションガイド

[English](CONTRIBUTING.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

このプロジェクトでは、公開する共通契約を、各利用側が持つ個別ポリシーよりも小さく保つことを重視しています。

PRを作成する前に、次を確認してください。

1. `npm ci --ignore-scripts`、`npm run check`、`npm run build`、`npm audit --audit-level=moderate` を実行する。
2. セキュリティ境界を変更する場合は、失敗すべきケースを確認する決定的なネガティブテストを追加する。
3. テスト目的で実サービスのCAPTCHAやチャレンジを意図的に発生させない。
4. `core` にMaps、Cinema、特定provider、Chrome/CDP、製品固有の意味や判定を持ち込まない。
5. Browser Handoffは任意機能のままにし、Browser Target SurfaceとTransport固有処理をgeneric coreへ入れない。
6. principal binding、epoch fencing、単一クライアントlease、capabilityの有効期限・失効、CSP、永続checkpointの制約を弱めない。
7. 人間が手動作業を完了したことを、別の操作への承認として扱わない。
8. secret、token、private endpoint、credential、OTP/MFA値、決済情報、challenge answerをfixture、log、docsへ入れない。

英語ドキュメントが正本です。セキュリティやアーキテクチャ上の意味を変更した場合は、主要な日本語ドキュメントも同時に更新してください。

新しい汎用public APIを提案したり、プロジェクトの対象範囲を広げたりする前に、[位置づけ](docs/positioning.ja.md) と [ロードマップ](ROADMAP.ja.md) を確認してください。MCP標準ですでに提供されている仕組みと重複する案や、1つの利用側だけに必要な案は、汎用契約として十分な実例が集まるまでは利用側に留めます。
