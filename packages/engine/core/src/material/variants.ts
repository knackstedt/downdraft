// Material variant flags — drive hybrid shader permutations.
//
// Expensive toggles (shadowCaster, skinning, alphaMode, morph, instanced) are
// compile-time permutations: each distinct combination produces a separate
// WGSL module + render pipeline. Cheap toggles (fog) stay a uniform-driven
// dynamic branch inside a single permutation, so they are NOT part of the
// variant key.

export type AlphaMode = "opaque" | "clip" | "blend";

export interface MaterialVariantFlags {
  /** Depth-only shadow-caster pass (no color targets). */
  shadowCaster: boolean;
  /** Skinned vertex deformation (bone matrices). */
  skinning: boolean;
  /** Alpha mode — opaque/clip/blend produce distinct pipelines. */
  alphaMode: AlphaMode;
  /** Morph-target vertex deformation. */
  morph: boolean;
  /** Instanced draw (instance_index vertex path). */
  instanced: boolean;
  /** Fog — dynamic branch, NOT part of the variant key. */
  fog: boolean;
}

export const DEFAULT_VARIANT_FLAGS: MaterialVariantFlags = {
  shadowCaster: false,
  skinning: false,
  alphaMode: "opaque",
  morph: false,
  instanced: false,
  fog: true,
};

/**
 * Deterministic string key for the compile-time permutation subset of the
 * variant flags. Fog is intentionally excluded (dynamic branch).
 */
export function variantKey(flags: MaterialVariantFlags): string {
  return [
    flags.shadowCaster ? "sc" : "-",
    flags.skinning ? "sk" : "-",
    flags.alphaMode,
    flags.morph ? "mo" : "-",
    flags.instanced ? "in" : "-",
  ].join(":");
}

/** Number of distinct compile-time permutations for a flag set (excluding fog). */
export function permutationCount(): number {
  // shadowCaster(2) * skinning(2) * alphaMode(3) * morph(2) * instanced(2) = 48
  return 2 * 2 * 3 * 2 * 2;
}

/** Merge a partial override onto a base flag set. */
export function withVariant(
  base: MaterialVariantFlags,
  override: Partial<MaterialVariantFlags>,
): MaterialVariantFlags {
  return { ...base, ...override };
}
