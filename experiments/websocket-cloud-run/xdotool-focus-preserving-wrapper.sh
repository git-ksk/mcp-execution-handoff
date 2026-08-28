#!/bin/sh
set -eu

REAL_XDOTOOL=/usr/bin/xdotool
SKIP_MARKER=/tmp/handoff-xdotool-activation-skipped

if [ "${1:-}" = "windowactivate" ]; then
  requested=""
  for arg in "$@"; do
    case "$arg" in
      ''|--*) ;;
      *) requested="$arg" ;;
    esac
  done
  case "$requested" in
    ''|*[!0-9]*) ;;
    *)
      active="$($REAL_XDOTOOL getactivewindow 2>/dev/null || true)"
      focused="$($REAL_XDOTOOL getwindowfocus 2>/dev/null || true)"
      if [ "$active" = "$requested" ]; then
        if [ "$focused" = "$requested" ]; then
          : > "$SKIP_MARKER"
          exit 0
        fi
        requested_pid="$($REAL_XDOTOOL getwindowpid "$requested" 2>/dev/null || true)"
        focused_pid="$($REAL_XDOTOOL getwindowpid "$focused" 2>/dev/null || true)"
        if [ -n "$requested_pid" ] && [ "$requested_pid" = "$focused_pid" ]; then
          : > "$SKIP_MARKER"
          exit 0
        fi
      fi
      ;;
  esac
fi

exec "$REAL_XDOTOOL" "$@"
