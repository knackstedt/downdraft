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
  joints?: Uint8Array;    // 4 bone indices per vertex (uint8, max 255 bones)
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
}

export interface ModelNode {
  name: string;
  children?: number[];
  mesh?: number;
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
}

export interface SkinData {
  bones: BoneData[];
  boneNameToIndex: Map<string, number>;
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
