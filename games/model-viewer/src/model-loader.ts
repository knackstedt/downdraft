import { loadModel, type AnimationData, type MaterialData, type ModelData, type ModelNode } from "@downdraft/plugin-models";
import { gunzipSync, strFromU8 } from "fflate";

export type { AnimationData };

// ── Quaternion helpers (for baking node transforms into mesh vertices) ──

type Quat = [number, number, number, number];
type Vec3 = [number, number, number];

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qrotate(q: Quat, v: Vec3): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  // v + 2*cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const c1x = qy * vz - qz * vy + qw * vx;
  const c1y = qz * vx - qx * vz + qw * vy;
  const c1z = qx * vy - qy * vx + qw * vz;
  const c2x = qy * c1z - qz * c1y;
  const c2y = qz * c1x - qx * c1z;
  const c2z = qx * c1y - qy * c1x;
  return [vx + 2 * c2x, vy + 2 * c2y, vz + 2 * c2z];
}

interface WorldTransform {
  translation: Vec3;
  rotation: Quat;
  scale: Vec3;
}

function identityTransform(): WorldTransform {
  return { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function composeTransforms(parent: WorldTransform, node: ModelNode): WorldTransform {
  const localT: Vec3 = node.translation ?? [0, 0, 0];
  const localR: Quat = node.rotation ?? [0, 0, 0, 1];
  const localS: Vec3 = node.scale ?? [1, 1, 1];

  // worldTranslation = qrotate(parentR, localT * parentS) + parentT
  const scaledT: Vec3 = [localT[0] * parent.scale[0], localT[1] * parent.scale[1], localT[2] * parent.scale[2]];
  const rotatedT = qrotate(parent.rotation, scaledT);
  const worldT: Vec3 = [rotatedT[0] + parent.translation[0], rotatedT[1] + parent.translation[1], rotatedT[2] + parent.translation[2]];

  // worldRotation = parentR * localR
  const worldR = qmul(parent.rotation, localR);

  // worldScale = parentS * localS
  const worldS: Vec3 = [parent.scale[0] * localS[0], parent.scale[1] * localS[1], parent.scale[2] * localS[2]];

  return { translation: worldT, rotation: worldR, scale: worldS };
}

/**
 * Bake the node hierarchy transforms into mesh vertices.
 *
 * The FBX loader extracts vertices in each geometry's local space and stores
 * per-node transforms (translation, rotation, PreRotation, scale) in the node
 * tree. The ModelRenderer only applies a single root-level transform, so
 * per-node transforms are never applied — causing models with non-identity
 * node transforms (e.g. PreRotation on mesh-bearing nodes) to render with
 * wrong rotation/position.
 *
 * This function traverses the node tree, computes each node's world transform,
 * and applies it to the associated mesh's vertices and normals. After baking,
 * all meshes are in a consistent model-space coordinate system.
 */
function bakeNodeTransforms(modelData: ModelData): void {
  if (!modelData.nodes || modelData.nodes.length === 0) return;

  // Compute world transforms for each node via DFS from root nodes.
  const worldTransforms: WorldTransform[] = modelData.nodes.map(() => identityTransform());

  // Find root nodes (nodes with no parent).
  const hasParent = new Set<number>();
  for (const node of modelData.nodes) {
    if (node.children) {
      for (const childIdx of node.children) {
        hasParent.add(childIdx);
      }
    }
  }
  const rootIndices: number[] = [];
  for (let i = 0; i < modelData.nodes.length; i++) {
    if (!hasParent.has(i)) rootIndices.push(i);
  }

  // DFS to compute world transforms.
  function traverse(nodeIdx: number, parentTransform: WorldTransform): void {
    const node = modelData.nodes![nodeIdx];
    const world = composeTransforms(parentTransform, node);
    worldTransforms[nodeIdx] = world;

    if (node.children) {
      for (const childIdx of node.children) {
        traverse(childIdx, world);
      }
    }
  }

  for (const rootIdx of rootIndices) {
    traverse(rootIdx, identityTransform());
  }

  // Apply world transforms to mesh vertices and normals.
  for (let i = 0; i < modelData.nodes.length; i++) {
    const node = modelData.nodes[i];
    if (node.mesh === undefined || node.mesh >= modelData.meshes.length) continue;

    const mesh = modelData.meshes[node.mesh];
    const wt = worldTransforms[i];

    // Skip identity transforms (common for root nodes) to avoid unnecessary work.
    const isIdentity =
      wt.translation[0] === 0 && wt.translation[1] === 0 && wt.translation[2] === 0 &&
      wt.rotation[0] === 0 && wt.rotation[1] === 0 && wt.rotation[2] === 0 && wt.rotation[3] === 1 &&
      wt.scale[0] === 1 && wt.scale[1] === 1 && wt.scale[2] === 1;
    if (isIdentity) continue;

    const verts = mesh.vertices;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const px = verts[v * 6];
      const py = verts[v * 6 + 1];
      const pz = verts[v * 6 + 2];
      // Apply scale, then rotation, then translation.
      const scaled: Vec3 = [px * wt.scale[0], py * wt.scale[1], pz * wt.scale[2]];
      const rotated = qrotate(wt.rotation, scaled);
      verts[v * 6] = rotated[0] + wt.translation[0];
      verts[v * 6 + 1] = rotated[1] + wt.translation[1];
      verts[v * 6 + 2] = rotated[2] + wt.translation[2];

      // Transform normals (rotation only — no translation, and scale doesn't
      // affect direction for uniform scale; for non-uniform scale we'd need
      // inverse-transpose, but FBX character rigs typically use uniform scale).
      const nx = verts[v * 6 + 3];
      const ny = verts[v * 6 + 4];
      const nz = verts[v * 6 + 5];
      const rotatedN = qrotate(wt.rotation, [nx, ny, nz]);
      verts[v * 6 + 3] = rotatedN[0];
      verts[v * 6 + 4] = rotatedN[1];
      verts[v * 6 + 5] = rotatedN[2];
    }
  }
}

export interface ModelEntry {
  id: string;
  name: string;
  path: string;
  filename: string;
  source: "direct" | "unitypackage";
}

export interface PartInfo {
  nodeIndex: number;
  name: string;
  meshIndex: number | undefined;
  vertexCount: number;
  triangleCount: number;
  hasMesh: boolean;
  children?: number[]; // child nodeIndices (for grouping in the parts tree)
  parent?: number;     // parent nodeIndex (root nodes have undefined parent)
}

export interface ModelStats {
  meshCount: number;
  totalVertices: number;
  totalTriangles: number;
  hasTexture: boolean;
  hasSkin: boolean;
  boneCount: number;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
  parts: PartInfo[];
  animations: AnimationData[];
  rootNodes: number[]; // top-level nodeIndices
}

export interface LoadedModel {
  data: ModelData;
  stats: ModelStats;
  nodeId: string;
}

// Scan the assets directory for available models
export async function discoverModels(assetBase: string): Promise<ModelEntry[]> {
  const entries: ModelEntry[] = [];

  // Known model locations in the UNSORTED directory
  const knownPaths = [
    { dir: "/Aisha/mesh", name: "Aisha", file: "Aisha.fbx" },
    { dir: "/Stylized Lowpoly Characters/mesh", name: "LP_fe_mesh", file: "LP_fe_mesh.fbx" },
    { dir: "/Stylized Lowpoly Characters/mesh", name: "LP_male_mesh", file: "LP_male_mesh.fbx" },
  ];

  for (const known of knownPaths) {
    const path = `${assetBase}${known.dir}/${known.file}`.replace(/\s/g, "%20");
    try {
      const resp = await fetch(path, { headers: { Range: "bytes=0-0" } });
      if (resp.ok || resp.status === 206) {
        entries.push({
          id: known.name,
          name: known.name,
          path,
          filename: known.file,
          source: "direct",
        });
      }
    } catch {
      // skip
    }
  }

  // Also check for unitypackage
  const unitypkgPath = `${assetBase}/${encodeURIComponent("aisha & stylized_unity_6.5_.unitypackage")}`;
  try {
    const resp = await fetch(unitypkgPath);
    if (resp.ok) {
      const pkgData = await resp.arrayBuffer();
      const pkgEntries = extractUnityPackage(pkgData);
      const fbxEntries = pkgEntries.filter(
        (e) => e.pathname.toLowerCase().endsWith(".fbx") &&
               e.pathname.toLowerCase().includes("mesh"),
      );
      for (const entry of fbxEntries) {
        const basename = entry.pathname.split("/").pop()!;
        entries.push({
          id: `unitypkg:${basename}`,
          name: `unitypkg: ${basename}`,
          path: unitypkgPath,
          filename: basename,
          source: "unitypackage",
        });
      }
    }
  } catch {
    // skip
  }

  return entries;
}

// Texture search paths relative to asset base
const TEXTURE_SEARCH_PATHS = [
  "/Aisha/texture",
  "/Stylized Lowpoly Characters/textue",
];

export async function loadModelWithTextures(
  entry: ModelEntry,
  assetBase: string,
): Promise<LoadedModel> {
  let data: ArrayBuffer;

  if (entry.source === "unitypackage") {
    const resp = await fetch(entry.path);
    const pkgData = await resp.arrayBuffer();
    const pkgEntries = extractUnityPackage(pkgData);
    const fbxEntry = pkgEntries.find(
      (e) => e.pathname.split("/").pop() === entry.filename,
    );
    if (!fbxEntry || !fbxEntry.asset) throw new Error(`FBX not found in unitypackage: ${entry.filename}`);
    data = fbxEntry.asset.slice().buffer;
  } else {
    const resp = await fetch(entry.path);
    if (!resp.ok) throw new Error(`Failed to fetch: ${entry.path}`);
    data = await resp.arrayBuffer();
  }

  const modelData = await loadModel(data, entry.filename);
  await loadExternalTextures(modelData, assetBase);

  // Bake per-node transforms (translation, rotation, PreRotation, scale) into
  // mesh vertices so all meshes are in a consistent model-space coordinate
  // system. Without this, mesh-bearing nodes with non-identity transforms
  // (especially PreRotation) render with wrong rotation/position because the
  // ModelRenderer only applies a single root-level transform.
  bakeNodeTransforms(modelData);

  // Compute stats
  let totalVerts = 0;
  let totalTris = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const mesh of modelData.meshes) {
    totalVerts += mesh.vertexCount;
    totalTris += mesh.indexCount / 3;
    const verts = mesh.vertices;
    const stride = 6;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = verts[i * stride];
      const y = verts[i * stride + 1];
      const z = verts[i * stride + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }

  const hasTexture = modelData.materials?.some((m: MaterialData) => m.textureData && m.textureData.byteLength > 0) ?? false;
  const hasSkin = !!modelData.skin;
  const boneCount = modelData.skin?.bones.length ?? 0;

  // Build parts list from node tree
  const parts: PartInfo[] = [];
  const rootNodes: number[] = [];
  if (modelData.nodes) {
    for (let i = 0; i < modelData.nodes.length; i++) {
      const node = modelData.nodes[i];
      const meshIdx = node.mesh;
      const hasMesh = meshIdx !== undefined && meshIdx < modelData.meshes.length;
      const mesh = hasMesh ? modelData.meshes[meshIdx!] : null;
      parts.push({
        nodeIndex: i,
        name: node.name,
        meshIndex: meshIdx,
        hasMesh,
        vertexCount: mesh?.vertexCount ?? 0,
        triangleCount: mesh ? Math.floor(mesh.indexCount / 3) : 0,
        children: node.children,
      });
    }
    // Resolve parent indices and collect root nodes
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.children) {
        for (const c of p.children) {
          if (parts[c]) parts[c].parent = i;
        }
      }
    }
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].parent === undefined) rootNodes.push(i);
    }
  }

  return {
    data: modelData,
    stats: {
      meshCount: modelData.meshes.length,
      totalVertices: totalVerts,
      totalTriangles: Math.floor(totalTris),
      hasTexture,
      hasSkin,
      boneCount,
      bounds: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
      parts,
      animations: modelData.animations ?? [],
      rootNodes,
    },
    nodeId: entry.id.replace(/[^a-zA-Z0-9]/g, "_"),
  };
}

