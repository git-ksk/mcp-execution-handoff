#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=${1:-"$root/dist/native/mcp-handoff-linux-atspi-helper"}
cc_bin=${CC:-cc}

mkdir -p "$(dirname -- "$out")"
flags=$(pkg-config --cflags --libs atspi-2 gobject-2.0 glib-2.0)
# shellcheck disable=SC2086
"$cc_bin" \
  -std=c11 -O2 -Wall -Wextra -Werror -pedantic \
  -D_POSIX_C_SOURCE=200809L -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE \
  "$root/native/linux-atspi-editable-helper.c" \
  -Wl,-z,relro,-z,now -pie $flags \
  -o "$out"
chmod 0755 "$out"
