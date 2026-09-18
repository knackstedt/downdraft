#!/bin/bash
set -e

TARGETS=${1:-"all"}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

build_target() {
    local target="$1"
    local out_dir="$SCRIPT_DIR/dist"
    mkdir -p "$out_dir"

    echo "[audio-native] Building for $target..."

    case "$target" in
        *linux*)
            cargo build --release --target "$target"
            cp "target/$target/release/libdowndraft_audio.so" "$out_dir/"
            ;;
        *darwin*)
            cargo build --release --target "$target"
            cp "target/$target/release/libdowndraft_audio.dylib" "$out_dir/"
            ;;
        *windows*)
            cargo build --release --target "$target"
            cp "target/$target/release/downdraft_audio.dll" "$out_dir/"
            ;;
        *)
            echo "[audio-native] Unknown target: $target"
            return 1
            ;;
    esac
    echo "[audio-native] Built $target -> $out_dir"
}

if [ "$TARGETS" = "all" ]; then
    HOST=$(rustc -vV | grep host | awk '{print $2}')
    build_target "$HOST"
else
    for target in $TARGETS; do
        build_target "$target"
    done
fi

echo "[audio-native] Build complete."
