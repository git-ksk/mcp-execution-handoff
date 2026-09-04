# Desktop Session / Display Backend境界

[English](desktop-session-display-backend.md)

Issue #161では、v0.4.x向けに意図的に小さい **internal boundary** を導入します。Desktop Target
Surface、新しいpublic package subpath、virtual/remote desktop実装、新しいHuman authorityは追加しません。
目的はtransport/viewer lifecycleをOS/application sessionそのものとして扱わないようにすることです。

## 分離する概念

| 概念 | 所有するもの | 所有しないもの |
| --- | --- | --- |
| **Desktop Session** | Handoffから見たpersistent application/session continuity。現行v0.4.xでは1つのstable physical display binding | transport generation、viewer URL、semantic success、Desktop-wide mutation authority |
| **Display Backend** | 既存authorized surfaceをhostがどう提示するか。v0.4.1では既存 `physical` backendのみ | Human authority、transport選択、consumer authentication state |
| **Target Surface** | 既にreview済みのmutation scope。現在はbounded Window contract | displayが存在するだけでwhole Desktopへ広がるauthority |
| **Human Viewer** | fit / actual-size / adaptive表示、zoom/pan、current viewer generation | OS display/session lifetime、authority復元、semantic verification |
| **Transport** | WebRTC/WSS delivery、reconnect/fallback、transport generation/capability fencing | application-session identity、display resize policy、Target Surface widening |
| **Authority** | Agent/Human排他、principal/intervention/epoch/client-generation fencing、revoke/expiry/Done | viewer表示やbackend実装詳細 |

重要なのは、WebRTC -> WSS -> relay-capable WebRTCへ移行してもrotateするのは **Human viewer
attachment generation** であり、**Desktop Session + physical display backend** は同じままという点です。この
attachment generationは既存のcapability/reconnect fencing用transport/client generationとは別物です。WebRTC内部
reconnectでDesktop Sessionを再作成したりauthorityを暗黙rotateしたりしません。disconnectやtransport fallbackを
application sessionの破棄/再作成として扱いません。

## v0.4.1の実装境界

最初のincrementは保守的に限定します。

- backend-neutral descriptorは `physical` / `virtual` / `remote_session` capability classを表現できるが、
  v0.4.1で実装/factoryするのは `physical` だけ;
- `DesktopSessionDisplayBoundary` はinternalで、package surfaceからexportしない;
- first-class **Window** facadeだけがopt-inし、Browser / Terminal semanticsは変更しない;
- concrete display backendは既存physical bounded-Window pathのみ;
- direct Window Handoffはintervention中1つのviewer generationを使用;
- managed Window fallbackでは旧viewer generationをdetachしてから次generationをattachし、同じDesktop
  Session/display boundaryを維持;
- final revoke / verified completionで閉じるのはHandoff側boundary objectだけで、consumer-ownedな
  OS/application process/sessionを終了しない;
- 同じboundaryのimplicit retargetはfail closed;
- viewer/transport generationを跨ぐHuman input replayは行わない。

internal snapshotはcontent-freeです。lifecycle、backend kind、display/viewer attached状態、viewer generation、
2つのbackend capability booleanだけを持ち、PID/window id、principal、intervention/session id、locator、
credential、framebuffer、Human inputは含みません。

## Viewer scalingとdisplay resizeは別能力

current physical backend capability:

```text
viewer_scaling: true
dynamic_display_resize: false
```

viewer mode:

```text
fit | actual_size | adaptive
```

physical backendでは3モードとも **viewer-side** の表示選択です。`adaptive`でもmonitor resolutionやtarget
Window geometryを変更しません。fit/zoom/pan geometryをローカルで解決し、viewer coordinateを既にauthorizedな
bounded surface上のnormalized coordinateへ変換します。rendered surface外のpointはrejectします。

physical displayへのdynamic resize requestは `DESKTOP_DISPLAY_RESIZE_UNSUPPORTED` でfail closedです。
将来backendがdynamic resizeをadvertiseする場合は、そのOS session semanticsとauthority影響を別設計・physical
acceptanceしてから追加します。

## Lifecycle / stale-generation fencing

```text
Desktop Session active
  + physical display attached
  + viewer generation N active
        |
        | transport fallback / reconnect boundary
        v
  viewer generation N detached
  Desktop Session + display stay active
        |
        v
  viewer generation N+1 attached
        |
        | revoke / verified terminal close
        v
Desktop Session Handoff boundary closed
```

viewer generationは単調増加のみです。old generation再利用、stale attachment detach、active viewerがいる状態での
別viewer attachはfail closedです。authority/transport cleanup向けviewer detachはidempotentで、replacement sessionを
生成しません。

## Platform semanticsを誤って共通化しない

このabstractionは1つのcross-platform OS-session modelを主張しません。

- **macOS:** evidenceは既存bounded physical Window path（review済みsecure Window / successorを含む）のまま。
  #161でScreen Sharing、virtual display、generic desktop session APIは追加しない。
- **Linux:** evidenceは既存exact X11 Window/runtime pathのまま。将来headless/virtual-display backendを追加するなら、
  display attachment変更時にapplication sessionが継続するかをLinux固有に定義する。
- **Windows:** #161はRDP session switching、console-session behavior、virtual-display semanticsをgeneric invariantへ
  encodeしない。Windows backend proof側で個別にdocumentする。

CUAなどのGUI driverはreplaceableなexecution mechanismのままです。Desktop Session/Display Backend lifecycleや
Handoff固有virtual-display behaviorの実装をCUAへ要求しません。

## Security invariant

既存contractは弱めません。

- silent Window -> Desktop fallbackなし;
- #161でDesktop authorityを追加しない;
- Agent/Human mutation authorityは排他;
- stale locator/capability/epoch/client/viewer generationはfail closed;
- disconnectはDoneではない;
- Human inputはreplayしない;
- Doneはlifecycle completionでありauthentication/approval/semantic successではない;
- credential、secure/Human text、framebuffer/browser content、remote-session secretをgeneric
  audit/checkpoint/diagnosticへ入れない。

## Follow-up backend

Virtual display / remote-session implementationは **#161/v0.4.1には含めません**。この境界を安定させた後、各backend
proofをplatform固有session/lifecycle semantics、resize capability、physical/deterministic acceptance、failure behaviorを
持つ別Issueとして実装します。explicit Human-only Desktop authorityは#125で、この境界より後です。backend追加を#125の
authority reviewを迂回するhidden routeにしてはいけません。
