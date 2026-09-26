#!/usr/bin/env bash
set -euo pipefail

for tool in git gcloud curl node; do command -v "$tool" >/dev/null; done

REVISION="$(git rev-parse HEAD)"
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "exact git revision required" >&2; exit 1; }
PROJECT="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${HANDOFF_MANAGED_SPLIT_REGION:-us-central1}"
REPOSITORY="${HANDOFF_MANAGED_SPLIT_REPOSITORY:-cloud-run-source-deploy}"
SERVICE="${HANDOFF_MANAGED_SPLIT_SERVICE:-handoff-hosted-split-${REVISION:0:8}}"
[[ -n "$PROJECT" && "$PROJECT" != "(unset)" ]] || { echo "configured Google Cloud project required" >&2; exit 1; }

gcloud artifacts repositories describe "$REPOSITORY" --project "$PROJECT" --location "$REGION" >/dev/null
if gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  echo "refusing to overwrite existing acceptance service" >&2
  exit 1
fi

TMP="$(mktemp -d)"
PRIVATE_KEY="$TMP/worker-private.pem"
PUBLIC_KEY_FILE="$TMP/worker-public.txt"
CONTEXT="$TMP/context"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPOSITORY}/mcp-execution-handoff-hosted-split:${REVISION}"
URL=""

cleanup() {
  set +e
  if [[ -n "$URL" ]]; then
    gcloud run services delete "$SERVICE" --project "$PROJECT" --region "$REGION" --quiet >/dev/null 2>&1
  fi
  gcloud artifacts docker images delete "$IMAGE" --project "$PROJECT" --quiet >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

node - "$PRIVATE_KEY" "$PUBLIC_KEY_FILE" <<'NODE'
const fs = require("node:fs");
const { generateKeyPairSync } = require("node:crypto");
const [privatePath, publicPath] = process.argv.slice(2);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
fs.writeFileSync(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
fs.writeFileSync(publicPath, publicKey.export({ format: "der", type: "spki" }).toString("base64url"), { mode: 0o600 });
NODE
PUBLIC_KEY="$(cat "$PUBLIC_KEY_FILE")"

mkdir -p "$CONTEXT"
git archive "$REVISION" | tar -x -C "$CONTEXT"

gcloud builds submit "$CONTEXT"   --project "$PROJECT"   --config "$CONTEXT/experiments/hosted-worker-topology/cloudbuild-managed-split.yaml"   --substitutions "_IMAGE=$IMAGE" >/dev/null

gcloud run deploy "$SERVICE"   --project "$PROJECT"   --region "$REGION"   --image "$IMAGE"   --allow-unauthenticated   --ingress all   --concurrency 1   --max-instances 1   --min-instances 0   --cpu 1   --memory 512Mi   --timeout 900   --set-env-vars "HANDOFF_ACCEPTANCE_REVISION=$REVISION,HANDOFF_ACCEPTANCE_WORKER_PUBLIC_KEY=$PUBLIC_KEY"   --quiet >/dev/null

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
[[ "$READY" == "1" ]] || { echo "managed split control plane did not become ready" >&2; exit 1; }

node experiments/hosted-worker-topology/managed-local-worker.mjs "$URL" "$PRIVATE_KEY" "$REVISION"
node experiments/hosted-worker-topology/verify-managed-split.mjs "$URL" "$REVISION"

echo "MANAGED_SPLIT_TOPOLOGY_ACCEPTANCE_OK"
