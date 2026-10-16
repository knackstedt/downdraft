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

# The lib resolves its own deps via DT_RPATH ($ORIGIN/lib); the spawned
# WPEWebProcess/WPENetworkProcess children instead find the vendored libs
# through the merged /usr/lib/x86_64-linux-gnu below (system files win on
# conflicts). LD_LIBRARY_PATH must NOT be exported here — it would leak
# the vendored wayland/GL stack into the host game process and break
# wgpu surface creation.
exec unshare -rm --propagation private bash -c '
  DIST="$1"; shift
  # Overlay: merged view = system dir + vendored dirs (system wins on
  # conflicts; wpe-webkit-2.0 and the WPE-only libs exist only in the
  # vendor sides).
  mount -t overlay overlay \
    -o "lowerdir=/usr/lib/x86_64-linux-gnu:$DIST/libexec:$DIST/lib" \
    /usr/lib/x86_64-linux-gnu
  mount -t overlay overlay \
    -o "lowerdir=/usr/share:$DIST/share" \
    /usr/share
  exec "$@"
' _ "$DIST" "$@"
