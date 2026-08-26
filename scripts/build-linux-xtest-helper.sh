#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=${1:-"$root/dist/native/mcp-handoff-linux-xtest-helper"}
cc_bin=${CC:-cc}

mkdir -p "$(dirname -- "$out")"
"$cc_bin" \
  -std=c11 -O2 -Wall -Wextra -Werror -pedantic \
  -D_POSIX_C_SOURCE=200809L -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE \
  "$root/native/linux-xtest-helper.c" \
  -Wl,-z,relro,-z,now -pie -lX11 -lXtst \
  -o "$out"
chmod 0755 "$out"