async function loadExternalTextures(modelData: ModelData, assetBase: string): Promise<void> {
  if (!modelData.materials) return;

  for (let mi = 0; mi < modelData.materials.length; mi++) {
    const mat = modelData.materials[mi];
    // Check if embedded textureData is browser-decodable (PNG/JPEG/WebP)
    let hasDecodableEmbedded = false;
    if (mat.textureData && mat.textureData.byteLength > 4) {
      const bytes = new Uint8Array(mat.textureData, 0, 4);
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) hasDecodableEmbedded = true;
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) hasDecodableEmbedded = true;
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) hasDecodableEmbedded = true;
    }

    if (hasDecodableEmbedded) continue;

    // Try to find an external replacement
    let foundExternal = false;
    if (mat.textureUri) {
      for (const searchPath of TEXTURE_SEARCH_PATHS) {
        const url = `${assetBase}${searchPath}/${mat.textureUri}`.replace(/\s/g, "%20");
        try {
          const resp = await fetch(url);
          if (!resp.ok) continue;
          const data = await resp.arrayBuffer();
          // Verify the data is actually an image (PNG/JPEG/WebP), not an HTML
          // fallback page (Vite's SPA fallback returns 200 + HTML for missing files).
          if (data.byteLength > 4) {
            const bytes = new Uint8Array(data, 0, 4);
            const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
            const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
            const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
            if (!isPng && !isJpeg && !isWebp) continue;
            mat.textureData = data;
            foundExternal = true;
            console.log(`[Textures] Material[${mi}] "${mat.name}": loaded ${mat.textureUri} (${data.byteLength} bytes) from ${searchPath}`);
            break;
          }
        } catch {
          // try next
        }
      }
    }

    // If no decodable embedded and no external found, clear textureData
    // to prevent createImageBitmap from failing on unsupported formats (TGA, BMP, etc.)
    if (!foundExternal && mat.textureData && !hasDecodableEmbedded) {
      mat.textureData = null;
    }
  }
}

