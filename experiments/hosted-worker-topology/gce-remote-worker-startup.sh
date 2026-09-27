#!/usr/bin/env bash
set -euo pipefail

metadata() {
  curl --fail --silent --show-error     -H 'Metadata-Flavor: Google'     "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"
}

CONTROL_URL="$(metadata handoff-control-url)"
REVISION="$(metadata handoff-revision)"
WORKER_IMAGE="$(metadata handoff-worker-image)"
PRIVATE_KEY_B64="$(metadata handoff-private-key-b64)"

[[ "$CONTROL_URL" =~ ^https:// ]] || { echo "invalid control URL" >&2; exit 1; }
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid revision" >&2; exit 1; }
[[ "$WORKER_IMAGE" == *".pkg.dev/"* ]] || { echo "invalid worker image" >&2; exit 1; }

mkdir -p /run/handoff /var/lib/handoff-acceptance/profile
chmod 700 /run/handoff /var/lib/handoff-acceptance /var/lib/handoff-acceptance/profile
printf '%s' "$PRIVATE_KEY_B64" | base64 --decode > /run/handoff/private.pem
chmod 600 /run/handoff/private.pem
unset PRIVATE_KEY_B64

export DEBIAN_FRONTEND=noninteractive
for _ in $(seq 1 60); do
  if apt-get update >/dev/null 2>&1; then break; fi
  sleep 5
done
apt-get install -y --no-install-recommends docker.io ca-certificates curl python3 >/dev/null
systemctl enable --now docker >/dev/null

REGISTRY_HOST="$(printf '%s' "$WORKER_IMAGE" | cut -d/ -f1)"
TOKEN="$(curl --fail --silent --show-error   -H 'Metadata-Flavor: Google'   'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'   | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
printf '%s' "$TOKEN" | docker login   -u oauth2accesstoken   --password-stdin   "https://$REGISTRY_HOST" >/dev/null
unset TOKEN

docker pull "$WORKER_IMAGE" >/dev/null
set +e
docker run --rm   --name handoff-remote-stateful-worker   --mount type=bind,src=/var/lib/handoff-acceptance/profile,dst=/state/profile   --mount type=bind,src=/run/handoff/private.pem,dst=/run/handoff/private.pem,readonly   -e HANDOFF_CONTROL_PLANE_URL="$CONTROL_URL"   -e HANDOFF_ACCEPTANCE_REVISION="$REVISION"   -e HANDOFF_WORKER_PRIVATE_KEY_PATH=/run/handoff/private.pem   -e HANDOFF_BROWSER_PROFILE_DIR=/state/profile   "$WORKER_IMAGE" 2>&1 | tee /var/log/handoff-remote-worker.log /dev/ttyS0
STATUS=${PIPESTATUS[0]}
set -e
printf 'HANDOFF_REMOTE_WORKER_EXIT=%s\n' "$STATUS" | tee /dev/ttyS0
exit "$STATUS"
