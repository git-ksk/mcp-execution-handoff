# Managed Cloud Run physical acceptance — Issue #152

This gate validates the first-class Browser Handoff sequence on one exact candidate revision:

```text
WebRTC direct -> WebSocket relay
```

TURN/STUN relay configuration is deliberately absent. The temporary service must be deleted after evidence capture.

## Deploy the exact candidate

Use an existing Artifact Registry repository; the helper never creates or changes repository credentials.

```bash
export GOOGLE_CLOUD_PROJECT='<project-id>'
export HANDOFF_ACCEPTANCE_IMAGE_REPOSITORY='asia-northeast1-docker.pkg.dev/<project-id>/<repository>'
export HANDOFF_ACCEPTANCE_REGION='asia-northeast1'

bash experiments/websocket-cloud-run/deploy-managed-physical.sh
```

The helper builds from `git archive HEAD`, tags the image with the exact 40-character git SHA, refuses to overwrite an existing Cloud Run service, deploys with concurrency/max-instances bounded to one and instance-based CPU for the normal browser runtime, configures no TURN credentials, binds the application to the returned HTTPS service origin, and waits on the Cloud Run-safe `/ready` route for the exact-window target to become ready.

Retain the emitted values:

```text
HANDOFF_ACCEPTANCE_URL=...
HANDOFF_ACCEPTANCE_START=.../start
HANDOFF_ACCEPTANCE_REVISION=<40-char SHA>
HANDOFF_ACCEPTANCE_SERVICE=handoff-managed-...
HANDOFF_ACCEPTANCE_REGION=asia-northeast1
```

Do not record or publish any takeover locator, client generation capability, Human input text, framebuffer data, SDP/ICE payload, or WebSocket payload.

## Physical iPhone Safari sequence

Open only the emitted `HANDOFF_ACCEPTANCE_START` URL on a physical iPhone in Safari. The first page is direct WebRTC. In the Cloud Run topology it must become unusable without TURN, after which the Handoff-owned page transitions to the WSS locator with a fresh generation.

Exercise the WSS-controlled exact window in this order:

1. Tap the full-window button to open the form.
2. Confirm the text field receives focus.
3. Type harmless test text.
4. Press Backspace once.
5. Scroll far enough to expose the scroll marker.
6. Press Enter and confirm the target shows the submitted state.
7. Press **Done** in the takeover UI.

Disconnect/reload alone is not Done and must not be recorded as completion.

## Verify bounded evidence

After Done, run:

```bash
node experiments/websocket-cloud-run/verify-managed-physical.mjs \
  "$HANDOFF_ACCEPTANCE_URL" \
  "$HANDOFF_ACCEPTANCE_REVISION"
```

The only passing terminal marker is:

```text
MANAGED_PHYSICAL_ACCEPTANCE_OK
```

The verifier requires the exact candidate revision, no TURN configuration, WSS as the fallback transport, generation rotation, at least one transition, `transport_unavailable` as the fallback reason, stale direct locator rejection, stale post-Done WSS locator rejection, tap/focus/text/Backspace/scroll/Enter/submit/Done observations, verification start, and completed teardown.

The deterministic coordinator tests remain the source of proof that a stale pre-fallback DataChannel input attempt itself fails closed; the physical result's `staleDirectGenerationFenced` flag combines generation rotation with stale direct-locator rejection and must not be described as a physically injected stale DataChannel packet.

## Teardown

Use the exact service name emitted by deploy:

```bash
export HANDOFF_ACCEPTANCE_SERVICE='handoff-managed-...'
export HANDOFF_ACCEPTANCE_REGION='asia-northeast1'
export GOOGLE_CLOUD_PROJECT='<project-id>'

bash experiments/websocket-cloud-run/teardown-managed-physical.sh
```

Confirm the service no longer resolves before closing #152. Record only the exact git SHA and content-free PASS facts in the Issue/PR evidence.
