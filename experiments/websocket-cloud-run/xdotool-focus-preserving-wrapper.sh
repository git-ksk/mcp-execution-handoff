#!/bin/sh
set -eu

REAL_XDOTOOL=/usr/bin/xdotool

# Acceptance-only A/B: avoid EWMH top-level reactivation while still reasserting the exact X11
# keyboard focus required by XTEST key delivery. Keep every other xdotool operation unchanged.
# This wrapper is diagnostic-only and is removed once the production focus invariant is fixed.
if [ "${1:-}" = "windowactivate" ]; then
  shift
  exec "$REAL_XDOTOOL" windowfocus "$@"
fi

exec "$REAL_XDOTOOL" "$@"
