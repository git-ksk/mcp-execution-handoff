# セキュリティポリシー

[English](SECURITY.md)

> 英語版が正本です。内容に差がある場合は英語版を優先してください。

## このプロジェクトが守るセキュリティ境界

`mcp-execution-handoff` では、実行権限の引き継ぎとbrowser takeoverを、セキュリティ上重要なcontrol-plane機能として扱います。

特に、次のような問題は重要な脆弱性報告の対象です。

- principal、呼び出し内容、引数へのbindingを回避できる
- AgentとHumanが同時に実行権限を持てる
- 古いresource epochを受理してしまう
- checkpointを改ざんできる、またはsecretや実行内容がcheckpointへ保存される
- takeover capabilityの漏えい、再利用、有効期限、失効処理に不備がある
- 単一クライアントleaseを回避できる
- reload、新しいtab、別deviceへの切り替えでleaseが暗黙移譲される
- reconnect handleを盗用・再利用できる、または古いclient generationを受理する
- CSP、origin、cache、referrerの境界が弱くなる
- Humanが手動作業を終えたことを、別の重大操作への承認として扱える
- external Human sessionとAgent/automation authorityが重複する
- external sessionを別principalや別epochで再利用できる
- providerから返された機微なmetadataを不要に保持する
- credential-safeなHuman入力を、本来必要なnormal-browser境界ではなくautomation-managed browserへ流せる
- exact-window限定のcapture/input範囲がdesktop全体などへ広がる
- Humanが入力した文字列がprocess argvや、処理完了後のclipboardに残る
- WebRTCで古いgenerationが復活する、background/foregroundで暗黙reconnectする、legacy frame/inputへfallbackする
- transport dataがlogや永続control-plane stateへ漏れる
- STUN/TURNのtrust boundaryがレビューなしに変わる

## 非目標として維持するもの

次の機能はこのプロジェクトの対象外です。未実装であること自体は機能不足ではありません。

- CAPTCHA / challenge solvingやbypass
- anti-bot回避
- stealth / fingerprint spoofing
- proxy rotation
- credential、OTP、MFA、決済情報をMCP経由で運ぶこと
- raw CDPの公開
- 任意のbrowser automation
- 重大操作の自動再実行や自動承認

credential-safe external Human surfaceは、automationと相性の悪いcredential入力画面から安全に離脱するための境界です。automationを「対応済みの通常ブラウザ」に見せかけるための機能ではありません。この種の画面ではOSが変わってもルールは同じです。automation browserを停止し、同じ専用profileをremote-debuggingやautomation authorityなしのnormal browserで開きます。

## 機微情報の扱い

次の情報をrepository、log、checkpoint、public Issueへ入れないでください。

- passwordや認証secret
- OAuth / session / access token
- OTP / MFA / verification code
- CAPTCHA / challenge answer
- cookieやbrowser profileの内容
- card番号やbank dataなどの決済情報
- private endpointやproduction credential
- raw Human input
- framebuffer / video payload
- WebRTC key material
- raw ICE candidate文字列やnetwork address
- 機微なdeployment topologyを含み得るSDP
- reconnect secretやcapability secret

relay provider未設定時、browser側のdirect-only peerはSTUNへ接続しません。Node/werift peerはdependencyの暗黙defaultを避けるため、review済みの明示STUNだけを使います。この通信ではserver側のnetwork metadataがSTUN operatorへ見える可能性があるため、transport trust boundaryとして扱います。Handoffのdiagnosticへraw candidateやaddressを残してはいけません。

Cloudflare Realtime TURNとself-hosted coturnは、どちらもHandoff runtimeが所有するoptional relay trust boundaryです。provider secretはserver-sideだけに保持し、browser/helper/MCP context/log/analytics/durable stateへ出してはいけません。coturnの `MCP_HANDOFF_COTURN_SHARED_SECRET` はlong-lived secretとしてCloudflare API tokenと同等に保護します。TURN URLへcredentialを埋め込むことは禁止し、Cloudflareとcoturnを同時設定した場合や片側だけの不完全設定はfail-closedにします。

coturn TURN REST credentialは `timestamp:random` usernameを使い、principal / intervention / client / account / target-service identifierを含めません。Handoff generationのsuspend/disconnect/Done/Cancel/expiry/reconnectではmedia/input authorityを即時revokeします。Cloudflare credentialはactive revokeできますが、coturnにはcredential単位のrevoke APIがないため、ランダム化されたcoturn credentialはgeneration expiryまでの短いTTLで自然失効します。そのcredential単体ではHandoff signaling、DataChannel authority、target-service authenticationを復元できません。

checkpoint signing keyはrepository外で生成・保管してください。

## 脆弱性の報告

GitHub Private Vulnerability Reportingが有効な場合は、それを利用してください。利用できない場合でも、exploitの詳細やsecretをpublic Issueへ書かないでください。privateな報告経路を求める最小限のIssueだけを作成してください。
