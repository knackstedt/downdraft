import { assertBounds, assertCount, MAX_VERTEX_COUNT, sanitizeUri } from "@downdraft/core";
import { strFromU8 } from "fflate";
import type { GLTFCodecRegistry } from "./codecs/registry";
import { getDefaultCodecRegistry } from "./codecs/registry";
import { extractTextureTransform, processMaterialExtensions, type ExtensionProcessingContext } from "./gltf-extensions";
import type {
    AnimationChannel,
    AnimationData,
    BoneData,
    MaterialData,
    MeshData,
    ModelData,
    ModelNode,
    PunctualLightData,
    SkinData,
} from "./types";

// --- Extended GLTF JSON types -------------------------------------------------

interface GLTFBufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
  byteStride?: number;
  extensions?: Record<string, unknown>;
}

interface GLTFAccessor {
  bufferView: number;
  byteOffset: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  normalized?: boolean;
}

interface GLTFPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
  material?: number;
  extensions?: Record<string, unknown>;
  targets?: Array<{ POSITION?: number; NORMAL?: number }>;
  extras?: { targetNames?: string[] };
}

interface GLTFMesh {
  name?: string;
  primitives: GLTFPrimitive[];
}

interface GLTFNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  skin?: number;
  extensions?: Record<string, unknown>;
}

interface GLTFMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: { index: number; texCoord?: number; extensions?: Record<string, unknown> };
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: { index: number; texCoord?: number };
  };
  normalTexture?: { index: number; texCoord?: number; extensions?: Record<string, unknown> };
  occlusionTexture?: { index: number; texCoord?: number };
  emissiveTexture?: { index: number; texCoord?: number; extensions?: Record<string, unknown> };
  emissiveFactor?: number[];
  alphaMode?: string;
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: Record<string, unknown>;
}

interface GLTFTexture {
  sampler?: number;
  source?: number;
  extensions?: Record<string, unknown>;
}

interface GLTFImage {
  uri?: string;
  bufferView?: number;
  mimeType?: string;
  name?: string;
}

interface GLTFSkin {
  joints: number[];
  inverseBindMatrices?: number;
  skeleton?: number;
}

interface GLTFAnimation {
  name?: string;
  channels: { sampler: number; target: { node: number; path: string } }[];
  samplers: { input: number; output: number; interpolation?: string }[];
}

interface GLTFJson {
  asset?: { version: string };
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  buffers?: { byteLength: number; uri?: string }[];
  bufferViews?: GLTFBufferView[];
  accessors?: GLTFAccessor[];
  meshes?: GLTFMesh[];
  nodes?: GLTFNode[];
  scenes?: { nodes: number[] }[];
  scene?: number;
  materials?: GLTFMaterial[];
  textures?: GLTFTexture[];
  images?: GLTFImage[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  skins?: GLTFSkin[];
  animations?: GLTFAnimation[];
}

const GLTF_COMPONENT_SIZES: Record<number, number> = {
  5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};

const GLTF_TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

// Normalized accessor divisors per glTF spec (KHR_mesh_quantization).
const NORMALIZED_DIVISORS: Record<number, number> = {
  5120: 127.0,   // BYTE
  5121: 255.0,   // UNSIGNED_BYTE
  5122: 32767.0, // SHORT
  5123: 65535.0, // UNSIGNED_SHORT
  5125: 4294967295.0, // UNSIGNED_INT
};

interface BufferData {
  buffers: ArrayBuffer[];
  bufferViews: GLTFBufferView[];
}

/** Per-invocation parse context: holds codec registry and decode caches. */
interface ParseContext {
  json: GLTFJson;
  bd: BufferData;
  registry: GLTFCodecRegistry;
  /** meshopt: cache decoded bytes per bufferView index. */
  meshoptCache: Map<number, Uint8Array>;
}

/**
 * Read an accessor's data as a number array. Consults the codec registry:
 *  - EXT_meshopt_compression on the bufferView → decode (cached) then read.
 *  - Normalized integer accessors → divide by the correct divisor.
 *
 * Draco is handled at the primitive level (see parsePrimitive), not here,
 * because Draco decodes all attributes of a primitive at once.
 */
async function readAccessorData(
  accessorIdx: number,
  ctx: ParseContext,
): Promise<{ data: number[]; components: number; count: number }> {
  const { json, bd, registry, meshoptCache } = ctx;
  const accessor = json.accessors![accessorIdx];
  if (
    !Number.isInteger(accessor.bufferView) ||
    accessor.bufferView < 0 ||
    accessor.bufferView >= bd.bufferViews.length
  ) {
    throw new RangeError(
      `gltf: accessor ${accessorIdx} references invalid bufferView index ${accessor.bufferView}`,
    );
  }
  const bufferView = bd.bufferViews[accessor.bufferView];
  const componentSize = GLTF_COMPONENT_SIZES[accessor.componentType] ?? 4;
  const numComponents = GLTF_TYPE_COMPONENTS[accessor.type] ?? 1;
  const byteStride = bufferView.byteStride ?? (numComponents * componentSize);
  const offset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);

