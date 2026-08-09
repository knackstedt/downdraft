// Material sub-barrel — re-exports all material-related items.
export { MaterialCompiler } from "./compiler";
export { compileGraphToMaterial, compileGraphToMaterialWithGraph, compileUIGraphToMaterial, compileVariant, enumerateVariants, uiGraphToMaterialGraph } from "./graph-bridge";
export type { GraphToMaterialOptions, UIConnection, UINodeData } from "./graph-bridge";
export { MaterialLibrary } from "./library";
export { BlendMode, CullMode, Material, MaterialType } from "./material";
export type { MaterialDefinition, MaterialTexture, MaterialUniform } from "./material";
export { DEFAULT_VARIANT_FLAGS, permutationCount, variantKey, withVariant } from "./variants";
export type { AlphaMode, MaterialVariantFlags } from "./variants";
