// ============================================================================
// Model Loader — parser dispatch + async loader helpers
// ============================================================================
// glTF/GLB parsing is async (codec dispatch for Draco/meshopt). Other formats
// remain synchronous but are wrapped in async for uniform call sites.
//

import type { AssetManager } from "@downdraft/core";
import type { GLTFCodecRegistry } from "./codecs/registry";
import { getDefaultCodecRegistry } from "./codecs/registry";
import { parseDAE } from "./dae";
import { parseFBX } from "./fbx";
import { parseGLTF } from "./gltf";
import { parseOBJ } from "./obj";
import { parsePLY } from "./ply";
import { parseSTL } from "./stl";
import { parse3DS } from "./threeds";
import type { ModelData } from "./types";
import { detectFormat } from "./types";

export interface ModelLoaderOptions {
  fetchFn?: (uri: string) => Promise<Response>;
  mtlResolver?: (uri: string) => Promise<ArrayBuffer | null>;
  binResolver?: (uri: string) => Promise<ArrayBuffer | null>;
  /** Codec registry for glTF extension decoding (Draco, meshopt, basisu, etc.). */
  codecRegistry?: GLTFCodecRegistry;
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

  switch (format) {
    case "obj":
      return parseOBJ(data, baseName, mtlData);
    case "gltf":
      return parseGLTF(data, baseName, false, binData, { registry });
    case "glb":
      return parseGLTF(data, baseName, true, null, { registry });
    case "fbx":
      return parseFBX(data, baseName);
    case "dae":
      return parseDAE(data, baseName);
    case "stl":
      return parseSTL(data, baseName);
    case "ply":
      return parsePLY(data, baseName);
    case "3ds":
      return parse3DS(data, baseName);
  }
}

async function defaultFetch(uri: string): Promise<Response> {
  return fetch(uri);
}

export function createModelAsyncLoader(opts: ModelLoaderOptions = {}) {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const registry = opts.codecRegistry ?? getDefaultCodecRegistry();

  return async function loadModelAsync(uri: string): Promise<ModelData> {
    const filename = uri.split("/").pop() ?? uri;
    const format = detectFormat(filename);
    if (!format) throw new Error(`Unknown model format: ${filename}`);

    const resp = await fetchFn(uri);
    if (!resp.ok) throw new Error(`Failed to fetch ${uri}: ${resp.status}`);
    const data = await resp.arrayBuffer();
    const baseName = filename.replace(/\.[^.]+$/, "");

    switch (format) {
      case "obj": {
        let mtlData: ArrayBuffer | null = null;
        if (opts.mtlResolver) {
          const mtlUri = uri.replace(/\.[^.]+$/, ".mtl");
          mtlData = await opts.mtlResolver(mtlUri);
        }
        return parseOBJ(data, baseName, mtlData);
      }
      case "gltf": {
        let binData: ArrayBuffer | null = null;
        if (opts.binResolver) {
          const binUri = uri.replace(/\.[^.]+$/, ".bin");
          binData = await opts.binResolver(binUri);
        }
        return parseGLTF(data, baseName, false, binData, { registry });
      }
      case "glb":
        return parseGLTF(data, baseName, true, null, { registry });
      case "fbx":
        return parseFBX(data, baseName);
      case "dae":
        return parseDAE(data, baseName);
      case "stl":
        return parseSTL(data, baseName);
      case "ply":
        return parsePLY(data, baseName);
      case "3ds":
        return parse3DS(data, baseName);
    }
  };
}

export function registerModelLoaders(
  assetManager: AssetManager,
  opts: ModelLoaderOptions = {},
): void {
  const loader = createModelAsyncLoader(opts);
  const extensions = ["fbx", "gltf", "glb", "obj", "dae", "stl", "ply", "3ds"];
  for (const ext of extensions) {
    assetManager.registerLoader(ext, loader);
  }
}
