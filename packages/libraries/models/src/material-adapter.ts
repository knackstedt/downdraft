// Material adapter — bridges the serialized asset format (MaterialData) to the
// core engine's unified Material surface. MaterialData stays as the on-disk
// glTF/obj material format; this adapter maps it onto a core Material that
// uses the shader-graph pipeline (PBR profile, graph or fallback physical .wgsl).
//
// The game's renderer delegates material upload to the core surface via this
// adapter, retiring the parallel material rendering path.

import { BlendMode, CullMode, DEFAULT_VARIANT_FLAGS, Material, MaterialLibrary, MaterialType, type AlphaMode, type MaterialDefinition } from "@downdraft/core";
import PHYSICAL_WGSL from "@downdraft/core/render/material-types/physical.wgsl?raw" with { type: "text" };
import type { MaterialData } from "./types";

export interface MaterialAdapterOptions {
  /** Material name override. Defaults to MaterialData.name. */
  name?: string;
  /** Target MaterialLibrary to register the material into. */
  library?: MaterialLibrary;
  /** Use a graph-based material (createPBRGraph) instead of the fallback .wgsl. */
  useGraph?: boolean;
}

/**
 * Convert a serialized MaterialData (glTF/obj material) into a core Material.
 *
 * Maps:
 *   baseColor      → baseColor uniform
 *   metallic       → metallic uniform
 *   roughness      → roughness uniform
 *   emissiveColor  → emissive uniform (if present)
 *   textureUri     → albedoMap texture binding
 *   normalTextureUri → normalMap texture binding
 *
 * The resulting Material uses the Physical fallback shader (inlineShaderSource
 * from material-types/physical.wgsl) by default, or a PBR graph if useGraph.
 */
export function materialDataToMaterial(
  md: MaterialData,
  options: MaterialAdapterOptions = {},
): Material {
  const name = options.name ?? md.name;
  const library = options.library;

  // If the library has a graph-based preset and useGraph is set, use it.
  if (options.useGraph && library) {
    const existing = library.get(name);
    if (existing) return existing;
    const graphMat = library.createPBRGraph(name);
    // Apply MaterialData values as uniform overrides.
    graphMat.setUniform("baseColor", md.baseColor);
    graphMat.setUniform("metallic", md.metallic);
    graphMat.setUniform("roughness", md.roughness);
    if (md.emissiveColor) {
      graphMat.setUniform("emissive", md.emissiveColor);
    }
    return graphMat;
  }

  // Determine alpha mode from baseColor alpha and material data.
  const alphaMode: AlphaMode = md.baseColor[3] < 1.0 ? "blend" : "opaque";

  // Default: create a Physical fallback material with MaterialData mapped to uniforms.
  const def: MaterialDefinition = {
    name,
    shader: "material-types/physical.wgsl",
    inlineShaderSource: PHYSICAL_WGSL,
    materialType: MaterialType.Physical,
    uniforms: {
      baseColor: { name: "baseColor", type: "vec4", binding: 0 },
      roughness: { name: "roughness", type: "f32", binding: 1 },
      metallic: { name: "metallic", type: "f32", binding: 2 },
    },
    // Bindless convention: textures are registered into the global
    // texture_2d_array buckets (@group(3)) and sampled via handles in the
    // material SSBO — no per-material texture bindings.
    textures: {},
    blendMode: alphaMode === "blend" ? BlendMode.AlphaBlend : BlendMode.Opaque,
    cullMode: CullMode.Back,
    variantFlags: { ...DEFAULT_VARIANT_FLAGS, alphaMode },
  };

  const material = new Material(def);

  // Apply MaterialData values as uniform overrides.
  material.setUniform("baseColor", md.baseColor);
  material.setUniform("metallic", md.metallic);
  material.setUniform("roughness", md.roughness);
  if (md.emissiveColor) {
    material.setUniform("emissive", md.emissiveColor);
  }

  if (library) {
    library.register(material);
  }

  return material;
}

/**
 * Batch-convert an array of MaterialData into core Materials, registering
 * each into the library. Returns the array of created Materials.
 */
export function materialDataArrayToMaterials(
  materials: MaterialData[],
  library: MaterialLibrary,
  options: Omit<MaterialAdapterOptions, "library" | "name"> = {},
): Material[] {
  return materials.map((md) => materialDataToMaterial(md, { ...options, library }));
}
