#!/usr/bin/env bash
# Run a command with the vendored WPE runtime live at its hardcoded system
# paths, inside a user+mount namespace. libWPEWebKit's Debian build spawns
# WPEWebProcess / WPENetworkProcess / WPEGPUProcess from
# /usr/lib/x86_64-linux-gnu/wpe-webkit-2.0 — this presents the staged
# libexec tree there (and the inspector gresource under /usr/share) via
# read-only overlay mounts, so no host dirs are created and nothing leaks
# outside the namespace.
#
# Usage:
#   scripts/run-wpe.sh <dist-dir> <command...>
#   scripts/run-wpe.sh packages/engine/libraries/webui/native-wpe/dist/linux-x64 \
#     bun packages/engine/libraries/webui/webui-spike.ts wpe
set -euo pipefail

DIST="$(realpath "$1")"; shift
[ -d "$DIST/libexec/wpe-webkit-2.0" ] || {
  echo "run-wpe: no libexec/wpe-webkit-2.0 under $DIST" >&2; exit 1; }

# The lib resolves its own deps via DT_RPATH ($ORIGIN/lib), but the
# spawned WPEWebProcess/WPENetworkProcess children can't — they inherit
# env instead.
export LD_LIBRARY_PATH="$DIST/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

exec unshare -rm --propagation private bash -c '
  DIST="$1"; shift
  # Overlay: merged view = system dir + vendored dir (system wins on
  # conflicts; wpe-webkit-2.0 exists only in the vendor side).
  mount -t overlay overlay \
    -o "lowerdir=/usr/lib/x86_64-linux-gnu:$DIST/libexec" \
    /usr/lib/x86_64-linux-gnu
  mount -t overlay overlay \
    -o "lowerdir=/usr/share:$DIST/share" \
    /usr/share
  exec "$@"
' _ "$DIST" "$@"
