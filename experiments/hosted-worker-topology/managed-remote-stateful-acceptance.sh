#!/usr/bin/env bash
set -euo pipefail

for tool in git gcloud curl node base64; do command -v "$tool" >/dev/null; done

REVISION="$(git rev-parse HEAD)"
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "exact git revision required" >&2; exit 1; }
PROJECT="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${HANDOFF_MANAGED_REMOTE_REGION:-us-central1}"
ZONE="${HANDOFF_MANAGED_REMOTE_ZONE:-us-central1-a}"
REPOSITORY="${HANDOFF_MANAGED_REMOTE_REPOSITORY:-cloud-run-source-deploy}"
RUN_SUFFIX="${HANDOFF_MANAGED_REMOTE_RUN_SUFFIX:-$$}"
[[ "$RUN_SUFFIX" =~ ^[a-z0-9-]{1,20}$ ]] || { echo "invalid managed remote run suffix" >&2; exit 1; }
[[ -n "$PROJECT" && "$PROJECT" != "(unset)" ]] || { echo "configured Google Cloud project required" >&2; exit 1; }

SERVICE="handoff-remote-cp-${REVISION:0:8}-${RUN_SUFFIX}"
VM="handoff-remote-worker-${REVISION:0:8}-${RUN_SUFFIX}"
ROUTER="handoff-remote-router-${REVISION:0:8}-${RUN_SUFFIX}"
NAT="handoff-remote-nat-${REVISION:0:8}-${RUN_SUFFIX}"
CONTROL_IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPOSITORY}/mcp-execution-handoff-remote-control:${REVISION}-${RUN_SUFFIX}"
WORKER_IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPOSITORY}/mcp-execution-handoff-remote-worker:${REVISION}-${RUN_SUFFIX}"

TMP="$(mktemp -d)"
PRIVATE_KEY="$TMP/worker-private.pem"
PRIVATE_KEY_B64_FILE="$TMP/worker-private.b64"
PUBLIC_KEY_FILE="$TMP/worker-public.txt"
CONTEXT="$TMP/context"
URL=""
VM_CREATED=0
ROUTER_CREATED=0
NAT_CREATED=0

cleanup() {
  set +e
  if [[ "$VM_CREATED" == "1" ]]; then
    gcloud compute instances delete "$VM" --project "$PROJECT" --zone "$ZONE" --quiet >/dev/null 2>&1
  fi
  if [[ -n "$URL" ]]; then
    gcloud run services delete "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet >/dev/null 2>&1
  fi
  if [[ "$NAT_CREATED" == "1" ]]; then
    gcloud compute routers nats delete "$NAT" --router "$ROUTER" --project "$PROJECT" --region "$REGION" --quiet >/dev/null 2>&1
  fi
  if [[ "$ROUTER_CREATED" == "1" ]]; then
    gcloud compute routers delete "$ROUTER" --project "$PROJECT" --region "$REGION" --quiet >/dev/null 2>&1
  fi
  gcloud artifacts docker images delete "$CONTROL_IMAGE" --project "$PROJECT" --quiet >/dev/null 2>&1
  gcloud artifacts docker images delete "$WORKER_IMAGE" --project "$PROJECT" --quiet >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

gcloud artifacts repositories describe "$REPOSITORY" --project "$PROJECT" --location "$REGION" >/dev/null
for resource in "$SERVICE" "$VM" "$ROUTER"; do
  case "$resource" in
    "$SERVICE")
      if gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
        echo "refusing to overwrite existing acceptance service" >&2; exit 1
      fi
      ;;
    "$VM")
      if gcloud compute instances describe "$VM" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
        echo "refusing to overwrite existing acceptance VM" >&2; exit 1
      fi
      ;;
    "$ROUTER")
      if gcloud compute routers describe "$ROUTER" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
        echo "refusing to overwrite existing acceptance router" >&2; exit 1
      fi
      ;;
  esac
done

