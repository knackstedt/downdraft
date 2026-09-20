export interface MorphTargetData {
  name: string;
  deltaPositions: Float32Array;
  deltaNormals?: Float32Array;
}

export interface MeshData {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  materialIndex?: number;
  joints?: Uint8Array | Uint16Array | Uint32Array; // 4 bone indices per vertex
  weights?: Float32Array; // 4 bone weights per vertex (normalized)
  morphTargets?: MorphTargetData[];
  morphTargetNames?: string[];
  /** KHR_materials_variants: per-primitive variant → material mappings. */
  variantMappings?: { variant: number; material: number }[];
}

export interface TextureTransform {
  offset: [number, number];
  rotation: number;
  scale: [number, number];
  texCoord?: number;
}

export interface MaterialData {
  name: string;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  textureUri?: string;
  textureData?: ArrayBuffer | null;
  normalTextureUri?: string;
  /** Embedded normal texture data (from bufferView). */
  normalTextureData?: ArrayBuffer | null;
  emissiveColor?: [number, number, number];
  /** KHR_texture_transform applied to the baseColor texture (UV transform). */
  textureTransform?: TextureTransform;
  /** KHR_texture_transform for the normal texture, if present. */
  normalTextureTransform?: TextureTransform;
  /** KHR_texture_transform for the emissive texture, if present. */
  emissiveTextureTransform?: TextureTransform;
}

export interface AnimationChannel {
  targetNode: string;
  path: "translation" | "rotation" | "scale" | "weights";
  keyframeTimes: Float32Array;
  keyframeValues: Float32Array;
  interpolation: "LINEAR" | "STEP" | "CUBICSPLINE";
}

export interface AnimationEvent {
  time: number;
  type: string;
  payload?: Record<string, unknown>;
}

export interface AnimationData {
  name: string;
  duration: number;
  channels: AnimationChannel[];
  sourceRestRotations?: Map<string, [number, number, number, number]>;
  sourcePreRotations?: Map<string, [number, number, number, number]>;
  /** Source-node rest translations (Lcl Translation) keyed by node name —
   *  used by retargeting to compute rest bone directions. */
  sourceRestTranslations?: Map<string, [number, number, number]>;
}

export interface ModelNode {
  name: string;
  children?: number[];
  /** Index of the primary mesh for this node (first material split). */
  mesh?: number;
  /** All mesh indices owned by this node, including multi-material splits.
   *  For single-material nodes this is `[mesh]`. For multi-material FBX
   *  geometries (split into one MeshData per material), this contains every
   *  split so renderers can draw the full geometry. Undefined when the node
   *  has no mesh. */
  meshes?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  nodeIndex?: number;
  /** KHR_lights_punctual: index into ModelData.lights. */
  lightIndex?: number;
}

export interface BoneData {
  name: string;
  nodeIndex: number;
  parentIndex: number;
  inverseBindMatrix: Float32Array; // 16 floats (mat4, column-major)
  restTranslation: [number, number, number];
  restRotation: [number, number, number, number];
  restScale: [number, number, number];
  /** For root bones (parentIndex < 0) with non-bone ancestors in the FBX
   *  hierarchy, this is the composed world transform of those ancestors.
   *  Applied in computeSkinMatrices so the root bone's world matrix matches
   *  the TransformLink. Undefined when no non-bone ancestors exist. */
  rootAncestorMatrix?: Float32Array;
}

export interface SkinData {
  bones: BoneData[];
  boneNameToIndex: Map<string, number>;
  /**
   * The 4×4 normalization transform (column-major) that was applied to mesh
   * vertices during normalization. The animator must conjugate skin matrices
   * with this (T * skinMatrix * T^-1) so that skinned vertices, which were
   * transformed by T, are mapped to the correct normalized world positions.
   * Identity (or undefined) when no normalization was applied or the model
   * has no skin.
   */
  normalizationMatrix?: Float32Array;
  /** Native up-axis of the skeleton's bone space (the space rest transforms
   *  and animation tracks live in, before normalizationMatrix conjugation).
   *  Retargeting must convert source-space deltas into this space. Defaults
   *  to "z" when absent for backward compatibility with rigs authored before
   *  this field existed. */
  skeletonUpAxis?: "y" | "z";
}

export interface PunctualLightData {
  type: "directional" | "point" | "spot";
  color?: [number, number, number];
  intensity?: number;
  range?: number;
  spot?: {
    innerConeAngle: number;
    outerConeAngle: number;
  };
}

export interface ModelData {
  meshes: MeshData[];
  name: string;
  format: ModelFormat;
  materials?: MaterialData[];
  animations?: AnimationData[];
  nodes?: ModelNode[];
  skin?: SkinData;
  morphTargetNames?: string[];
  /** KHR_materials_variants: variant names indexed by variant id. */
  materialVariants?: string[];
  /** KHR_lights_punctual: lights referenced by nodes via lightIndex. */
  lights?: PunctualLightData[];
  /** Non-fatal warnings collected during parsing (e.g. skipped primitives). */
  warnings?: string[];
  /** Source asset's up-axis as detected by the parser. "y" or "z". Engine is Y-up. */
  sourceUpAxis?: "y" | "z";
  /** Source asset's unit system as detected by the parser. Engine uses meters. */
  sourceUnits?: "meters" | "centimeters" | "inches" | "millimeters" | "units";
  /** FBX raw UnitScaleFactor (units per centimeter). Used for precise unit conversion. */
  sourceUnitScaleFactor?: number;
  /** Computed axis-aligned bounding box of all meshes (min/max corners). */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  /** Normalization warnings (e.g. auto-fit triggered, extreme scale detected). */
  normalizationWarnings?: string[];
}

export function getMaterialVariant(model: ModelData, name: string): number {
  if (!model.materialVariants) return -1;
  return model.materialVariants.indexOf(name);
}

export type ModelFormat = "obj" | "gltf" | "glb" | "fbx" | "dae" | "stl" | "ply" | "3ds";

export function detectFormat(filename: string): ModelFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".obj")) return "obj";
  if (lower.endsWith(".gltf")) return "gltf";
  if (lower.endsWith(".glb")) return "glb";
  if (lower.endsWith(".fbx")) return "fbx";
  if (lower.endsWith(".dae")) return "dae";
  if (lower.endsWith(".stl")) return "stl";
  if (lower.endsWith(".ply")) return "ply";
  if (lower.endsWith(".3ds")) return "3ds";
  return null;
}