// ── Unitypackage extraction ──

interface UnityPackageEntry {
  guid: string;
  pathname: string;
  asset: Uint8Array | null;
}

function extractUnityPackage(data: ArrayBuffer): UnityPackageEntry[] {
  const compressed = new Uint8Array(data);
  const decompressed = gunzipSync(compressed);
  return parseTar(decompressed);
}

function parseTar(data: Uint8Array): UnityPackageEntry[] {
  const entries: UnityPackageEntry[] = [];
  let offset = 0;
  let currentPathname = "";
  let currentSize = 0;
  let currentGuid = "";

  while (offset < data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const name = strFromU8(header.subarray(0, 100)).replace(/\0/g, "");
    const sizeStr = strFromU8(header.subarray(124, 136)).replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = strFromU8(header.subarray(156, 157)).replace(/\0/g, "");

    if (typeflag === "5") {
      // directory — skip
    } else if (name === "././@PaxHeader") {
      // Parse PAX header for pathname
      const paxData = data.subarray(offset + 512, offset + 512 + size);
      const paxStr = strFromU8(paxData);
      const pathMatch = paxStr.match(/path=(.+)/);
      if (pathMatch) currentPathname = pathMatch[1].trim();
    } else if (name.startsWith("./") && typeflag !== "x") {
      currentPathname = name;
    }

    if (currentPathname && currentPathname.endsWith("asset.asset") && size > 0 && typeflag !== "x") {
      const assetData = data.subarray(offset + 512, offset + 512 + size);
      const guidMatch = currentPathname.match(/asset-([a-f0-9]+)/);
      currentGuid = guidMatch ? guidMatch[1] : "";
      const pathname = currentPathname.replace(/^.*?asset\.asset$/, "").replace(/^\/+/, "");
      entries.push({ guid: currentGuid, pathname: pathname || currentPathname, asset: new Uint8Array(assetData) });
    }

    // Advance to next entry (512-byte aligned)
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return entries;
}
