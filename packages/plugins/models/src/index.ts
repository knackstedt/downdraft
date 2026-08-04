// ============================================================================
// Model Loading Plugin — format parsers for FBX, GLTF/GLB, OBJ, DAE, STL
// ============================================================================
// Pure parsers: ArrayBuffer + filename → ModelData (synchronous)
// Async loaders: URI → fetch → parse (for AssetManager integration)
//

import type { Plugin, PluginContext } from "@downdraft/core";
import { parseDAE } from "./dae";
import { parseFBX } from "./fbx";
import { parseGLTF } from "./gltf";
import { parseOBJ } from "./obj";
import { parsePLY } from "./ply";
import { parseSTL } from "./stl";
import { parse3DS } from "./threeds";
import { detectFormat } from "./types";

export { parseDAE } from "./dae";
export { parseFBX } from "./fbx";
export { getSupportedExtensions, isExtensionSupported, parseAnimationEvents, parseMorphTargets, processMaterialExtensions, processMeshPrimitiveExtensions } from "./gltf-extensions";
export { parseGLTF } from "./gltf";
export { parseOBJ } from "./obj";
export { parsePLY } from "./ply";
export { parseSTL } from "./stl";
export { parse3DS } from "./threeds";
export { detectFormat } from "./types";
export type {
    AnimationChannel, AnimationData, AnimationEvent, BoneData, MaterialData, MeshData, ModelData,
    ModelFormat, ModelNode, MorphTargetData,
    SkinData
} from "./types";

export { loadModel } from "./loader";

export type { ModelLoaderOptions } from "./loader";

import { createModelAsyncLoader, loadModel, registerModelLoaders } from "./loader";

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