node - "$PRIVATE_KEY" "$PUBLIC_KEY_FILE" <<'NODE'
const fs = require("node:fs");
const { generateKeyPairSync } = require("node:crypto");
const [privatePath, publicPath] = process.argv.slice(2);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
fs.writeFileSync(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
fs.writeFileSync(publicPath, publicKey.export({ format: "der", type: "spki" }).toString("base64url"), { mode: 0o600 });
NODE
base64 < "$PRIVATE_KEY" | tr -d '\n' > "$PRIVATE_KEY_B64_FILE"
chmod 600 "$PRIVATE_KEY_B64_FILE"
PUBLIC_KEY="$(cat "$PUBLIC_KEY_FILE")"

mkdir -p "$CONTEXT"
git archive "$REVISION" | tar -x -C "$CONTEXT"

gcloud builds submit "$CONTEXT"   --project "$PROJECT"   --config "$CONTEXT/experiments/hosted-worker-topology/cloudbuild-managed-remote.yaml"   --substitutions "_CONTROL_IMAGE=$CONTROL_IMAGE,_WORKER_IMAGE=$WORKER_IMAGE" >/dev/null

gcloud run deploy "$SERVICE"   --project "$PROJECT"   --region "$REGION"   --image "$CONTROL_IMAGE"   --allow-unauthenticated   --ingress all   --concurrency 1   --max-instances 1   --min-instances 0   --cpu 1   --memory 512Mi   --timeout 900   --set-env-vars "HANDOFF_ACCEPTANCE_REVISION=$REVISION,HANDOFF_ACCEPTANCE_WORKER_PUBLIC_KEY=$PUBLIC_KEY"   --quiet >/dev/null

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
[[ "$URL" =~ ^https:// ]] || { echo "Cloud Run HTTPS URL unavailable" >&2; exit 1; }

READY=0
for _ in $(seq 1 90); do
  BODY="$(curl --fail --silent --show-error "$URL/ready" 2>/dev/null || true)"
  if node -e '
    try {
      const v=JSON.parse(process.argv[1]);
      process.exit(v.ok===true && v.revision===process.argv[2] ? 0 : 1);
    } catch { process.exit(1); }
  ' "$BODY" "$REVISION"; then
    READY=1
    break
  fi
  sleep 1
done
[[ "$READY" == "1" ]] || { echo "managed remote control plane did not become ready" >&2; exit 1; }

gcloud compute routers create "$ROUTER"   --project "$PROJECT"   --region "$REGION"   --network default   --quiet >/dev/null
ROUTER_CREATED=1

gcloud compute routers nats create "$NAT"   --project "$PROJECT"   --router "$ROUTER"   --region "$REGION"   --nat-all-subnet-ip-ranges   --auto-allocate-nat-external-ips   --quiet >/dev/null
NAT_CREATED=1

gcloud compute instances create "$VM"   --project "$PROJECT"   --zone "$ZONE"   --machine-type e2-small   --network default   --no-address   --image-family debian-12   --image-project debian-cloud   --boot-disk-size 20GB   --scopes cloud-platform   --metadata "handoff-control-url=$URL,handoff-revision=$REVISION,handoff-worker-image=$WORKER_IMAGE"   --metadata-from-file "startup-script=$CONTEXT/experiments/hosted-worker-topology/gce-remote-worker-startup.sh,handoff-private-key-b64=$PRIVATE_KEY_B64_FILE"   --quiet >/dev/null
VM_CREATED=1

EXTERNAL_IP="$(gcloud compute instances describe "$VM" --project "$PROJECT" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
[[ -z "$EXTERNAL_IP" ]] || { echo "remote worker unexpectedly has an external IP" >&2; exit 1; }

DONE=0
for _ in $(seq 1 180); do
  BODY="$(curl --fail --silent --show-error "$URL/acceptance-result" 2>/dev/null || true)"
  if node -e '
    try {
      const v=JSON.parse(process.argv[1]);
      if (v.failure && v.failure !== "none") process.exit(2);
      process.exit(v.acceptanceDone===true && v.remoteBrowserProcessPersistent===true && v.remoteProfilePersistent===true && v.remoteChromiumReady===true && v.remoteWorkerLinux===true ? 0 : 1);
    } catch { process.exit(1); }
  ' "$BODY"; then
    DONE=1
    break
  else
    STATUS=$?
    if [[ "$STATUS" == "2" ]]; then
      echo "remote acceptance control plane reported failure" >&2
      gcloud compute instances get-serial-port-output "$VM" --project "$PROJECT" --zone "$ZONE" --port 1 2>/dev/null | tail -n 80 >&2 || true
      exit 1
    fi
  fi
  sleep 5
done

if [[ "$DONE" != "1" ]]; then
  echo "remote stateful worker acceptance timed out" >&2
  gcloud compute instances get-serial-port-output "$VM" --project "$PROJECT" --zone "$ZONE" --port 1 2>/dev/null | tail -n 100 >&2 || true
  exit 1
fi

node experiments/hosted-worker-topology/verify-managed-remote.mjs "$URL" "$REVISION"
echo "MANAGED_REMOTE_STATEFUL_TOPOLOGY_ACCEPTANCE_OK"