  // Validate bufferView bounds against its source buffer (non-meshopt path).
  const meshoptExt2 = bufferView.extensions?.["EXT_meshopt_compression"];
  if (!meshoptExt2 || !registry.hasBufferViewCodec("EXT_meshopt_compression")) {
    const srcBuffer = bd.buffers[bufferView.buffer];
    if (srcBuffer) {
      assertBounds(
        `gltf bufferView ${accessor.bufferView}`,
        bufferView.byteOffset ?? 0,
        bufferView.byteLength,
        srcBuffer.byteLength,
      );
    }
  }

  // Resolve the source buffer: either the raw buffer, or a meshopt-decoded
  // bufferView (decoded once and cached).
  let buffer: ArrayBuffer;
  const meshoptExt = bufferView.extensions?.["EXT_meshopt_compression"];
  if (meshoptExt && registry.hasBufferViewCodec("EXT_meshopt_compression")) {
    let decoded = meshoptCache.get(accessor.bufferView);
    if (!decoded) {
      const codec = registry.getBufferViewCodec("EXT_meshopt_compression")!;
      const ext = meshoptExt as Record<string, unknown>;
      const compressedBuf = bd.buffers[(ext.buffer as number) ?? bufferView.buffer];
      const compressedOffset = (ext.byteOffset as number) ?? 0;
      const compressedLength = (ext.byteLength as number) ?? bufferView.byteLength;
      const compressedData = new Uint8Array(compressedBuf, compressedOffset, compressedLength);
      const result = await codec.decode({
        compressedData,
        extension: ext,
        accessor: {
          bufferView: accessor.bufferView,
          byteOffset: accessor.byteOffset,
          componentType: accessor.componentType as 5120 | 5121 | 5122 | 5123 | 5125 | 5126,
          count: accessor.count,
          type: accessor.type,
          normalized: accessor.normalized,
        },
        byteStride,
      });
      decoded = result as unknown as Uint8Array;
      // Bound the meshopt cache to prevent unbounded memory growth on large files.
      if (meshoptCache.size >= 64) {
        const firstKey = meshoptCache.keys().next().value;
        if (firstKey !== undefined) meshoptCache.delete(firstKey);
      }
      meshoptCache.set(accessor.bufferView, decoded);
    }
    // The decoded buffer is a flat byte array; accessor.byteOffset applies
    // within it (the bufferView's byteOffset is 0 in the decoded space).
    buffer = (decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer);
  } else {
    buffer = bd.buffers[bufferView.buffer];
  }

  const result: number[] = [];
  const count = accessor.count;
  assertCount("gltf accessor", count, MAX_VERTEX_COUNT);
  assertBounds("gltf accessor", offset, count * byteStride, buffer.byteLength);
  const view = new DataView(buffer, offset);
  const divisor = accessor.normalized ? NORMALIZED_DIVISORS[accessor.componentType] : undefined;

