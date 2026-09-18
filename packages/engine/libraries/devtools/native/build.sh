#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/dist"
mkdir -p "$OUT_DIR"

echo "[devtools-native] Building downdraft-devtools (egui)..."
cargo build --release
cp "target/release/libdowndraft_devtools.so" "$OUT_DIR/" 2>/dev/null || true
# Also leave a copy next to src for convenience during dev.
cp "target/release/libdowndraft_devtools.so" "$SCRIPT_DIR/" 2>/dev/null || true
echo "[devtools-native] Built -> $OUT_DIR/libdowndraft_devtools.so"
