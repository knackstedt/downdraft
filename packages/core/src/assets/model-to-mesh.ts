import type { MeshData as EngineMeshData } from "../mesh/builder.ts";
import { PBR_VERTEX_LAYOUT, SKINNED_VERTEX_LAYOUT, STANDARD_VERTEX_LAYOUT, type VertexLayout } from "../mesh/vertex-layout.ts";

// Plugin ModelData types (mirrored from @downdraft/plugin-models types.ts)
interface PluginMeshData {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  materialIndex?: number;
  joints?: Uint8Array;
  weights?: Float32Array;
}

interface PluginModelData {
  meshes: PluginMeshData[];
  name: string;
  format: string;
  materials?: PluginMaterialData[];
  animations?: unknown[];
  nodes?: unknown[];
  skin?: unknown;
}

interface PluginMaterialData {
  name: string;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  textureUri?: string;
  textureData?: ArrayBuffer | null;
  normalTextureUri?: string;
  emissiveColor?: [number, number, number];
}

export type { PluginMeshData, PluginModelData, PluginMaterialData };

export type TargetLayout = "pbr" | "standard" | "skinned";

function resolveLayout(target: TargetLayout, hasSkinning: boolean): VertexLayout {
  if (hasSkinning) return SKINNED_VERTEX_LAYOUT;
  if (target === "pbr") return PBR_VERTEX_LAYOUT;
  return STANDARD_VERTEX_LAYOUT;
}

function generateTangents(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array | null,
  indices: Uint16Array | Uint32Array,
  vertexCount: number,
): Float32Array | null {
  if (!uvs) return null;

  const tangents = new Float32Array(vertexCount * 4);
  const tan1 = new Float32Array(vertexCount * 3);
  const tan2 = new Float32Array(vertexCount * 3);

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

    const v0x = positions[i0 * 3], v0y = positions[i0 * 3 + 1], v0z = positions[i0 * 3 + 2];
    const v1x = positions[i1 * 3], v1y = positions[i1 * 3 + 1], v1z = positions[i1 * 3 + 2];
    const v2x = positions[i2 * 3], v2y = positions[i2 * 3 + 1], v2z = positions[i2 * 3 + 2];

    const u0 = uvs[i0 * 2], v0u = uvs[i0 * 2 + 1];
    const u1 = uvs[i1 * 2], v1u = uvs[i1 * 2 + 1];
    const u2 = uvs[i2 * 2], v2u = uvs[i2 * 2 + 1];

    const d1x = v1x - v0x, d1y = v1y - v0y, d1z = v1z - v0z;
    const d2x = v2x - v0x, d2y = v2y - v0y, d2z = v2z - v0z;

    const du1 = u1 - u0, dv1 = v1u - v0u;
    const du2 = u2 - u0, dv2 = v2u - v0u;

    const r = 1.0 / (du1 * dv2 - du2 * dv1);
    if (!isFinite(r)) continue;

    const t1x = (d1x * dv2 - d2x * dv1) * r;
    const t1y = (d1y * dv2 - d2y * dv1) * r;
    const t1z = (d1z * dv2 - d2z * dv1) * r;
    const t2x = (d2x * du1 - d1x * du2) * r;
    const t2y = (d2y * du1 - d1y * du2) * r;
    const t2z = (d2z * du1 - d1z * du2) * r;

    tan1[i0 * 3] += t1x; tan1[i0 * 3 + 1] += t1y; tan1[i0 * 3 + 2] += t1z;
    tan1[i1 * 3] += t1x; tan1[i1 * 3 + 1] += t1y; tan1[i1 * 3 + 2] += t1z;
    tan1[i2 * 3] += t1x; tan1[i2 * 3 + 1] += t1y; tan1[i2 * 3 + 2] += t1z;
    tan2[i0 * 3] += t2x; tan2[i0 * 3 + 1] += t2y; tan2[i0 * 3 + 2] += t2z;
    tan2[i1 * 3] += t2x; tan2[i1 * 3 + 1] += t2y; tan2[i1 * 3 + 2] += t2z;
    tan2[i2 * 3] += t2x; tan2[i2 * 3 + 1] += t2y; tan2[i2 * 3 + 2] += t2z;
  }

  for (let i = 0; i < vertexCount; i++) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    const tx = tan1[i * 3], ty = tan1[i * 3 + 1], tz = tan1[i * 3 + 2];

    // Gram-Schmidt orthogonalize
    const dot = nx * tx + ny * ty + nz * tz;
    const tX = tx - nx * dot;
    const tY = ty - ny * dot;
    const tZ = tz - nz * dot;
    const len = Math.sqrt(tX * tX + tY * tY + tZ * tZ) || 1;

    // Handedness
    const bx = (ny * tz - nz * ty);
    const by = (nz * tx - nx * tz);
    const bz = (nx * ty - ny * tx);
    const bCrossT = bx * tan2[i * 3] + by * tan2[i * 3 + 1] + bz * tan2[i * 3 + 2];
    const w = bCrossT < 0 ? -1 : 1;

    tangents[i * 4] = tX / len;
    tangents[i * 4 + 1] = tY / len;
    tangents[i * 4 + 2] = tZ / len;
    tangents[i * 4 + 3] = w;
  }

  return tangents;
}

