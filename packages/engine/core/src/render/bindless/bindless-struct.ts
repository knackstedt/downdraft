// ============================================================================
// BindlessMaterialStruct — single source of truth for the BindlessMaterial
// WGSL struct layout.
//
// Both material-manager.ts (TS buffer writes) and bindless.wgsl.ts (WGSL chunk
// emission) import this. The struct is 80 bytes / 20 floats — matching the
// previous hand-mirrored layout — so existing SSBOs and bind groups are
// byte-compatible.
// ============================================================================

import { f32, u32, vec2f, vec4f, wgsl, type WgslStruct } from "@downdraft/engine/shader-graph";

/**
 * WGSL `struct BindlessMaterial` — 80 bytes (20 floats), std140-friendly.
 *
 * Texture handles are u32 packed as (arrayIndex << 16) | layerIndex. The
 * `aoEmissiveTex` slot packs ao (low 16) + emissive (high 16) into one u32.
 */
export const BindlessMaterialStruct: WgslStruct = wgsl.struct("BindlessMaterial", {
  baseColor: vec4f,
  roughness: f32,
  metallic: f32,
  emissiveIntensity: f32,
  hasTexTransform: f32,
  // Packed u32 texture handles (arrayIndex<<16 | layerIndex).
  albedoTex: u32,
  normalTex: u32,
  metallicRoughnessTex: u32,
  aoEmissiveTex: u32,
  // KHR_texture_transform UV transform (applied in vertex shader).
  texOffset: vec2f,
  texScale: vec2f,
  texRotation: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
});

/** Byte size of one BindlessMaterial (80). Re-exported for back-compat. */
export const BINDLESS_MATERIAL_SIZE = BindlessMaterialStruct.size;
/** Float count of one BindlessMaterial (20). */
export const BINDLESS_MATERIAL_FLOATS = BindlessMaterialStruct.floatCount;
