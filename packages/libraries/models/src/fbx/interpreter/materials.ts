// ============================================================================
// FBX Materials + Textures — MaterialData[] extraction
// ============================================================================
// Extracts material colors and textures from Material/Video/Texture nodes
// via the connection graph. Maps FBX Phong/Lambert properties to our
// MaterialData (baseColor, metallic, roughness, emissive, textures).
//

import type { MaterialData } from "../../types";
import type { FBXNode } from "../types";
import { childNode, findNodesInTree } from "../types";
import type { FBXConnectionGraph } from "./connections";
import { getObjectId } from "./connections";
import type { DiagnosticsCollector } from "./diagnostics";

interface FBXTextureInfo {
  textureData?: Uint8Array;
  textureUri?: string;
  normalTextureUri?: string;
  emissiveTextureUri?: string;
}

/**
 * Parse all materials from the FBX node tree.
 *
 * @returns MaterialData[] and a map of material node index → texture info.
 */
export function parseMaterials(
  nodes: FBXNode[],
  graph: FBXConnectionGraph,
  diag: DiagnosticsCollector,
): { materials: MaterialData[] | undefined; materialTextures: Map<number, FBXTextureInfo> } {
  const materialNodes = findNodesInTree(nodes, "Material");
  if (materialNodes.length === 0) {
    return { materials: undefined, materialTextures: new Map() };
  }

  const videoNodes = findNodesInTree(nodes, "Video");
  const textureNodes = findNodesInTree(nodes, "Texture");

  // Build video info map: videoId → { data?, filename? }
  const videoInfo = new Map<string, { data?: Uint8Array; filename?: string }>();
  for (let i = 0; i < videoNodes.length; i++) {
    const node = videoNodes[i];
    const id = getObjectId(node, `video_${i}`);
    const info = extractVideoInfo(node);
    if (info.data || info.filename) {
      videoInfo.set(id, info);
    }
  }

  // Build texture → video mapping via connections
  const textureToVideo = new Map<string, string>();
  for (let i = 0; i < textureNodes.length; i++) {
    const texId = getObjectId(textureNodes[i], `tex_${i}`);
    // Connection can be either direction: Texture→Video or Video→Texture
    for (const conn of graph.connections) {
      if (conn.childId === texId && videoInfo.has(conn.parentId)) {
        textureToVideo.set(texId, conn.parentId);
        break;
      }
      if (conn.parentId === texId && videoInfo.has(conn.childId)) {
        textureToVideo.set(texId, conn.childId);
        break;
      }
    }
  }

  // Build material index → texture info via OP connections
  const materialTextures = new Map<number, FBXTextureInfo>();

  const materials: MaterialData[] = [];
  for (let i = 0; i < materialNodes.length; i++) {
    const matNode = materialNodes[i];
    const matId = getObjectId(matNode, `mat_${i}`);
    const matName = extractMaterialName(matNode, `material_${i}`);

    // Extract material color from Properties70
    const props = extractMaterialProperties(matNode);

    // Find connected textures
    const texInfo: FBXTextureInfo = {};
    for (const conn of graph.connections) {
      if (conn.parentId !== matId) continue;
      const videoId = textureToVideo.get(conn.childId);
      if (!videoId) continue;

      const info = videoInfo.get(videoId);
      if (!info) continue;

      const propLower = (conn.property ?? "").toLowerCase();

      if (propLower.includes("diffuse") || conn.property === "") {
        if (info.data) texInfo.textureData = info.data;
        if (info.filename) {
          texInfo.textureUri = info.filename.replace(/[\\/]/g, "/").split("/").pop() ?? info.filename;
        }
      } else if (propLower.includes("normal") || propLower.includes("bump")) {
        if (info.filename) {
          texInfo.normalTextureUri = info.filename.replace(/[\\/]/g, "/").split("/").pop() ?? info.filename;
        }
      } else if (propLower.includes("emissive")) {
        if (info.filename) {
          texInfo.emissiveTextureUri = info.filename.replace(/[\\/]/g, "/").split("/").pop() ?? info.filename;
        }
      }
    }

    if (texInfo.textureData || texInfo.textureUri || texInfo.normalTextureUri || texInfo.emissiveTextureUri) {
      materialTextures.set(i, texInfo);
    }

    materials.push({
      name: matName,
      baseColor: [props.diffuse[0], props.diffuse[1], props.diffuse[2], props.opacity ?? 1],
      metallic: 0,
      roughness: 1,
      textureData: texInfo.textureData
        ? (texInfo.textureData.slice().buffer as ArrayBuffer)
        : null,
      textureUri: texInfo.textureUri,
      normalTextureUri: texInfo.normalTextureUri,
      emissiveColor: props.emissive,
    });
  }

  diag.debug("materials", `Parsed ${materials.length} materials, ${materialTextures.size} with textures`);

  return { materials, materialTextures };
}