export function convertPluginMesh(
  pluginMesh: PluginMeshData,
  target: TargetLayout = "pbr",
): EngineMeshData {
  const hasSkinning = !!(pluginMesh.joints && pluginMesh.weights);
  const layout = resolveLayout(target, hasSkinning);
  const stride = layout.stride / 4; // floats per vertex
  const vertexCount = pluginMesh.vertexCount;

  // Plugin vertices are interleaved as: pos(3) + normal(3) = 6 floats per vertex
  const positions = pluginMesh.vertices; // [px,py,pz, nx,ny,nz, ...]
  const normals = pluginMesh.vertices; // same array, offset by 3

  // Generate tangents if needed
  let tangents: Float32Array | null = null;
  if (target === "pbr" || hasSkinning) {
    tangents = generateTangents(positions, normals, pluginMesh.uvs, pluginMesh.indices, vertexCount);
  }

  // Build interleaved vertex buffer matching the target layout
  const vertices = new Float32Array(vertexCount * stride);

  for (let i = 0; i < vertexCount; i++) {
    const src = i * 6; // 6 floats per vertex in plugin format (pos+norm)
    const dst = i * stride;

    // Position (float32x3)
    vertices[dst + 0] = positions[src + 0];
    vertices[dst + 1] = positions[src + 1];
    vertices[dst + 2] = positions[src + 2];

    // Normal (float32x3)
    vertices[dst + 3] = positions[src + 3];
    vertices[dst + 4] = positions[src + 4];
    vertices[dst + 5] = positions[src + 5];

    // UV (float32x2)
    if (pluginMesh.uvs) {
      vertices[dst + 6] = pluginMesh.uvs[i * 2];
      vertices[dst + 7] = pluginMesh.uvs[i * 2 + 1];
    } else {
      vertices[dst + 6] = 0;
      vertices[dst + 7] = 0;
    }

    if (target === "pbr" || hasSkinning) {
      // Tangent (float32x4)
      if (tangents) {
        vertices[dst + 8] = tangents[i * 4];
        vertices[dst + 9] = tangents[i * 4 + 1];
        vertices[dst + 10] = tangents[i * 4 + 2];
        vertices[dst + 11] = tangents[i * 4 + 3];
      } else {
        vertices[dst + 8] = 1;
        vertices[dst + 9] = 0;
        vertices[dst + 10] = 0;
        vertices[dst + 11] = 1;
      }
    } else {
      // Color (float32x4) for standard layout
      if (pluginMesh.colors) {
        vertices[dst + 8] = pluginMesh.colors[i * 4];
        vertices[dst + 9] = pluginMesh.colors[i * 4 + 1];
        vertices[dst + 10] = pluginMesh.colors[i * 4 + 2];
        vertices[dst + 11] = pluginMesh.colors[i * 4 + 3];
      } else {
        vertices[dst + 8] = 1;
        vertices[dst + 9] = 1;
        vertices[dst + 10] = 1;
        vertices[dst + 11] = 1;
      }
    }

    // Skinning data (uint16x4 boneIndices + float32x4 boneWeights)
    if (hasSkinning) {
      const joints = pluginMesh.joints!;
      const weights = pluginMesh.weights!;
      // uint16x4 packed as 4 uint16 values at byte offset 48
      const byteOffset = dst * 4 + 48;
      const view = new Uint16Array(vertices.buffer);
      view[byteOffset / 2 + 0] = joints[i * 4 + 0];
      view[byteOffset / 2 + 1] = joints[i * 4 + 1];
      view[byteOffset / 2 + 2] = joints[i * 4 + 2];
      view[byteOffset / 2 + 3] = joints[i * 4 + 3];

      vertices[dst + 14] = weights[i * 4 + 0];
      vertices[dst + 15] = weights[i * 4 + 1];
      vertices[dst + 16] = weights[i * 4 + 2];
      vertices[dst + 17] = weights[i * 4 + 3];
    }
  }

  return {
    vertices,
    indices: pluginMesh.indices,
    layout,
    vertexCount,
    indexCount: pluginMesh.indexCount,
  };
}

export function convertPluginModel(
  model: PluginModelData,
  target: TargetLayout = "pbr",
): EngineMeshData[] {
  return model.meshes.map((mesh) => convertPluginMesh(mesh, target));
}
