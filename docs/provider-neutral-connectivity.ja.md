# Provider-neutral WebRTC connectivity

Status: Issue #19 の v0.5.0 contract。

WebRTC discovery、relay provider の選択、relay credential、fallback policy、bounded transport diagnostics は Handoff が所有します。Browser / Window / Terminal / MCP consumer は既存 lifecycle API を維持し、ICE / STUN / TURN provider を選びません。

## Ingress と relay は別責務

Hosted HTTPS ingress は Handoff signaling / control traffic を運びます。WebRTC direct / TURN は Human-to-worker data plane です。Cloudflare Tunnel などの ingress 選択を TURN abstraction にせず、別 ingress や hosted ingress なしでも TURN を利用できます。

## Direct discovery policy

Browser の direct attempt は host-candidate-only を維持します。Server peer には Handoff が必ず明示的な ICE-server list を渡し、WebRTC dependency による暗黙の third-party provider 選択を防ぎます。

互換性のため、review 済み default の `stun:stun.cloudflare.com:3478` は維持します。これは compatibility default であり consumer contract ではありません。Deployment は次の Handoff-owned 設定で credential-free な STUN / STUNS endpoint に差し替えられます。

`MCP_HANDOFF_WEBRTC_DIRECT_STUN_URLS`

Bounded な `stun:` / `stuns:` URL だけを受理し、TURN URL、credential、path、不正 port、query は fail closed です。

## Relay provider boundary

`WebRtcIceCredentialProvider` が provider-neutral な内部 issuance / revoke seam です。Provider 選択は Handoff 内部で一度だけ resolve します。

現在の実装は Cloudflare Realtime TURN と coturn TURN REST です。既存 provider-specific environment name は deployment compatibility input として維持しますが consumer API ではありません。複数 relay provider の設定は fail closed で、provider failure 後に別 vendor へ silent failover しません。

Provider credential は Handoff-owned / generation-bounded / in-memory です。MCP argument / result、model context、consumer setting、locator URL、argv、generic log、durable checkpoint、frame、Human-input record へ入れません。

Optional relay の発行に失敗した場合は bounded / content-free reason だけを記録し、review 済み direct path を relay unavailable として維持します。Transport failure を Human completion や Agent replay / resume authority に変換しません。

## Consumer contract

Consumer へ provider enum、STUN / TURN URL、candidate policy、credential、failover control を公開しません。Managed transport order は Handoff-owned な有限列のままです。Direct WebRTC / WSS / relay-capable WebRTC は別 generation で fence し、revoke / no-replay semantics を維持します。

## Evidence

Deterministic test では central provider selection、direct STUN override、partial / conflicting configuration、bounded Cloudflare failure reason、coturn credential generation、direct fallback、generation fencing、revoke、no-replay behavior を検証します。

Self-hosted path には real relay acceptance があります。

`npm run accept:webrtc:coturn-relay`

Digest-pinned coturn / Node image を host TURN port 非公開の isolated Docker network で使い、同じ Handoff-owned environment seam から coturn を resolve します。Relay-only ICE、両 peer の relay candidate、接続、DataChannel message 転送まで成功して `COTURN_RELAY_ACCEPTANCE_PASS` を出すことを必須にします。

後続の Issue #12 が hosted worker / control-plane topology を所有し、この connectivity boundary を再定義せず利用します。