/** Extract embedded content and filename from a Video node. */
function extractVideoInfo(node: FBXNode): { data?: Uint8Array; filename?: string } {
  let data: Uint8Array | undefined;
  let filename: string | undefined;

  for (const child of node.children) {
    const childNameLower = child.name.toLowerCase();
    if (childNameLower === "content" && child.properties.length > 0) {
      const prop = child.properties[0];
      if (prop.type === "R" && prop.value instanceof Uint8Array && prop.value.length > 0) {
        data = prop.value;
      }
    } else if (childNameLower === "filename" && child.properties.length > 0) {
      filename = String(child.properties[0].value);
    } else if (childNameLower === "relativefilename" && child.properties.length > 0 && !filename) {
      filename = String(child.properties[0].value);
    }
  }

  // Also check the Video node's own properties for a filename
  if (!filename && node.properties.length >= 2) {
    for (const prop of node.properties) {
      if (prop.type === "S") {
        const val = String(prop.value);
        if (val.match(/\.(png|jpg|jpeg|tga|bmp|webp)$/i)) {
          filename = val;
          break;
        }
      }
    }
  }

  return { data, filename };
}

/** Extract the material name from a Material node. */
function extractMaterialName(node: FBXNode, fallback: string): string {
  if (node.properties.length >= 2 && node.properties[1].type === "S") {
    return String(node.properties[1].value);
  }
  return fallback;
}

interface MaterialProps {
  diffuse: [number, number, number];
  emissive?: [number, number, number];
  opacity?: number;
}

/** Convert a single linear-space channel to sRGB for display. */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Convert a linear-space [r, g, b] color to sRGB. */
function linearColorToSrgb(rgb: [number, number, number]): [number, number, number] {
  return [linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2])];
}

/** Extract diffuse color, emissive color, and opacity from a Material node's Properties70.
 *
 * Blender 4.x exports DiffuseColor in linear space (see Blender bug #128498).
 * The renderer's shader does simple sRGB-space multiplication (texture ×
 * vertexColor × lighting × baseColor) and outputs to a non-sRGB swapchain.
 * Textures are sRGB (rgba8unorm). To keep solid colors consistent with
 * textured colors, we convert DiffuseColor/EmissiveColor from linear to sRGB
 * here, so the shader can treat all inputs uniformly as sRGB.
 *
 * Transparency handling: FBX/3ds Max uses two conventions — `TransparencyFactor`
 * (0 = opaque, 1 = transparent) and `Opacity` (0 = transparent, 1 = opaque).
 * Both are normalized to the `Opacity` convention (alpha) on output.
 */
export function extractMaterialProperties(node: FBXNode): MaterialProps {
  const props70 = childNode(node, "Properties70");
  if (!props70) return { diffuse: [1, 1, 1] };

  let diffuse: [number, number, number] = [1, 1, 1];
  let emissive: [number, number, number] | undefined;
  let opacity: number | undefined;

  for (const p of props70.children) {
    if (p.name !== "P" || p.properties.length < 5) continue;
    const propName = String(p.properties[0].value);
    const propLower = propName.toLowerCase();

    if (propLower === "diffuse" || propLower === "diffusecolor" || propLower === "color") {
      diffuse = linearColorToSrgb([
        p.properties[4].value as number,
        p.properties[5].value as number,
        p.properties[6].value as number,
      ]);
    } else if (propLower === "emissive" || propLower === "emissivecolor") {
      emissive = linearColorToSrgb([
        p.properties[4].value as number,
        p.properties[5].value as number,
        p.properties[6].value as number,
      ]);
    } else if (propLower === "transparencyfactor") {
      // TransparencyFactor uses the 3ds Max convention: 0 = opaque, 1 = fully
      // transparent. Convert to opacity (alpha) so the rest of the pipeline
      // can treat `opacity` uniformly as 0 = transparent, 1 = opaque.
      opacity = 1 - (p.properties[4].value as number);
    } else if (propLower === "opacity") {
      // Opacity is already in alpha convention: 0 = transparent, 1 = opaque.
      opacity = p.properties[4].value as number;
    }
  }

  return { diffuse, emissive, opacity };
}

/**
 * Get the diffuse color for a material index.
 * Used by the geometry interpreter for vertex colors when no texture is present.
 */
export function getMaterialColor(
  materialIndex: number,
  materials: MaterialData[] | undefined,
): [number, number, number] {
  if (!materials || materialIndex >= materials.length) return [1, 1, 1];
  const mat = materials[materialIndex];
  return [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]];
}
