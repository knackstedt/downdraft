// ============================================================================
// Model Loading Plugin — format parsers for FBX, GLTF/GLB, OBJ, DAE, STL
// ============================================================================
// Pure parsers: ArrayBuffer + filename → ModelData (synchronous)
// Async loaders: URI → fetch → parse (for AssetManager integration)
//

import type { AssetManager } from "@downdraft/core";
import type { Plugin, PluginContext } from "@downdraft/core";
import { detectFormat } from "./types.ts";
import { parseOBJ } from "./obj.ts";
import { parseGLTF } from "./gltf.ts";
import { parseFBX } from "./fbx.ts";
import { parseDAE } from "./dae.ts";
import { parseSTL } from "./stl.ts";

export { detectFormat } from "./types.ts";
export type {
  MeshData,
  MaterialData,
  ModelData,
  ModelFormat,
  AnimationData,
  AnimationChannel,
  ModelNode,
  SkinData,
  BoneData,
} from "./types.ts";
export { parseOBJ } from "./obj.ts";
export { parseGLTF } from "./gltf.ts";
export { parseFBX } from "./fbx.ts";
export { parseDAE } from "./dae.ts";
export { parseSTL } from "./stl.ts";

export { loadModel } from "./loader.ts";

export type { ModelLoaderOptions } from "./loader.ts";

import { loadModel, createModelAsyncLoader, registerModelLoaders } from "./loader.ts";

export { createModelAsyncLoader, registerModelLoaders };

export const ModelsPlugin: Plugin = {
  name: "models",
  version: "0.1.0",
  register(ctx: PluginContext) {
    ctx.registerResource("modelParsers", {
      loadModel,
      detectFormat,
      parseOBJ,
      parseGLTF,
      parseFBX,
      parseDAE,
      parseSTL,
    });
  },
};
