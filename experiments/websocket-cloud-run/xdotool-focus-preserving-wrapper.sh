#!/bin/sh
set -eu

REAL_XDOTOOL=/usr/bin/xdotool

# Acceptance-only A/B: suppress every EWMH activation request while keeping all other xdotool
# operations unchanged. This proves whether Chromium's key route is being perturbed by top-level
# reactivation; it is not a production fallback and is removed once the focus invariant is fixed.
if [ "${1:-}" = "windowactivate" ]; then
  exit 0
fi

exec "$REAL_XDOTOOL" "$@"
