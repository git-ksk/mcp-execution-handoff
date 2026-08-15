# Contributing（日本語）

[English](CONTRIBUTING.md)

public contractはconsumer-specific policyより小さく保ちます。

PR前に `npm ci --ignore-scripts`、`npm run check`、`npm run build`、`npm audit --audit-level=moderate` を実行してください。security boundary変更にはdeterministic negative testを追加し、テスト目的でlive CAPTCHA/challengeを意図的に発生させません。

`core` へMaps/Cinema/provider/Chrome/CDP/product固有semanticを入れず、browser takeoverはoptional transport-onlyに保ちます。principal binding、epoch fencing、one-client lease、capability expiry/revocation、CSP、durable checkpoint制約を弱めません。Human completionを別action approvalとして扱いません。secret/token/private endpoint/credential/OTP/MFA/payment data/challenge answerをfixture/log/docsへ入れません。

英語docsをcanonicalとし、security/architecture semanticsを変更した場合は主要日本語docsも同期します。
