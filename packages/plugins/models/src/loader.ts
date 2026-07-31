// ============================================================================
// Model Loader — synchronous parser dispatch + async loader helpers
// ============================================================================

import type { AssetManager } from "@downdraft/core";
import { detectFormat } from "./types.ts";
import type { ModelData } from "./types.ts";
import { parseOBJ } from "./obj.ts";
import { parseGLTF } from "./gltf.ts";
import { parseFBX } from "./fbx.ts";
import { parseDAE } from "./dae.ts";
import { parseSTL } from "./stl.ts";

export interface ModelLoaderOptions {
  fetchFn?: (uri: string) => Promise<Response>;
  mtlResolver?: (uri: string) => Promise<ArrayBuffer | null>;
  binResolver?: (uri: string) => Promise<ArrayBuffer | null>;
}

export function loadModel(
  data: ArrayBuffer,
  filename: string,
  mtlData?: ArrayBuffer | null,
  binData?: ArrayBuffer | null,
): ModelData {
  const format = detectFormat(filename);
  if (!format) throw new Error(`Unknown model format: ${filename}`);

  const baseName = filename.replace(/\.[^.]+$/, "");

  switch (format) {
    case "obj":
      return parseOBJ(data, baseName, mtlData);
    case "gltf":
      return parseGLTF(data, baseName, false, binData);
    case "glb":
      return parseGLTF(data, baseName, true);
    case "fbx":
      return parseFBX(data, baseName);
    case "dae":
      return parseDAE(data, baseName);
    case "stl":
      return parseSTL(data, baseName);
  }
}

async function defaultFetch(uri: string): Promise<Response> {
  return fetch(uri);
}

export function createModelAsyncLoader(opts: ModelLoaderOptions = {}) {
  const fetchFn = opts.fetchFn ?? defaultFetch;

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
        return parseGLTF(data, baseName, false, binData);
      }
      case "glb":
        return parseGLTF(data, baseName, true);
      case "fbx":
        return parseFBX(data, baseName);
      case "dae":
        return parseDAE(data, baseName);
      case "stl":
        return parseSTL(data, baseName);
    }
  };
}

export function registerModelLoaders(
  assetManager: AssetManager,
  opts: ModelLoaderOptions = {},
): void {
  const loader = createModelAsyncLoader(opts);
  const extensions = ["fbx", "gltf", "glb", "obj", "dae", "stl"];
  for (const ext of extensions) {
    assetManager.registerLoader(ext, loader);
  }
}
