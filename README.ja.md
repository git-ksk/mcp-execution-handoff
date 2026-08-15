# mcp-execution-handoff

[English](README.md)

MCP駆動の実行中にHuman interventionが必要になった場合、Agent実行を安全に停止し、Humanへ一時的にauthorityを移し、検証後にpolicyに従ってのみ再開するための小さなTypeScript runtimeです。

**Status:** pre-releaseの抽出候補です。npm packageとしては意図的に `private: true` のままで、npm publish / releaseはまだ行いません。

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
- takeover leaseはremote client 1つだけ。reload/new tab/new deviceで新しいmemory-only bindingになった場合、active leaseを暗黙reclaimできない。
- `no-store` / `no-referrer` / nonce-bound CSP client asset / bounded inputを維持する。
- **Human takeover完了は別actionのapprovalではない。** consequential actionのapprovalはconsumer側の別経路で明示的に扱う。
- stateful/consequential actionは、安全なreplayが別途成立しない限りhandoff後に自動replayしない。

詳細は [Architecture 日本語版](docs/architecture.ja.md) と [Security Policy 日本語版](SECURITY.ja.md) を参照してください。

## Resume policy

coreは `replay_safe` / `revalidate` / `confirm_before_execute` / `never_replay` を記録します。MCP bridgeはさらに `retry_original` / `require_fresh_semantic_action` のcall-site strategyを記録します。

consumerは常に厳しい方を採用します。`require_fresh_semantic_action` や `never_replay` がHuman完了だけを理由にautomatic replayへ昇格することはありません。

## Browser takeover

`browser-takeover` はoptionalです。brokerが知るintervention情報は `{ id, epoch }` のみで、principal bindingとbrowser adapterはconsumerから明示的に渡します。Maps URL、Cinema provider、CAPTCHA分類、provider policyはgeneric layerへ入りません。

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

## Upstream readiness

Maps + Cinemaの両real consumerがgreenで、contractにMaps/Cinema固有概念が漏れていないことを確認するまで `v0.1.0` release / npm publishは行いません。

## License

MIT
