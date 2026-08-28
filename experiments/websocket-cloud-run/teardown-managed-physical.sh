#!/usr/bin/env bash
set -euo pipefail

command -v gcloud >/dev/null

PROJECT="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${HANDOFF_ACCEPTANCE_REGION:-us-central1}"
SERVICE="${HANDOFF_ACCEPTANCE_SERVICE:-}"

if [[ -z "$PROJECT" || "$PROJECT" == "(unset)" ]]; then
  echo "Set GOOGLE_CLOUD_PROJECT or configure a gcloud project" >&2
  exit 1
fi
if [[ -z "$SERVICE" ]]; then
  echo "Set HANDOFF_ACCEPTANCE_SERVICE to the exact temporary service name" >&2
  exit 1
fi
if [[ ! "$SERVICE" =~ ^handoff-managed-[a-z0-9-]+$ ]]; then
  echo "Refusing to delete a service outside the handoff-managed-* acceptance namespace" >&2
  exit 1
fi

gcloud run services delete "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --quiet