  for (let i = 0; i < count; i++) {
    const elementOffset = i * byteStride;
    for (let c = 0; c < numComponents; c++) {
      const byteOffset = elementOffset + c * componentSize;
      switch (accessor.componentType) {
        case 5126: result.push(view.getFloat32(byteOffset, true)); break;
        case 5123:
          result.push(divisor ? view.getUint16(byteOffset, true) / divisor : view.getUint16(byteOffset, true));
          break;
        case 5125:
          result.push(divisor ? view.getUint32(byteOffset, true) / divisor : view.getUint32(byteOffset, true));
          break;
        case 5122:
          result.push(divisor ? view.getInt16(byteOffset, true) / divisor : view.getInt16(byteOffset, true));
          break;
        case 5121: {
          const v = view.getUint8(byteOffset);
          result.push(divisor ? v / divisor : v);
          break;
        }
        case 5120: {
          const v = view.getInt8(byteOffset);
          result.push(divisor ? Math.max(v / divisor, -1) : v);
          break;
        }
        default: result.push(view.getFloat32(byteOffset, true));
      }
    }
  }

  return { data: result, components: numComponents, count };
}

async function readAccessorTypedArray(
  accessorIdx: number,
  ctx: ParseContext,
): Promise<{ array: Float32Array; components: number; count: number }> {
  const { data, components, count } = await readAccessorData(accessorIdx, ctx);
  return { array: new Float32Array(data), components, count };
}

// --- Draco per-primitive decode ----------------------------------------------

/**
 * Decode a Draco-compressed primitive and return per-attribute typed arrays.
 * The Draco codec decodes all attributes at once; we cache the result per
 * primitive so repeated accessor reads reuse one decode.
 */
async function decodeDracoPrimitive(
  primitive: GLTFPrimitive,
  ctx: ParseContext,
): Promise<Map<string, ArrayBufferView> | null> {
  const dracoExt = primitive.extensions?.["KHR_draco_mesh_compression"];
  if (!dracoExt) return null;
  const codec = ctx.registry.getMeshCodec("KHR_draco_mesh_compression");
  if (!codec) {
    throw new Error("KHR_draco_mesh_compression: Draco codec not registered — cannot decode compressed primitive");
  }
  const ext = dracoExt as Record<string, unknown>;
  const bufferViewIdx = ext.bufferView as number;
  const bv = ctx.bd.bufferViews[bufferViewIdx];
  const buf = ctx.bd.buffers[bv.buffer];
  const start = (bv.byteOffset ?? 0);
  const bufferViewData = new Uint8Array(buf, start, bv.byteLength);

  // Build accessor metadata map for the codec.
  const accessors = new Map<number, { bufferView: number; byteOffset: number; componentType: 5120 | 5121 | 5122 | 5123 | 5125 | 5126; count: number; type: string; normalized?: boolean }>();
  for (const [semantic, accessorIdx] of Object.entries(primitive.attributes)) {
    const a = ctx.json.accessors![accessorIdx];
    if (a) {
      accessors.set(accessorIdx, {
        bufferView: a.bufferView,
        byteOffset: a.byteOffset,
        componentType: a.componentType as 5120 | 5121 | 5122 | 5123 | 5125 | 5126,
        count: a.count,
        type: a.type,
        normalized: a.normalized,
      });
    }
  }

  const decoded = await codec.decode({
    bufferViewData,
    extension: ext,
    attributes: primitive.attributes,
    indices: primitive.indices,
    accessors,
  });

  // Map from accessorIdx → typed array for easy lookup by the caller.
  const result = new Map<string, ArrayBufferView>();
  for (const [semantic, accessorIdx] of Object.entries(primitive.attributes)) {
    const arr = decoded.attributes.get(semantic);
    if (arr) result.set(`${semantic}:${accessorIdx}`, arr);
  }
  if (decoded.indices) {
    result.set("__indices__", decoded.indices);
  }
  return result;
}

// --- Main parser -------------------------------------------------------------

export interface ParseGLTFOptions {
  registry?: GLTFCodecRegistry;
}

