#!/bin/sh
set -eu

if [ "${1:-}" = "click" ]; then
  has_repeat=0
  has_delay=0
  for arg in "$@"; do
    [ "$arg" = "--repeat" ] && has_repeat=1
    [ "$arg" = "--delay" ] && has_delay=1
  done
  if [ "$has_repeat" -eq 1 ] && [ "$has_delay" -eq 0 ]; then
    shift
    exec /usr/bin/xdotool-real click --delay 10 "$@"
  fi
fi

exec /usr/bin/xdotool-real "$@"
