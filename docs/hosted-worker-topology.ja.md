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

## Latest-only hosted frame delivery

`HostedLatestFrameBridge` はhosted path向けにprocess-memory-onlyなframe deliveryを提供します。既存WSSと同じbackpressure原則を使い、unboundedなrelay queueは作りません。

- in-flight frame送信は最大1件
- pending frame保持も最大1件
- 新しいpending frameが古いものを置換
- transport drain時も最新pending frameだけを再送
- 送信直前にoperator/viewer generationとworker generationを両方再validation
- transport failureではbridgeを閉じ、pending frame dataを破棄

frameはephemeralでdurable recovery/control stateにはしません。diagnosticsはbounded counter/stateのみで、session / intervention / principal / worker / credential / frame contentを出しません。

## Revocation propagation

`HostedWorkerControlChannel` はboundedな `routesInvalidated` hookを受け取り、2つ目のauthority FSMを作らずにhosted routing lossを既存operator/surface lifecycleへ伝播できます。

順序はfail-closedです。

1. hosted routeのlocal stateを先にfence
2. route identity / generation metadataとenum reasonだけを持つbounded callbackを呼ぶ
3. remote workerへのrevoke / close通知は独立して進める
4. callback / transport失敗は明示エラーとしてsurfacingし、fence済みrouteは復元しない

explicit revoke、worker disconnect、bind delivery failure、revoke delivery failureを対象にします。callbackへframe、Human input、credential、cookie、target content、provider secretは入れません。

## Hosted recovery boundary

hosted restart recoveryは既存v0.3 checkpoint contractを再利用します。`recoverHostedControlPlane()` はvalidation済みcheckpointからboundedなorchestration hintだけを作ります。

- recoveryは `reissue_and_revalidate` のまま
- worker routeは `reconnect_required`
- operator sessionは `reissue_required`

worker identity / generation、authenticated channel binding、operator session id / viewer generation、locator / capability、frame / input state、target identity、credential / cookie、application / browser contentはdurable stateから復元しません。restart後のworker registryは空から始まり、fresh authenticated worker connectionなしではhosted routeを発行できません。

## Generation-fenced hosted Human input

`HostedHumanInputBridge` とworker側 `HostedWorkerRouteGate` で、自動replay queueを持たないhosted Human-input pathを定義します。

- control planeはdispatch直前にoperator/viewer generationとworker routeを再validation
- 各input envelopeはintervention id / epoch / worker generationを保持
- worker gate側でもstale generation / stale epoch / revoked routeを独立して拒否
- bridge内のin-flight inputは最大1件で、concurrent inputはqueueせずfail closed
- transport failureでbridgeを閉じ、Human inputを自動retryしない
- input shapeはdelivery前にclosed-worldかつboundedにvalidation

worker/principal identityはpeer messageから受け取らず、authenticated channel contextのままです。

## Lifecycle termination ordering

`HostedInterventionRouteLifecycle` はcanonical `ExecutionHandoffState` と1つのhosted operator/worker bindingを合成します。別のauthority FSMではなく、順序保証だけを追加するhelperです。

Human-controlを終端する各pathでは、canonical lifecycleを進める**前に**hosted mutation routeをrevokeします。

- **Done:** hosted routeをrevokeしてから `verifying` へ移る。Human Doneはsemantic successではなく、明示的なconsumer verificationなしにAgent authorityは戻らない。
- **Cancel:** hosted routeをrevokeしてからcanonical interventionをcancelする。hosted revoke成功前にはAgent authorityを復元しない。
- **Operator-session expiry:** hosted routeをrevokeしてから `verifying` へ移る。expiryはsemantic successを証明せず、Agent resume前にfresh verificationが必要。

worker revoke deliveryまたはinvalidation propagationに失敗した場合、lifecycle transitionは実行しません。local hosted routeがすでにfenceされていてもcanonical stateはHuman-activeのまま残り、Agent authorityをsuspendし続けます。意図したfail-closed動作です。

## Worker-origin frame provenance

worker-origin frameはgeneration-scopedな `HostedWorkerFrameEnvelope` を使います。worker側route gateはauthenticated worker generation上のcurrent intervention / epochにだけenvelopeを作れます。control-plane側 `HostedWorkerFrameIngress` でもcurrent operator/worker bindingと独立照合してからlatest-only frame bridgeへ渡します。

peer dataからworker identity、channel binding、provider identity、credential material、target identityを受け取りません。そのためtransport messageが遅延到着してもstale/revoked worker routeやstale viewer generationからframeをdeliverできません。

## Deployment reference

同じcore contractを次の3形態で使います。形態ごとにauthority semanticsを変えません。

1. **Local-only**
   - control planeとexecution workerは同一machineでもよい。
   - worker channelはloopback / local IPC adapterを利用可能。
   - browser/profile/application sessionはworker側に残す。
2. **Hosted control plane + local worker**
   - public operator ingress / hosted control planeと、private/local Mac等のworkerを分離。
   - workerはauthenticated outbound channelだけを開始し、inbound public listenerを要求しない。
   - operator session TTL、viewer generation、worker generationは独立。
3. **Hosted control plane + remote/stateful browser worker**
   - workerはpersistent browser/profile/application sessionを所有するstateful VM/container等。
   - disposable control planeへprofile/session/frame/inputを永続化しない。
   - worker差し替えを同一interventionへsilent reassignmentせず、fresh reissue/revalidationを要求する。

`experiments/hosted-worker-topology/acceptance.mjs` はreal WebSocket上でoutbound worker形状、registration、generation fencing、frame/input、disconnect/reconnect、revocationをdeterministicに検証します。これはphysical Cloud Run / Mac / remote browser acceptanceの代替ではありません。

## v0.6.0 implementation / acceptance status

provider-neutral core implementationはcurrent candidate lineで完了しています。

- authenticated outbound worker registration/channel: `HostedWorkerRegistry` + `HostedWorkerControlChannel`
- intervention / principal / worker generation fencingとduplicate ownership拒否
- operator-session TTL / viewer generation / worker connection generationの独立性
- stale frameをqueueしないlatest-only frame / backpressure
- explicit revoke / disconnect / delivery failure時のfail-closed route revocation propagation
- Done / Cancel / operator-session expiryでcanonical lifecycleより先にhosted routeをrevokeするordering
- stale authorityを復元せず `reissue_and_revalidate` hintだけを返すrecovery
- automatic replayなしのgeneration-fenced Human input
- intervention / epoch / worker generationへbindingしたworker-origin frame provenance
- `npm run accept:hosted-topology:loopback` によるdeterministic real-WebSocket topology acceptance

physical deployment gateはcurrent main 5ea155ddb50aa66dc01b70ba7888175327a25b5d で完了しています。

1. hosted control plane + private/local macOS worker: outbound-only authenticated WSSかつinbound public worker listenerなしでPASS
2. hosted control plane + remote/stateful Linux Chromium worker: external IPなし、inbound firewall/listenerなし、worker-owned dedicated profile/process continuityをworker generation rotation越しに維持してPASS

両方のexact-revision runでdisconnect/reconnect generation fencing、hosted input/frame routing、stale worker/viewer rejection、fail-closed lifecycle-route revocation、Agent resume前のreconnect/reissue-only recoveryを確認済みです。physical Human UI interactionは別のproduct/consumer evidenceであり、hosted topology deployment gateから推定しません。