export async function parseGLTF(
  data: ArrayBuffer,
  name: string,
  isGLB: boolean,
  binData?: ArrayBuffer | null,
  options?: ParseGLTFOptions,
): Promise<ModelData> {
  const registry = options?.registry ?? getDefaultCodecRegistry();
  let json: GLTFJson;
  let binaryBuffer: ArrayBuffer | null = null;

  if (isGLB) {
    const view = new DataView(data);
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546c67) throw new Error("Invalid GLB magic");

    const jsonLength = view.getUint32(12, true);
    const jsonChunk = new Uint8Array(data, 20, jsonLength);
    json = JSON.parse(strFromU8(jsonChunk, true));

    const binChunkStart = 20 + jsonLength;
    if (binChunkStart + 8 <= data.byteLength) {
      const binLength = view.getUint32(binChunkStart + 4, true);
      binaryBuffer = data.slice(binChunkStart + 8, binChunkStart + 8 + binLength);
    }
  } else {
    json = JSON.parse(new TextDecoder().decode(data));
    if (json.buffers && json.buffers[0] && json.buffers[0].uri) {
      const uri = json.buffers[0].uri;
      if (uri.startsWith("data:")) {
        const base64 = uri.split(",")[1];
        const binStr = atob(base64);
        binaryBuffer = new ArrayBuffer(binStr.length);
        new Uint8Array(binaryBuffer).set(
          binStr.split("").map((c) => c.charCodeAt(0)),
        );
      } else if (binData) {
        // External .bin file loaded by caller
        binaryBuffer = binData;
      }
    }
  }

  if (!binaryBuffer && json.buffers) {
    binaryBuffer = new ArrayBuffer(json.buffers[0]?.byteLength ?? 0);
  }

  const bd: BufferData = {
    buffers: [binaryBuffer ?? new ArrayBuffer(0)],
    bufferViews: (json.bufferViews ?? []).map(bv => ({
      buffer: bv.buffer,
      byteOffset: bv.byteOffset ?? 0,
      byteLength: bv.byteLength,
      target: bv.target,
      byteStride: bv.byteStride,
      extensions: bv.extensions,
    })),
  };

  const ctx: ParseContext = { json, bd, registry, meshoptCache: new Map() };

  // Parse KHR_lights_punctual (root-level extension)
  let lights: PunctualLightData[] | undefined;
  const lightsExt = json.extensions?.["KHR_lights_punctual"] as
    | { lights: Array<Record<string, unknown>> }
    | undefined;
  if (lightsExt?.lights) {
    lights = lightsExt.lights.map((l) => {
      const type = (l.type as string) ?? "point";
      const color = l.color as number[] | undefined;
      const spot = l.spot as { innerConeAngle?: number; outerConeAngle?: number } | undefined;
      return {
        type: type as "directional" | "point" | "spot",
        color: color ? [color[0], color[1], color[2]] : undefined,
        intensity: l.intensity as number | undefined,
        range: l.range as number | undefined,
        spot: spot
          ? {
              innerConeAngle: spot.innerConeAngle ?? 0,
              outerConeAngle: spot.outerConeAngle ?? Math.PI / 4,
            }
          : undefined,
      };
    });
  }

  // Parse KHR_materials_variants (root-level extension)
  let materialVariants: string[] | undefined;
  const variantsExt = json.extensions?.["KHR_materials_variants"] as
    | { variants: Array<{ name: string }> }
    | undefined;
  if (variantsExt?.variants) {
    materialVariants = variantsExt.variants.map((v) => v.name);
  }

  // Parse materials
  let materials: MaterialData[] | undefined;
  if (json.materials) {
    materials = [];
    for (let i = 0; i < json.materials.length; i++) {
      const mat = json.materials[i];
      const pbr = mat.pbrMetallicRoughness ?? {};
      const baseColor = pbr.baseColorFactor ?? [1, 1, 1, 1];

      let textureUri: string | undefined;
      let textureData: ArrayBuffer | null = null;
      let textureTransform: MaterialData["textureTransform"];
      if (pbr.baseColorTexture !== undefined && json.textures && json.images) {
        const tex = json.textures[pbr.baseColorTexture.index];
        if (tex) {
          // KHR_texture_transform on the textureInfo
          textureTransform = extractTextureTransform(pbr.baseColorTexture.extensions);

          // KHR_texture_basisu: texture source is KTX2 data
          const basisuExt = tex.extensions?.["KHR_texture_basisu"] as Record<string, unknown> | undefined;
          if (basisuExt && registry.hasTextureCodec("KHR_texture_basisu")) {
            const sourceIdx = (basisuExt.source as number) ?? tex.source;
            if (sourceIdx !== undefined) {
              const img = json.images[sourceIdx];
              if (img?.bufferView !== undefined && bd.buffers[0]) {
                const bv = bd.bufferViews[img.bufferView];
                if (bv) {
                  const buf = bd.buffers[bv.buffer];
                  const start = bv.byteOffset;
                  const end = start + bv.byteLength;
                  textureData = buf.slice(start, end);
                }
              }
            }
          } else if (tex.source !== undefined) {
            const img = json.images[tex.source];
            if (img) {
              textureUri = img.uri ?? undefined;
              if (textureUri) {
                // Reject file://, .., and absolute paths from untrusted glTF
                textureUri = sanitizeUri(textureUri);
              }
              // Handle embedded images via bufferView
              if (img.bufferView !== undefined && bd.buffers[0]) {
                const bv = bd.bufferViews[img.bufferView];
                if (bv) {
                  const buf = bd.buffers[bv.buffer];
                  const start = bv.byteOffset;
                  const end = start + bv.byteLength;
                  textureData = buf.slice(start, end);
                }
              }
            }
          }
        }
      }

      let normalTextureUri: string | undefined;
      let normalTextureTransform: MaterialData["normalTextureTransform"];
      if (mat.normalTexture !== undefined && json.textures && json.images) {
        const tex = json.textures[mat.normalTexture.index];
        if (tex && tex.source !== undefined) {
          const img = json.images[tex.source];
          if (img) {
            normalTextureUri = img.uri ?? undefined;
            if (normalTextureUri) {
              normalTextureUri = sanitizeUri(normalTextureUri);
            }
          }
        }
        normalTextureTransform = extractTextureTransform(mat.normalTexture.extensions);
      }

      let emissiveTextureTransform: MaterialData["emissiveTextureTransform"];
      if (mat.emissiveTexture?.extensions) {
        emissiveTextureTransform = extractTextureTransform(mat.emissiveTexture.extensions);
      }

      const baseMat: MaterialData = {
        name: mat.name ?? `material_${i}`,
        baseColor: [baseColor[0], baseColor[1], baseColor[2], baseColor[3] ?? 1],
        metallic: pbr.metallicFactor ?? 0,
        roughness: pbr.roughnessFactor ?? 1,
        textureUri,
        textureData,
        normalTextureUri,
        emissiveColor: mat.emissiveFactor ? [mat.emissiveFactor[0], mat.emissiveFactor[1], mat.emissiveFactor[2]] : undefined,
        textureTransform,
        normalTextureTransform,
        emissiveTextureTransform,
      };

      const extCtx: ExtensionProcessingContext = {
        textures: json.textures as ExtensionProcessingContext["textures"],
        images: json.images as ExtensionProcessingContext["images"],
        samplers: json.samplers as ExtensionProcessingContext["samplers"],
      };
      const processedMat = processMaterialExtensions(baseMat, mat.extensions, extCtx);
      materials.push(processedMat);
    }
  }

  // Parse meshes
  const meshes: MeshData[] = [];
  if (json.meshes) {
    for (let i = 0; i < json.meshes.length; i++) {
      const mesh = json.meshes[i];
      for (let p = 0; p < mesh.primitives.length; p++) {
        const primitive = mesh.primitives[p];
        const posAccessor = primitive.attributes.POSITION;
        if (posAccessor === undefined) continue;

        try {
          const meshData = await parsePrimitive(primitive, ctx, mesh.name ?? `mesh_${i}`);
          if (meshData) {
            // KHR_materials_variants: per-primitive mappings
          const variantsExtPrim = primitive.extensions?.["KHR_materials_variants"] as
            | { mappings: Array<{ variant: number; material: number }> }
            | undefined;
          if (variantsExtPrim?.mappings) {
            meshData.variantMappings = variantsExtPrim.mappings.map((m) => ({
              variant: m.variant,
              material: m.material,
            }));
          }
            meshes.push(meshData);
          }
        } catch (meshErr) {
          console.error(`[gltf] Error parsing mesh "${mesh.name}" (index ${i}, primitive ${p}):`, meshErr);
          continue;
        }
      }
    }
  }

  // Parse nodes
  let nodes: ModelNode[] | undefined;
  if (json.nodes) {
    nodes = [];
    for (let i = 0; i < json.nodes.length; i++) {
      const n = json.nodes[i];
      // KHR_lights_punctual: node references a light by index
      const lightExt = n.extensions?.["KHR_lights_punctual"] as { light: number } | undefined;
      nodes.push({
        name: n.name ?? `node_${i}`,
        children: n.children,
        mesh: n.mesh,
        nodeIndex: i,
        translation: n.translation ? [n.translation[0], n.translation[1], n.translation[2]] : undefined,
        rotation: n.rotation ? [n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]] : undefined,
        scale: n.scale ? [n.scale[0], n.scale[1], n.scale[2]] : undefined,
        lightIndex: lightExt?.light,
      });
    }
  }

  // Parse skins
  let skin: SkinData | undefined;
  if (json.skins && json.skins.length > 0 && json.nodes) {
    const sk = json.skins[0]; // Use first skin
    const jointIndices = sk.joints;
    const bones: BoneData[] = [];
    const boneNameToIndex = new Map<string, number>();

    // Parse inverse bind matrices if available
    let inverseBindMatrices: Float32Array[] = [];
    if (sk.inverseBindMatrices !== undefined) {
      const ibmData = await readAccessorData(sk.inverseBindMatrices, ctx);
      for (let j = 0; j < jointIndices.length; j++) {
        const ibm = new Float32Array(16);
        for (let r = 0; r < 16; r++) {
          ibm[r] = ibmData.data[j * 16 + r];
        }
        inverseBindMatrices.push(ibm);
      }
    } else {
      // No inverse bind matrices — use identity
      for (let j = 0; j < jointIndices.length; j++) {
        inverseBindMatrices.push(new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]));
      }
    }

    for (let j = 0; j < jointIndices.length; j++) {
      const nodeIdx = jointIndices[j];
      const node = json.nodes[nodeIdx];
      const boneName = node?.name ?? `bone_${j}`;
      // Find parent bone index by looking up node's parent in the hierarchy
      let parentBoneIdx = -1;
      for (let pi = 0; pi < json.nodes.length; pi++) {
        const pn = json.nodes[pi];
        if (pn.children && pn.children.includes(nodeIdx)) {
          const parentJointIdx = jointIndices.indexOf(pi);
          if (parentJointIdx >= 0) {
            parentBoneIdx = parentJointIdx;
            break;
          }
        }
      }
      bones.push({
        name: boneName,
        nodeIndex: nodeIdx,
        parentIndex: parentBoneIdx,
        inverseBindMatrix: inverseBindMatrices[j],
        restTranslation: node?.translation ? [node.translation[0], node.translation[1], node.translation[2]] : [0, 0, 0],
        restRotation: node?.rotation ? [node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]] : [0, 0, 0, 1],
        restScale: node?.scale ? [node.scale[0], node.scale[1], node.scale[2]] : [1, 1, 1],
      });
      boneNameToIndex.set(boneName, j);
    }

    skin = { bones, boneNameToIndex };
    console.log(`[gltf] Parsed skin: ${bones.length} bones`);
  }

  // Parse animations
  let animations: AnimationData[] | undefined;
  if (json.animations) {
    animations = [];
    for (let i = 0; i < json.animations.length; i++) {
      const anim = json.animations[i];
      const channels: AnimationChannel[] = [];

      let maxTime = 0;
      for (let c = 0; c < anim.channels.length; c++) {
        const ch = anim.channels[c];
        const sampler = anim.samplers[ch.sampler];

        const timeData = await readAccessorTypedArray(sampler.input, ctx);
        const valueData = await readAccessorTypedArray(sampler.output, ctx);

        for (let t = 0; t < timeData.count; t++) {
          if (timeData.array[t] > maxTime) maxTime = timeData.array[t];
        }

        const nodeName = (ch.target.node !== undefined && json.nodes) ? (json.nodes[ch.target.node].name ?? `node_${ch.target.node}`) : `node_${ch.target.node}`;

        channels.push({
          targetNode: nodeName,
          path: ch.target.path as "translation" | "rotation" | "scale" | "weights",
          keyframeTimes: timeData.array.slice(0, timeData.count),
          keyframeValues: valueData.array.slice(0, valueData.count * valueData.components),
          interpolation: (sampler.interpolation ?? "LINEAR") as "LINEAR" | "STEP" | "CUBICSPLINE",
        });
      }

      animations.push({
        name: anim.name ?? `animation_${i}`,
        duration: maxTime,
        channels,
      });
    }
  }

  return {
    meshes,
    name,
    format: isGLB ? "glb" : "gltf",
    materials,
    animations,
    nodes,
    skin,
    materialVariants,
    lights,
  };
}

