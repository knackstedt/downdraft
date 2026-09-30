// ============================================================================
// native-crates.mjs — shared registry of the shippable Rust cdylibs.
//
// Used by build-native.mjs (cargo build + staging), fetch-native.mjs
// (artifact bundle layout), and stage-native-packages.mjs (npm platform
// packages). Keep this in sync with the workspace members in root Cargo.toml.
//
// Not listed: downdraft-blitz-shell (rlib, linked into blitz-app — never
// shipped), bakeoff-blitz-ui (wasm testbed), raw-input (deleted with the
// Electron input path), audio-kira (dormant — doesn't compile at HEAD; JS
// audio backend is the active path).
// ============================================================================

export const CRATES = [
  {
    pkg: "downdraft-platform",
    lib: "downdraft_platform",
    dir: "packages/platform-native/native-rs",
    // Platform libs stage into packages/platform-native/native/<plat>-<arch>/
    // — the same dir the artifact bundle and npm platform packages feed.
    dest: "packages/platform-native/native",
    flatCopy: false,
  },
  { pkg: "downdraft-physics", lib: "downdraft_physics", dir: "packages/engine/libraries/physics-native/native", dest: "packages/engine/libraries/physics-native/native/dist", flatCopy: true },
  { pkg: "downdraft-devtools", lib: "downdraft_devtools", dir: "packages/engine/libraries/devtools/native", dest: "packages/engine/libraries/devtools/native/dist", flatCopy: true },

  { pkg: "downdraft-blitz-osr", lib: "downdraft_blitz_osr", dir: "packages/engine/libraries/blitz-ui/native-osr", dest: "packages/engine/libraries/blitz-ui/native-osr/dist", flatCopy: true },
];

// node (process.platform-process.arch) ↔ rust target triples.
export const NODE_TO_RUST = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
export const RUST_TO_NODE = Object.fromEntries(Object.entries(NODE_TO_RUST).map(([k, v]) => [v, k]));

export function libFileName(libName, nodePlat) {
  if (nodePlat.startsWith("win32")) return `${libName}.dll`;
  if (nodePlat.startsWith("darwin")) return `lib${libName}.dylib`;
  return `lib${libName}.so`;
}
