// ============================================================================
// @downdraft/asset-bake — Node-only asset optimization / bake pipeline.
// ============================================================================
//
// Produces GPU-ready assets from source art at build/dev time:
//   - glTF/GLB → meshopt-compressed, deduped, welded, pruned, quantized GLB
//     with embedded textures transcoded to Basis Universal KTX2
//     (KHR_texture_basisu + EXT_meshopt_compression).
//   - Audio (wav/mp3/ogg) → normalized target container/codec/bitrate.
//
// The runtime already decodes all of these:
//   - meshopt  → packages/libraries/models/src/codecs/meshopt-codec.ts
//   - basisu   → packages/libraries/models/src/codecs/basisu-codec.ts
//                (upgraded to transcode via @h00w/basis-universal-transcoder)
//   - KTX2     → packages/core/src/assets/loader-texture.ts
//
// This package is heavy (gltf-transform + meshoptimizer wasm + basisu encoder
// wasm + jimp) and is only ever imported from the Vite plugin's `load()` hook
// (Node context). It must never be imported into the renderer bundle.
//

export { bakeAsset, bakeAssetFromBytes } from "./bake";
export { bakeGltf } from "./bake-gltf";
export { bakeAudio } from "./bake-audio";
export { BakeCache } from "./cache";
export {
  resolveOptions,
  DEFAULT_BAKE_OPTIONS,
  BAKE_CONFIG_VERSION,
  type AssetBakeOptions,
  type ResolvedBakeOptions,
  type BakeResult,
  type GltfBakeOptions,
  type TextureBakeOptions,
  type AudioBakeOptions,
} from "./config";