/** Parse a single primitive, consulting Draco codec if present. */
async function parsePrimitive(
  primitive: GLTFPrimitive,
  ctx: ParseContext,
  meshName: string,
): Promise<MeshData | null> {
  const { json, bd } = ctx;
  const posAccessor = primitive.attributes.POSITION;
  if (posAccessor === undefined) return null;

  // --- Draco fast path: decode whole primitive via the mesh codec ---
  const dracoAttrs = await decodeDracoPrimitive(primitive, ctx);

  // Helper to read an attribute: from Draco cache if available, else readAccessorData.
  async function readAttr(semantic: string, accessorIdx: number): Promise<{ data: number[]; components: number; count: number } | null> {
    if (dracoAttrs) {
      const cached = dracoAttrs.get(`${semantic}:${accessorIdx}`);
      if (cached) {
        const numComponents = GLTF_TYPE_COMPONENTS[json.accessors![accessorIdx].type] ?? 1;
        const count = json.accessors![accessorIdx].count;
        const data: number[] = [];
        const arr = cached as unknown as ArrayLike<number>;
        for (let i = 0; i < arr.length; i++) data.push(arr[i]);
        return { data, components: numComponents, count };
      }
    }
    return readAccessorData(accessorIdx, ctx);
  }

  const posData = await readAttr("POSITION", posAccessor);
  if (!posData) return null;

  const normAccessor = primitive.attributes.NORMAL;
  const normData = normAccessor !== undefined ? await readAttr("NORMAL", normAccessor) : null;
  const uvAccessor = primitive.attributes.TEXCOORD_0;
  const uvData = uvAccessor !== undefined ? await readAttr("TEXCOORD_0", uvAccessor) : null;
  const colorAccessor = primitive.attributes.COLOR_0;
  const colorData = colorAccessor !== undefined ? await readAttr("COLOR_0", colorAccessor) : null;

  const vertexCount = posData.count;
  const vertices = new Float32Array(vertexCount * 6);

  for (let v = 0; v < vertexCount; v++) {
    vertices[v * 6] = posData.data[v * 3];
    vertices[v * 6 + 1] = posData.data[v * 3 + 1];
    vertices[v * 6 + 2] = posData.data[v * 3 + 2];
    if (normData) {
      vertices[v * 6 + 3] = normData.data[v * 3];
      vertices[v * 6 + 4] = normData.data[v * 3 + 1];
      vertices[v * 6 + 5] = normData.data[v * 3 + 2];
    } else {
      vertices[v * 6 + 3] = 0;
      vertices[v * 6 + 4] = 1;
      vertices[v * 6 + 5] = 0;
    }
  }

  let indices: Uint16Array | Uint32Array;
  let indexCount: number;

  if (primitive.indices !== undefined) {
    if (dracoAttrs) {
      const cachedIndices = dracoAttrs.get("__indices__");
      if (cachedIndices) {
        const idxArr = cachedIndices as unknown as ArrayLike<number>;
        indexCount = idxArr.length;
        if (cachedIndices instanceof Uint32Array) {
          indices = cachedIndices;
        } else if (cachedIndices instanceof Uint16Array) {
          indices = cachedIndices;
        } else {
          indices = new Uint32Array(idxArr);
          for (let i = 0; i < indexCount; i++) indices[i] = idxArr[i];
        }
      } else {
        const idxData = await readAccessorData(primitive.indices, ctx);
        indexCount = idxData.data.length;
        indices = indexCount > 65535 ? new Uint32Array(idxData.data) : new Uint16Array(idxData.data);
      }
    } else {
      const idxData = await readAccessorData(primitive.indices, ctx);
      indexCount = idxData.data.length;
      if (indexCount > 65535) {
        indices = new Uint32Array(idxData.data);
      } else {
        indices = new Uint16Array(idxData.data);
      }
    }
  } else {
    indexCount = vertexCount;
    if (indexCount > 65535) {
      indices = new Uint32Array(indexCount);
      for (let v = 0; v < indexCount; v++) indices[v] = v;
    } else {
      indices = new Uint16Array(indexCount);
      for (let v = 0; v < indexCount; v++) indices[v] = v;
    }
  }

  let uvArray: Float32Array | null = null;
  if (uvData) {
    uvArray = new Float32Array(vertexCount * 2);
    for (let v = 0; v < vertexCount; v++) {
      uvArray[v * 2] = uvData.data[v * 2];
      uvArray[v * 2 + 1] = uvData.data[v * 2 + 1];
    }
  }

  let colorArray: Float32Array | null = null;
  if (colorData) {
    const comps = colorData.components;
    colorArray = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      if (comps >= 3) {
        colorArray[v * 3] = colorData.data[v * comps];
        colorArray[v * 3 + 1] = colorData.data[v * comps + 1];
        colorArray[v * 3 + 2] = colorData.data[v * comps + 2];
      } else if (comps === 1) {
        const c = colorData.data[v];
        colorArray[v * 3] = c;
        colorArray[v * 3 + 1] = c;
        colorArray[v * 3 + 2] = c;
      }
    }
  }

  // Parse skinning attributes (JOINTS_0 and WEIGHTS_0)
  let jointsArray: Uint8Array | null = null;
  let weightsArray: Float32Array | null = null;
  const jointsAccessor = primitive.attributes.JOINTS_0;
  const weightsAccessor = primitive.attributes.WEIGHTS_0;
  if (jointsAccessor !== undefined && weightsAccessor !== undefined) {
    const jointsData = await readAttr("JOINTS_0", jointsAccessor);
    const weightsData = await readAttr("WEIGHTS_0", weightsAccessor);
    if (jointsData && weightsData) {
      jointsArray = new Uint8Array(vertexCount * 4);
      weightsArray = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) {
        jointsArray[v * 4] = jointsData.data[v * 4];
        jointsArray[v * 4 + 1] = jointsData.data[v * 4 + 1];
        jointsArray[v * 4 + 2] = jointsData.data[v * 4 + 2];
        jointsArray[v * 4 + 3] = jointsData.data[v * 4 + 3];
        weightsArray[v * 4] = weightsData.data[v * 4];
        weightsArray[v * 4 + 1] = weightsData.data[v * 4 + 1];
        weightsArray[v * 4 + 2] = weightsData.data[v * 4 + 2];
        weightsArray[v * 4 + 3] = weightsData.data[v * 4 + 3];
      }
    }
  }

  return {
    vertices,
    indices,
    vertexCount,
    indexCount,
    uvs: uvArray,
    colors: colorArray,
    joints: jointsArray ?? undefined,
    weights: weightsArray ?? undefined,
    materialIndex: primitive.material,
  };
}
