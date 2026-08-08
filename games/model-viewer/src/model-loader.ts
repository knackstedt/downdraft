import { loadModel, type AnimationData, type MaterialData, type ModelData } from "@downdraft/plugin-models";
import { gunzipSync, strFromU8 } from "fflate";

export type { AnimationData };

// Node-transform baking, up-axis conversion, and unit scaling are now handled
// by the engine's normalization pipeline in @downdraft/plugin-models
// (loadModel → normalizeModel → bakeNodeTransforms). The local quaternion
// helpers and bakeNodeTransforms function have been removed.

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

  // Node-transform baking is now handled by the engine's normalization
  // pipeline (loadModel → normalizeModel → bakeNodeTransforms). The local
  // bakeNodeTransforms function is no longer needed here.

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
