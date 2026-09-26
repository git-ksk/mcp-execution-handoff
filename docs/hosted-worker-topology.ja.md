# Hosted control plane / execution-worker topology

Status: v0.6.0 / Issue #12 contract 実装中。

このcontractは、replace可能なhosted Handoff control planeとstateful execution workerを分離しつつ、Browser / Window / Terminal / Desktop authorityを広げません。

## Worker registration boundary

Transportがoutbound-capableなworker channelを先に認証し、Handoff coreへ渡すのは次のbounded metadataだけです。

- bounded worker identity
- そのworkerに許可されたprincipal binding
- opaqueなauthenticated-channel binding
- Handoff-owned worker generation

channel bindingはbearer credentialではありません。process-localのまま保持し、registryの戻り値やdurable routing metadataへ出しません。

`HostedWorkerRegistry` がtransport-neutralなreference boundaryです。HTTP / WSS / Cloud Run / message bus / 特定hosting vendor自体は実装しません。

worker identityはregistry lifetime中principalへ固定します。同じworkerへの2本目のconcurrent channelは拒否します。明示disconnect後のreconnectではworker generationを進め、旧channelのstale disconnectがsuccessorをfenceできないようにします。

## Authenticated outbound control channel

`HostedWorkerControlChannel` は、deployment transportが認証済みのchannelとworker registryを合成します。trusted worker id / principal binding / opaque channel bindingはtransportから渡し、peer messageからidentityを指定・上書きできません。

v1 control messageはcontent-freeに限定します。

- `registered`: Handoff-owned worker generationだけを返す
- `bind`: intervention id / epoch / worker generationだけを通知
- `revoke`: intervention id / epoch / worker generationだけを通知

frame、Human input、credential、target metadata、cookie、provider detailはcontrol protocolへ入れません。

registration通知に失敗した場合は作成直後のworker generationをfenceします。bind通知に失敗した場合はworkerをdisconnectし、そのgenerationが所有する全routeをinvalidにします。revokeはremote通知より**先に**local routeをfenceするため、通知失敗からcontrol-plane routing authorityが復活することはありません。後続でprovider-specificなWSS / HTTP/2 / overlay / message-bus等をtransport adapterとして追加しても、このauthority semanticsは変更しません。

## Intervention routing

hosted routeは次の全要素へbindingします。

- intervention id
- intervention epoch
- principal binding
- worker identity
- current worker generation

stale worker generationはfail closedです。worker disconnect時は、そのgenerationが所有するrouteを即時invalidにします。

同じinterventionはtransport loss後に同一worker identityへ明示reconnectでき、同じintervention epochでの再bindingも可能です。一方、別worker identityへのmigrationは許可しません。worker replacementにはconsumer-owned reissue/revalidationでfresh interventionを作る必要があります。transport/lifecycle epochが新しいだけで別execution sessionを同一扱いしません。

## Data boundary

worker registryが受理するのはbounded control-plane metadataだけです。extra fieldを拒否し、frame、Human input、credential/token、cookie、browser/application content、target identity、任意provider dataをroute stateへ入れません。

persistent browser profile、application session、OS session、framebuffer、target contentはexecution worker側の責務です。disposableなhosted control-plane instanceへ置きません。

## Existing Handoff stateとの関係

registryは2つ目のmutation-authority FSMを作りません。既存Handoffのintervention / authority / checkpoint / recovery semanticsがauthoritativeなままです。

hosted worker routingは追加のdelivery fenceとして働きます。

1. Handoff authorityがHuman operationをadmitする。
2. hosted routeでもprincipal / intervention / epoch / worker identity / worker generationが一致する必要がある。
3. worker/channel lossでdeliveryをinvalidにする。
4. recovery metadataからstale Human / Agent authorityを復元しない。
5. Agent resumeは既存のconsumer-owned semantic verification / reissue rule経由だけで行う。

## Operator session / worker lifetime composition

`HostedOperatorRouteBinding` は、既存のauthoritativeなoperator/viewer sessionとcurrent worker routeを合成します。別のoperator-session FSMは作りません。

lifetimeは独立です。

- operator session TTLは既存Handoff surface/session managerが所有
- viewer/client generationはoperator sessionが所有
- worker connection lifetime / worker generationは `HostedWorkerRegistry` が所有

worker reconnectでrotateできるのはworker generationだけで、operator TTLを延長したりstale viewer generationを復活させたりできません。viewer reconnectでrotateできるのはviewer generationだけで、stale worker routeを正当化できません。どちらかのgenerationが変わった場合はfresh bindingを明示的に作り、両方のauthoritative current stateへ再validationします。

bindingはprocess-local coordination stateでありdurable recovery stateではありません。frame、Human input、credential、cookie、target identity、provider detail、channel binding、任意contentを保持しません。

## 次のv0.6.0 slice

残る#12 workはこのboundary上に積み上げます。

- authenticated outbound worker channel protocol
- worker connection lifetimeと独立したoperator-session TTL
- stale frameをqueueしないlatest-frame / backpressure semantics
- real hosted channel上のdisconnect/reconnect / revocation propagation
- 既存recovery ruleを使うbounded durable hosted metadata
- local worker / remote stateful workerのdeployment referenceとacceptance
