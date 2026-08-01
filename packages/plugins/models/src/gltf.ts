import { strFromU8 } from "fflate";
import { processMaterialExtensions, type ExtensionProcessingContext } from "./gltf-extensions.ts";
import type { AnimationChannel, AnimationData, BoneData, MaterialData, MeshData, ModelData, ModelNode, SkinData } from "./types.ts";

interface GLTFJson {
  asset?: { version: string };
  buffers?: { byteLength: number; uri?: string }[];
  bufferViews?: { buffer: number; byteOffset: number; byteLength: number; target?: number; byteStride?: number }[];
  accessors?: {
    bufferView: number;
    byteOffset: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
    normalized?: boolean;
  }[];
  meshes?: {
    name?: string;
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      mode?: number;
      material?: number;
    }[];
  }[];
  nodes?: { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; skin?: number }[];
  scenes?: { nodes: number[] }[];
  scene?: number;
  materials?: {
    name?: string;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: { index: number; texCoord?: number };
      metallicFactor?: number;
      roughnessFactor?: number;
    };
    normalTexture?: { index: number; texCoord?: number };
    emissiveFactor?: number[];
    emissiveTexture?: { index: number };
    alphaMode?: string;
    alphaCutoff?: number;
    doubleSided?: boolean;
    extensions?: Record<string, unknown>;
  }[];
  textures?: { sampler?: number; source?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  animations?: {
    name?: string;
    channels: {
      sampler: number;
      target: { node: number; path: string };
    }[];
    samplers: {
      input: number;
      output: number;
      interpolation?: string;
    }[];
  }[];
}

const GLTF_COMPONENT_SIZES: Record<number, number> = {
  5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};

const GLTF_TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

interface BufferData {
  buffers: ArrayBuffer[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number; byteStride?: number }[];
}

function readAccessorData(accessorIdx: number, json: GLTFJson, bd: BufferData): { data: number[]; components: number; count: number } {
  const accessor = json.accessors![accessorIdx];
  const bufferView = bd.bufferViews[accessor.bufferView];
  const componentSize = GLTF_COMPONENT_SIZES[accessor.componentType] ?? 4;
  const numComponents = GLTF_TYPE_COMPONENTS[accessor.type] ?? 1;
  const byteStride = bufferView.byteStride ?? (numComponents * componentSize);
  const offset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const buffer = bd.buffers[bufferView.buffer];

  const result: number[] = [];
  const view = new DataView(buffer, offset);
  const count = accessor.count;

  for (let i = 0; i < count; i++) {
    const elementOffset = i * byteStride;
    for (let c = 0; c < numComponents; c++) {
      const byteOffset = elementOffset + c * componentSize;
      switch (accessor.componentType) {
        case 5126: result.push(view.getFloat32(byteOffset, true)); break;
        case 5123: result.push(view.getUint16(byteOffset, true)); break;
        case 5125: result.push(view.getUint32(byteOffset, true)); break;
        case 5122: result.push(view.getInt16(byteOffset, true)); break;
        case 5121: {
          const v = view.getUint8(byteOffset);
          result.push(accessor.normalized ? v / 255 : v);
          break;
        }
        case 5120: {
          const v = view.getInt8(byteOffset);
          result.push(accessor.normalized ? Math.max(v / 127, -1) : v);
          break;
        }
        default: result.push(view.getFloat32(byteOffset, true));
      }
    }
  }

  return { data: result, components: numComponents, count };
}

function readAccessorTypedArray(accessorIdx: number, json: GLTFJson, bd: BufferData): { array: Float32Array; components: number; count: number } {
  const { data, components, count } = readAccessorData(accessorIdx, json, bd);
  return { array: new Float32Array(data), components, count };
}

export function parseGLTF(data: ArrayBuffer, name: string, isGLB: boolean, binData?: ArrayBuffer | null): ModelData {
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
    })),
  };

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
      if (pbr.baseColorTexture !== undefined && json.textures && json.images) {
        const tex = json.textures[pbr.baseColorTexture.index];
        if (tex && tex.source !== undefined) {
          const img = json.images[tex.source];
          if (img) {
            textureUri = img.uri ?? undefined;
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

      let normalTextureUri: string | undefined;
      if (mat.normalTexture !== undefined && json.textures && json.images) {
        const tex = json.textures[mat.normalTexture.index];
        if (tex && tex.source !== undefined) {
          const img = json.images[tex.source];
          if (img) {
            normalTextureUri = img.uri ?? undefined;
          }
        }
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
      };

      const extCtx: ExtensionProcessingContext = {
        textures: json.textures,
        images: json.images,
        samplers: json.samplers,
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

        let posData: { data: number[]; components: number; count: number };
        try {
          posData = readAccessorData(posAccessor, json, bd);
        const normAccessor = primitive.attributes.NORMAL;
        const normData = normAccessor !== undefined ? readAccessorData(normAccessor, json, bd) : null;
        const uvAccessor = primitive.attributes.TEXCOORD_0;
        const uvData = uvAccessor !== undefined ? readAccessorData(uvAccessor, json, bd) : null;
        const colorAccessor = primitive.attributes.COLOR_0;
        const colorData = colorAccessor !== undefined ? readAccessorData(colorAccessor, json, bd) : null;

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
          const idxData = readAccessorData(primitive.indices, json, bd);
          indexCount = idxData.data.length;
          if (indexCount > 65535) {
            indices = new Uint32Array(idxData.data);
          } else {
            indices = new Uint16Array(idxData.data);
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
          const jointsData = readAccessorData(jointsAccessor, json, bd);
          const weightsData = readAccessorData(weightsAccessor, json, bd);
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

        meshes.push({
          vertices,
          indices,
          vertexCount,
          indexCount,
          uvs: uvArray,
          colors: colorArray,
          joints: jointsArray,
          weights: weightsArray,
          materialIndex: primitive.material,
        });
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
      nodes.push({
        name: n.name ?? `node_${i}`,
        children: n.children,
        mesh: n.mesh,
        nodeIndex: i,
        translation: n.translation ? [n.translation[0], n.translation[1], n.translation[2]] : undefined,
        rotation: n.rotation ? [n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]] : undefined,
        scale: n.scale ? [n.scale[0], n.scale[1], n.scale[2]] : undefined,
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
      const ibmData = readAccessorData(sk.inverseBindMatrices, json, bd);
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

        const timeData = readAccessorTypedArray(sampler.input, json, bd);
        const valueData = readAccessorTypedArray(sampler.output, json, bd);

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
  };
}
