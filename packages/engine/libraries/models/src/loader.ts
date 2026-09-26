// ============================================================================
// Model Loader — parser dispatch + async loader helpers
// ============================================================================
// glTF/GLB parsing is async (codec dispatch for Draco/meshopt). Other formats
// remain synchronous but are wrapped in async for uniform call sites.
//

import type { AssetManager } from "@downdraft/engine";
import { MAX_FETCH_SIZE } from "@downdraft/engine";
import type { GLTFCodecRegistry } from "./codecs/registry";
import { getDefaultCodecRegistry } from "./codecs/registry";
import { parseDAE } from "./dae";
import { parseDXF } from "./dxf";
import { parseFBX } from "./fbx";
import { parseGLTF } from "./gltf";
import { normalizeModel, normalizeModelWithResolution, resolveImportSettingsSync } from "./normalize";
import { parseOBJ } from "./obj";
import { parseOFF } from "./off";
import { parsePLY } from "./ply";
import { synthesizeSkeletonSkin } from "./skeleton-synthesis";
import { parseSTL } from "./stl";
import { parse3DS } from "./threeds";
import { parse3MF } from "./threemf";
import type { ModelData } from "./types";
import { detectFormat } from "./types";
import { parseVTK } from "./vtk";

/**
 * Companion filename declared inside the model file — `mtllib` for OBJ and
 * `buffers[0].uri` for glTF. Real assets frequently name sidecars something
 * other than `<stem>.mtl`/`<stem>.bin`, so resolve the declared name first.
 */
export function declaredCompanionUri(data: ArrayBuffer, format: string): string | null {
  if (format === "obj") {
    const m = new TextDecoder().decode(data.slice(0, 65536)).match(/^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/m);
    // mtllib can be a space-separated list; take the first entry.
    return m?.[1]?.split(/\s+/)[0] ?? null;
  }
  if (format === "gltf") {
    try {
      const json = JSON.parse(new TextDecoder().decode(data));
      const uri = json?.buffers?.[0]?.uri;
      return typeof uri === "string" && !uri.startsWith("data:") ? uri : null;
    } catch { return null; }
  }
  return null;
}

export interface ModelLoaderOptions {
  fetchFn?: (uri: string) => Promise<Response>;
  mtlResolver?: (uri: string) => Promise<ArrayBuffer | null>;
  binResolver?: (uri: string) => Promise<ArrayBuffer | null>;
  /** Codec registry for glTF extension decoding (Draco, meshopt, basisu, etc.). */
  codecRegistry?: GLTFCodecRegistry;
  /**
   * Whether to normalize the model after parsing (up-axis conversion, unit
   * scaling, node-transform baking, bounds computation). Default: true.
   * Set to false for games that handle their own transforms.
   */
  normalize?: boolean;
  /**
   * Custom sidecar resolver. If not provided, the default resolver fetches
   * .ddmeta.json, Unity .meta, and Godot .import files relative to the model
   * path. Pass a custom resolver to integrate with a cache or custom storage.
   */
  sidecarResolver?: (modelPath: string, modelData: ModelData) => Promise<import("./sidecar/types").ImportSettings>;
}

export async function loadModel(
  data: ArrayBuffer,
  filename: string,
  mtlData?: ArrayBuffer | null,
  binData?: ArrayBuffer | null,
  options?: ModelLoaderOptions,
): Promise<ModelData> {
  const format = detectFormat(filename);
  if (!format) throw new Error(`Unknown model format: ${filename}`);

  const baseName = filename.replace(/\.[^.]+$/, "");
  const registry = options?.codecRegistry ?? getDefaultCodecRegistry();
  const shouldNormalize = options?.normalize ?? true;

  let modelData: ModelData;
  switch (format) {
    case "obj":
      modelData = parseOBJ(data, baseName, mtlData);
      break;
    case "gltf":
      modelData = await parseGLTF(data, baseName, false, binData, { registry });
      break;
    case "glb":
      modelData = await parseGLTF(data, baseName, true, null, { registry });
      break;
    case "fbx":
      modelData = parseFBX(data, baseName);
      break;
    case "dae":
      modelData = parseDAE(data, baseName);
      break;
    case "stl":
      modelData = parseSTL(data, baseName);
      break;
    case "ply":
      modelData = parsePLY(data, baseName);
      break;
    case "3ds":
      modelData = parse3DS(data, baseName);
      break;
    case "off":
      modelData = parseOFF(data, baseName);
      break;
    case "vtk":
      modelData = parseVTK(data, baseName);
      break;
    case "dxf":
      modelData = parseDXF(data, baseName);
      break;
    case "3mf":
      modelData = parse3MF(data, baseName);
      break;
    default:
      throw new Error(`Unknown model format: ${filename}`);
  }

  synthesizeSkeletonIfNeeded(modelData);

  if (!shouldNormalize) return modelData;

  // Use custom sidecar resolver if provided, otherwise use sync parser defaults.
  // The async path (normalizeModelWithResolution) is used by createModelAsyncLoader
  // which has the full URI for sidecar fetching.
  if (options?.sidecarResolver) {
    const settings = await options.sidecarResolver(filename, modelData);
    return normalizeModel(modelData, settings);
  }

  // Synchronous fallback: use parser-detected defaults (no sidecar fetching)
  const settings = resolveImportSettingsSync(modelData);
  return normalizeModel(modelData, settings);
}

