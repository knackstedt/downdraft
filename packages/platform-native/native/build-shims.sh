#!/usr/bin/env bash
# ============================================================================
# build-shims.sh — compile all native shim libraries
#
# Deps: gcc, SDL2 dev headers, SDL2_ttf dev headers, wgpu-native (fetch-native).
# Output: lib*_shim.so in this directory (rpath $ORIGIN/lib for wgpu_native).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p lib

echo "==> wgpu_shim"
gcc -shared -fPIC -O2 -o libwgpu_shim.so wgpu_shim.c \
  -I./include -L./lib -lwgpu_native -lSDL2 -Wl,-rpath,'$ORIGIN/lib'

echo "==> sdl_shim"
gcc -shared -fPIC -O2 -o libsdl_shim.so sdl_shim.c \
  -I./include -L./lib -lwgpu_native -lSDL2 -Wl,-rpath,'$ORIGIN/lib'

echo "==> image_shim"
gcc -shared -fPIC -O2 -o libimage_shim.so image_shim.c

echo "==> font_shim"
gcc -shared -fPIC -O2 -o libfont_shim.so font_shim.c \
  -lSDL2 -lSDL2_ttf

echo "Done. Built: libwgpu_shim.so libsdl_shim.so libimage_shim.so libfont_shim.so"
