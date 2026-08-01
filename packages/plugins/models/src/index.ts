// ============================================================================
// Model Loading Plugin — format parsers for FBX, GLTF/GLB, OBJ, DAE, STL
// ============================================================================
// Pure parsers: ArrayBuffer + filename → ModelData (synchronous)
// Async loaders: URI → fetch → parse (for AssetManager integration)
//

import type { Plugin, PluginContext } from "@downdraft/core";
import { parseDAE } from "./dae.ts";
import { parseFBX } from "./fbx.ts";
import { parseGLTF } from "./gltf.ts";
import { parseOBJ } from "./obj.ts";
import { parsePLY } from "./ply.ts";
import { parseSTL } from "./stl.ts";
import { parse3DS } from "./threeds.ts";
import { detectFormat } from "./types.ts";

export { parseDAE } from "./dae.ts";
export { parseFBX } from "./fbx.ts";
export { getSupportedExtensions, isExtensionSupported, processMaterialExtensions, processMeshPrimitiveExtensions } from "./gltf-extensions.ts";
export { parseGLTF } from "./gltf.ts";
export { parseOBJ } from "./obj.ts";
export { parsePLY } from "./ply.ts";
export { parseSTL } from "./stl.ts";
export { parse3DS } from "./threeds.ts";
export { detectFormat } from "./types.ts";
export type {
    AnimationChannel, AnimationData, BoneData, MaterialData, MeshData, ModelData,
    ModelFormat, ModelNode,
    SkinData
} from "./types.ts";

export { loadModel } from "./loader.ts";

export type { ModelLoaderOptions } from "./loader.ts";

import { createModelAsyncLoader, loadModel, registerModelLoaders } from "./loader.ts";

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
      parsePLY,
      parse3DS,
    });
  },
};
