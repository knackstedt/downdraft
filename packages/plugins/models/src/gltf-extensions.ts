import type { AnimationEvent, MaterialData, MorphTargetData } from "./types";

export interface GLTFExtension {
  [key: string]: unknown;
}

export interface ExtensionProcessingContext {
  textures?: { source?: number; sampler?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  bufferData?: ArrayBuffer[];
}

export function processMaterialExtensions(
  material: MaterialData,
  extensions: GLTFExtension | undefined,
  ctx?: ExtensionProcessingContext,
): MaterialData {
  if (!extensions) return material;

  const result = { ...material };

  // KHR_materials_pbrSpecularGlossiness — convert to metallic-roughness
  const specGloss = extensions["KHR_materials_pbrSpecularGlossiness"] as {
    diffuseFactor?: number[];
    diffuseTexture?: { index: number };
    specularFactor?: number[];
    glossinessFactor?: number;
    specularGlossinessTexture?: { index: number };
  } | undefined;

  if (specGloss) {
    const diffuse = specGloss.diffuseFactor ?? [1, 1, 1, 1];
    const specular = specGloss.specularFactor ?? [1, 1, 1];
    const glossiness = specGloss.glossinessFactor ?? 1;

    result.baseColor = [diffuse[0], diffuse[1], diffuse[2], diffuse[3] ?? 1];
    // Approximate conversion from specular-glossiness to metallic-roughness
    const maxSpec = Math.max(specular[0], specular[1], specular[2]);
    result.metallic = maxSpec > 0.5 ? 1 : 0;
    result.roughness = Math.max(0.05, 1 - glossiness);

    if (specGloss.diffuseTexture && ctx?.textures && ctx.images) {
      const tex = ctx.textures[specGloss.diffuseTexture.index];
      if (tex?.source !== undefined && ctx.images[tex.source]?.uri) {
        result.textureUri = ctx.images[tex.source].uri;
      }
    }
  }

  // KHR_materials_unlit — set metallic to 0, roughness to 1
  if (extensions["KHR_materials_unlit"]) {
    result.metallic = 0;
    result.roughness = 1;
  }

  // KHR_materials_emissive_strength — scale emissive color
  const emissiveStrength = extensions["KHR_materials_emissive_strength"] as {
    emissiveStrength?: number;
  } | undefined;

  if (emissiveStrength?.emissiveStrength && result.emissiveColor) {
    const s = emissiveStrength.emissiveStrength;
    result.emissiveColor = [
      result.emissiveColor[0] * s,
      result.emissiveColor[1] * s,
      result.emissiveColor[2] * s,
    ];
  }

  // KHR_texture_transform — UV transform (stored as metadata, applied in shader)
  const texTransform = extensions["KHR_texture_transform"] as {
    offset?: number[];
    rotation?: number;
    scale?: number[];
    texCoord?: number;
  } | undefined;

  if (texTransform) {
    // Texture transforms are noted but would need shader-level support
    // For now, we just acknowledge the extension exists
  }

  return result;
}

export function processMeshPrimitiveExtensions(
  extensions: GLTFExtension | undefined,
  _ctx?: ExtensionProcessingContext,
): { dracoCompressed: boolean; quantized: boolean } {
  if (!extensions) return { dracoCompressed: false, quantized: false };

  const dracoCompressed = !!extensions["KHR_draco_mesh_compression"];
  const quantized = !!extensions["KHR_mesh_quantization"];

  return { dracoCompressed, quantized };
}

export interface GLTFMorphTarget {
  input: string;
  output: string;
  interpolation?: "LINEAR" | "STEP" | "CUBICSPLINE";
}

export interface GLTFMorphTargetData {
  targets: Array<{
    POSITION?: number;
    NORMAL?: number;
  }>;
  targetNames?: string[];
}

export function parseMorphTargets(
  primitive: { targets?: Array<{ POSITION?: number; NORMAL?: number }> },
  extras: { targetNames?: string[] } | undefined,
  accessorData: Map<number, Float32Array>,
  vertexCount: number,
): MorphTargetData[] {
  if (!primitive.targets || primitive.targets.length === 0) return [];

  const result: MorphTargetData[] = [];
  for (let i = 0; i < primitive.targets.length; i++) {
    const target = primitive.targets[i];
    const name = extras?.targetNames?.[i] ?? `morph_${i}`;

    let deltaPositions: Float32Array | undefined;
    let deltaNormals: Float32Array | undefined;

    if (target.POSITION !== undefined) {
      const data = accessorData.get(target.POSITION);
      if (data) {
        deltaPositions = data;
      }
    }

    if (target.NORMAL !== undefined) {
      const data = accessorData.get(target.NORMAL);
      if (data) {
        deltaNormals = data;
      }
    }

    if (deltaPositions) {
      result.push({ name, deltaPositions, deltaNormals });
    }
  }

  return result;
}

export function parseAnimationEvents(
  extras: { events?: Array<{ time: number; type: string; payload?: Record<string, unknown> }> } | undefined,
): AnimationEvent[] {
  if (!extras?.events || !Array.isArray(extras.events)) return [];

  return extras.events.map((e): AnimationEvent => ({
    time: e.time,
    type: e.type,
    ...(e.payload !== undefined ? { payload: e.payload } : {}),
  }));
}

export function getSupportedExtensions(): string[] {
  return [
    "KHR_materials_pbrSpecularGlossiness",
    "KHR_materials_unlit",
    "KHR_materials_emissive_strength",
    "KHR_texture_transform",
    "KHR_mesh_quantization",
  ];
}

export function isExtensionSupported(name: string): boolean {
  return getSupportedExtensions().includes(name);
}