async function defaultFetch(uri: string): Promise<Response> {
  return fetch(uri);
}

/**
 * Animation-only / skeleton-only files (e.g. Mixamo clip exports) carry a
 * node hierarchy but no skin deformers and no meshes. Synthesize a SkinData
 * from the node tree so viewers, animators, and retargeting can use it.
 * Runs before normalization so skin.normalizationMatrix is accumulated.
 */
function synthesizeSkeletonIfNeeded(modelData: ModelData): void {
  if (modelData.skin || modelData.meshes.length > 0 || !modelData.nodes?.length) return;
  modelData.skin = synthesizeSkeletonSkin(
    modelData.nodes,
    modelData.animations ?? [],
    modelData.sourceUpAxis,
  );
}

export function createModelAsyncLoader(opts: ModelLoaderOptions = {}) {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const registry = opts.codecRegistry ?? getDefaultCodecRegistry();
  const shouldNormalize = opts.normalize ?? true;

  return async function loadModelAsync(uri: string): Promise<ModelData> {
    const filename = uri.split("/").pop() ?? uri;
    const format = detectFormat(filename);
    if (!format) throw new Error(`Unknown model format: ${filename}`);

    const resp = await fetchFn(uri);
    if (!resp.ok) throw new Error(`Failed to fetch ${uri}: ${resp.status}`);
    // Abort if Content-Length exceeds the maximum fetch size
    const contentLength = parseInt(resp.headers.get("Content-Length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_SIZE) {
      throw new RangeError(
        `Model fetch ${uri}: Content-Length ${contentLength} exceeds max ${MAX_FETCH_SIZE}`,
      );
    }
    const data = await resp.arrayBuffer();
    const baseName = filename.replace(/\.[^.]+$/, "");

    let modelData: ModelData;
    switch (format) {
      case "obj": {
        let mtlData: ArrayBuffer | null = null;
        if (opts.mtlResolver) {
          const dir = uri.slice(0, uri.lastIndexOf("/") + 1);
          const declared = declaredCompanionUri(data, "obj");
          if (declared) mtlData = await opts.mtlResolver(dir + decodeURIComponent(declared));
          mtlData ??= await opts.mtlResolver(uri.replace(/\.[^.]+$/, ".mtl"));
        }
        modelData = parseOBJ(data, baseName, mtlData);
        break;
      }
      case "gltf": {
        let binData: ArrayBuffer | null = null;
        if (opts.binResolver) {
          const dir = uri.slice(0, uri.lastIndexOf("/") + 1);
          const declared = declaredCompanionUri(data, "gltf");
          if (declared) binData = await opts.binResolver(dir + decodeURIComponent(declared));
          binData ??= await opts.binResolver(uri.replace(/\.[^.]+$/, ".bin"));
        }
        modelData = await parseGLTF(data, baseName, false, binData, { registry });
        break;
      }
      case "glb":
        modelData = await parseGLTF(data, baseName, true, null, { registry });
        break;
      case "fbx":
        modelData = parseFBX(data, baseName);
        break;
      case "dae":
        modelData = parseDAE(data, baseName);
        break;
      case "stl":
        modelData = parseSTL(data, baseName);
        break;
      case "ply":
        modelData = parsePLY(data, baseName);
        break;
      case "3ds":
        modelData = parse3DS(data, baseName);
        break;
      case "off":
        modelData = parseOFF(data, baseName);
        break;
      case "vtk":
        modelData = parseVTK(data, baseName);
        break;
      case "dxf":
        modelData = parseDXF(data, baseName);
        break;
      case "3mf":
        modelData = parse3MF(data, baseName);
        break;
      default:
        throw new Error(`Unknown model format: ${filename}`);
    }

    synthesizeSkeletonIfNeeded(modelData);

    if (!shouldNormalize) return modelData;

    // Use custom sidecar resolver if provided
    if (opts.sidecarResolver) {
      const settings = await opts.sidecarResolver(uri, modelData);
      return normalizeModel(modelData, settings);
    }

    // Default: async sidecar resolution (fetches .ddmeta.json, .meta, .import)
    return normalizeModelWithResolution(modelData, uri, { fetchFn });
  };
}

export function registerModelLoaders(
  assetManager: AssetManager,
  opts: ModelLoaderOptions = {},
): void {
  const loader = createModelAsyncLoader(opts);
  const extensions = ["fbx", "gltf", "glb", "obj", "dae", "stl", "ply", "3ds", "off", "vtk", "dxf", "3mf"];
  for (const ext of extensions) {
    assetManager.registerLoader(ext, loader);
  }
}
