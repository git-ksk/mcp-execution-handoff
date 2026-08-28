#!/usr/bin/env bash
set -euo pipefail

command -v git >/dev/null
command -v gcloud >/dev/null
command -v curl >/dev/null
command -v node >/dev/null

REVISION="$(git rev-parse HEAD)"
if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Unable to resolve an exact git revision" >&2
  exit 1
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${HANDOFF_ACCEPTANCE_REGION:-asia-northeast1}"
IMAGE_REPOSITORY="${HANDOFF_ACCEPTANCE_IMAGE_REPOSITORY:-}"
SERVICE="${HANDOFF_ACCEPTANCE_SERVICE:-handoff-managed-${REVISION:0:8}}"

if [[ -z "$PROJECT" || "$PROJECT" == "(unset)" ]]; then
  echo "Set GOOGLE_CLOUD_PROJECT or configure a gcloud project" >&2
  exit 1
fi
if [[ -z "$IMAGE_REPOSITORY" ]]; then
  echo "Set HANDOFF_ACCEPTANCE_IMAGE_REPOSITORY to a fully qualified Artifact Registry repository" >&2
  echo "Example: asia-northeast1-docker.pkg.dev/PROJECT/REPOSITORY" >&2
  exit 1
fi
if [[ ! "$SERVICE" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]]; then
  echo "HANDOFF_ACCEPTANCE_SERVICE is not a valid Cloud Run service name" >&2
  exit 1
fi
if gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  echo "Refusing to overwrite existing Cloud Run service: $SERVICE" >&2
  exit 1
fi

IMAGE="${IMAGE_REPOSITORY%/}/mcp-execution-handoff-managed:${REVISION}"
TMP_DIR="$(mktemp -d)"
cleanup_archive() { rm -rf "$TMP_DIR"; }
trap cleanup_archive EXIT

git archive "$REVISION" | tar -x -C "$TMP_DIR"

gcloud builds submit "$TMP_DIR" \
  --project "$PROJECT" \
  --config "$TMP_DIR/experiments/websocket-cloud-run/cloudbuild-managed.yaml" \
  --substitutions "_IMAGE=$IMAGE"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --image "$IMAGE" \
  --allow-unauthenticated \
  --ingress all \
  --concurrency 1 \
  --max-instances 1 \
  --min-instances 0 \
  --cpu 1 \
  --memory 2Gi \
  --timeout 900 \
  --set-env-vars "HANDOFF_WSS_PUBLIC_BASE_URL=https://placeholder.invalid,HANDOFF_ACCEPTANCE_REVISION=$REVISION"

URL="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --format='value(status.url)')"
if [[ ! "$URL" =~ ^https:// ]]; then
  echo "Cloud Run did not return an HTTPS service URL" >&2
  exit 1
fi

gcloud run services update "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --update-env-vars "HANDOFF_WSS_PUBLIC_BASE_URL=$URL,HANDOFF_ACCEPTANCE_REVISION=$REVISION"

for _ in $(seq 1 90); do
  BODY="$(curl --fail --silent --show-error "$URL/healthz" 2>/dev/null || true)"
  if node -e '
    try {
      const body = JSON.parse(process.argv[1]);
      process.exit(body.ok === true && body.targetReady === true && body.revision === process.argv[2] ? 0 : 1);
    } catch { process.exit(1); }
  ' "$BODY" "$REVISION"; then
    printf 'HANDOFF_ACCEPTANCE_URL=%s\n' "$URL"
    printf 'HANDOFF_ACCEPTANCE_START=%s/start\n' "$URL"
    printf 'HANDOFF_ACCEPTANCE_REVISION=%s\n' "$REVISION"
    printf 'HANDOFF_ACCEPTANCE_SERVICE=%s\n' "$SERVICE"
    printf 'HANDOFF_ACCEPTANCE_REGION=%s\n' "$REGION"
    exit 0
  fi
  sleep 1
done

echo "Cloud Run acceptance target did not become ready" >&2
exit 1
