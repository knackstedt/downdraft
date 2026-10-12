#!/usr/bin/env bash
# ============================================================================
# build-wpe.sh — build/stage the WPE (embedded WebKit) runtime into
# libraries/webui/vendor/wpe-<plat>/ for the native-wpe crate.
#
# WPE is not packaged on Ubuntu, so we build inside the WebKit SDK
# container (ghcr.io/webkit/wkdev-sdk — the image the WebKit project
# ships for WebKitGTK/WPE development). The container produces an
# installable prefix we hoist into vendor/wpe-<plat>/:
#
#   wpe-<plat>/lib/        libglib-2.0, libgobject-2.0, libgio-2.0,
#                          libsoup-3.0, libwpe-1.0/libWPEWebKit-2.0, …
#   wpe-<plat>/libexec/    WPEWebProcess, WPENetworkProcess, …
#   wpe-<plat>/lib/gio/    GIO platform modules (wpe-platform impls)
#   wpe-<plat>/include/    headers the native-wpe crate binds
#
# Requires: docker (or podman). Runs ~30-60 min the first time.
#
#   bash build-wpe.sh                    # host platform, full build
#   bash build-wpe.sh --shell            # drop into the SDK container shell
#
# Android WPE does NOT come from this script — wpe-android ships Maven
# artifacts; Phase 5 fetches those separately (scripts/fetch-wpe-android.mjs).
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENDOR_DIR="$(realpath "$SCRIPT_DIR/../vendor")"
SDK_IMAGE="${DD_WPE_SDK_IMAGE:-ghcr.io/webkit/wkdev-sdk:latest}"
PLAT="${DD_WPE_PLAT:-linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')}"
DEST="$VENDOR_DIR/wpe-$PLAT"

DOCKER="$(command -v docker || command -v podman || true)"
if [ -z "$DOCKER" ]; then
  echo "[build-wpe] docker/podman not found — the WebKit SDK build needs a container runtime" >&2
  exit 1
fi

mkdir -p "$VENDOR_DIR"

if [ "${1:-}" = "--shell" ]; then
  exec "$DOCKER" run --rm -it \
    -v "$VENDOR_DIR:/out" \
    "$SDK_IMAGE" bash
fi

echo "[build-wpe] image: $SDK_IMAGE"
echo "[build-wpe] dest:  $DEST"

# Inside the container:
#   1. The wkdev SDK ships jhbuild + a prepared WebKit checkout layout.
#   2. build-webkit --wpe compiles WPEWebKit + WPEPlatform.
#   3. cmake --install stages into /out/prefix.
# The SDK's layout shifts between images; the script targets the documented
# `wkdev-setup-default-clang` + `build-webkit` flow and falls back to a
# manual jhbuild build when the helper isn't present.
"$DOCKER" run --rm \
  -v "$VENDOR_DIR:/out" \
  -e DEST="/out/wpe-$PLAT" \
  "$SDK_IMAGE" bash -lc '
    set -euo pipefail
    cd ~

    # 1. Prepare a WebKit checkout if the SDK did not already materialize one.
    if [ ! -d "$HOME/WebKit" ] && [ ! -d "/webkit" ]; then
      echo "[wpe] cloning WebKit (shallow, wpe-relevant history)…"
      git clone --depth 1 --filter=blob:none https://github.com/WebKit/WebKit.git "$HOME/WebKit" || true
    fi
    SRC_DIR="$HOME/WebKit"
    [ -d "$SRC_DIR" ] || SRC_DIR=/webkit

    # 2. Build WPE in release mode with the SDK toolchain.
    if command -v wkdev-setup-default-clang >/dev/null 2>&1; then
      wkdev-setup-default-clang || true
    fi
    export CMAKE_BUILD_TYPE=Release
    "$SRC_DIR/Tools/Scripts/build-webkit" --wpe --release \
      --cmakeargs="-DENABLE_INTROSPECTION=OFF -DENABLE_DOCUMENTATION=OFF -DENABLE_BUBBLEWRAP_SANDBOX=OFF -DENABLE_MINIBROWSER=OFF"

    # 3. Install into the output prefix.
    BUILD_DIR=$(ls -d "$HOME"/WebKitBuild/WPE/Release /webkit/WebKitBuild/WPE/Release 2>/dev/null | head -1)
    cmake --install "$BUILD_DIR" --prefix "$DEST"

    # 4. Collect runtime deps the install tree references but doesn'\''t own
    #    (glib/soup/gio stack ships inside the SDK image).
    echo "[wpe] installed → $DEST"
    find "$DEST" -maxdepth 3 -type d | sort
  '

echo "[build-wpe] staged → $DEST"
echo "[build-wpe] next: rebuild native-wpe — bun run build:native --pkg=downdraft-webui-wpe"
