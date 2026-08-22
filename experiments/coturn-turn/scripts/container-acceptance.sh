#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
SUFFIX=$$
NETWORK="handoff-coturn-accept-$SUFFIX"
TURN_CONTAINER="handoff-coturn-accept-$SUFFIX"
SECRET_FILE=$(mktemp "${TMPDIR:-/tmp}/handoff-coturn-secret.XXXXXX")
COTURN_IMAGE='coturn/coturn@sha256:0feee4fc1f45c7c053c8fee3e1ab941b1a1b9a0429bc01e18126735410770bfd'
NODE_IMAGE='node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3'

cleanup() {
  docker rm -f "$TURN_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$SECRET_FILE"
}
trap cleanup EXIT INT TERM

umask 077
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$SECRET_FILE"
SECRET=$(cat "$SECRET_FILE")

docker network create "$NETWORK" >/dev/null
docker run -d --name "$TURN_CONTAINER" --network "$NETWORK" \
  "$COTURN_IMAGE" \
  -n --log-file=stdout --fingerprint --use-auth-secret --static-auth-secret="$SECRET" \
  --realm=handoff-acceptance.invalid --min-port=49160 --max-port=49179 --no-tls --no-dtls >/dev/null

attempt=0
until docker logs "$TURN_CONTAINER" 2>&1 | grep -q 'Relay ports initialization done'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    echo 'coturn acceptance server did not become ready' >&2
    exit 1
  fi
  sleep 0.1
done

docker run --rm --network "$NETWORK" \
  -v "$ROOT:/work" -w /work \
  -e HANDOFF_COTURN_TURN_URL="turn:$TURN_CONTAINER:3478?transport=udp" \
  -e MCP_HANDOFF_COTURN_SHARED_SECRET="$SECRET" \
  "$NODE_IMAGE" node experiments/coturn-turn/scripts/relay-acceptance.mjs
