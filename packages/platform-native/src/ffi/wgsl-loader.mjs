// Node loader for .wgsl?raw and .wgsl imports (replaces Bun.plugin loaders).
// Register with: node --import ./packages/platform-native/src/ffi/wgsl-loader.mjs

import { register } from "node:module";

register("./wgsl-loader-impl.mjs", import.meta.url);
