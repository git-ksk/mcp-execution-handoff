# Security Policy（日本語）

[English](SECURITY.md)

このprojectではExecution Handoffとbrowser takeoverをsecurity-sensitiveなcontrol-plane capabilityとして扱います。

principal / invocation / args binding bypass、Agent/Human authority重複、stale epoch受理、checkpoint改ざんやsecret/content永続化、takeover capabilityのleak/replay/expiry/revocation不備、one-client lease bypass、reload/tab/deviceによるimplicit transfer、CSP/origin/cache/referrer境界の退行、Human completionを別のconsequential action approvalとして扱える経路に加えて、credential-safe external Human sessionとAgent/automation authorityの重複、principal/epochを跨いだexternal session再利用、sensitive provider metadataの保持も重要なsecurity report対象です。

CAPTCHA/challenge solving、anti-bot bypass、stealth/fingerprint spoofing、proxy rotation、credential/OTP/MFA/payment dataのMCP transport、raw CDP、arbitrary browser automation、consequential actionのautomatic replay/approvalは非目標です。credential-safe external Human surfaceはautomation-incompatibleなcredential surfaceから離脱するための境界であり、automationをsupported login environmentに偽装する機能ではありません。

password、OAuth/session/access token、OTP/MFA/verification code、CAPTCHA answer、cookie/browser profile、payment data、private endpoint、production credentialをcommit/log/checkpoint/public issueへ含めないでください。Checkpoint signing keyもrepository外で管理します。

GitHub Private Vulnerability Reportingが有効な場合はそれを利用してください。利用できない場合、exploit detailsやsecretをpublic issueへ書かず、private reporting channelを求める最小限のissueだけを作成してください。
