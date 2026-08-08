// ============================================================================
// Model Loading Plugin — format parsers for FBX, GLTF/GLB, OBJ, DAE, STL
// ============================================================================
// Pure parsers: ArrayBuffer + filename → ModelData (glTF is async due to codec
// dispatch; other formats remain synchronous).
// Async loaders: URI → fetch → parse (for AssetManager integration).
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

// Codec registry + bundled codecs
export {
    configureDracoWasmPath, createBasisuTextureCodec, createDracoMeshCodec,
    createMeshoptBufferViewCodec, getDefaultCodecRegistry, GLTFCodecRegistry, registerDefaultCodecs,
    setDefaultCodecRegistry
} from "./codecs";
export type {
    AccessorLike,
    BufferViewCodec,
    BufferViewCodecInput,
    DecodedPrimitive,
    DracoWasmConfig,
    MeshCodec,
    MeshCodecInput,
    TextureCodec,
    TextureCodecInput,
    TextureCodecOutput
} from "./codecs";

export { parseDAE } from "./dae";
export { parseGLTF } from "./gltf";
export type { ParseGLTFOptions } from "./gltf";
export { extractTextureTransform, getSupportedExtensions, isExtensionSupported, parseAnimationEvents, parseMorphTargets, processMaterialExtensions, processMeshPrimitiveExtensions } from "./gltf-extensions";
export { parseOBJ } from "./obj";
export { parsePLY } from "./ply";
export { parseSTL } from "./stl";
export { parse3DS } from "./threeds";
export { detectFormat, getMaterialVariant } from "./types";
export type {
    AnimationChannel, AnimationData, AnimationEvent, BoneData, MaterialData, MeshData, ModelData,
    ModelFormat, ModelNode, MorphTargetData, PunctualLightData, SkinData, TextureTransform
} from "./types";

export { loadModel } from "./loader";

export type { ModelLoaderOptions } from "./loader";

// Model normalization — import-time correction (up-axis, units, node transforms, bounds)
export { bakeNodeTransforms } from "./bake-node-transforms";
export { normalizeModel, normalizeModelWithResolution, resolveImportSettings, resolveImportSettingsSync } from "./normalize";
export type { ResolveOptions } from "./sidecar/resolver";

// Sidecar system — per-model import settings
export { parseBlenderExtras } from "./sidecar/blender-extras";
export { createDefaultDdmeta, parseDdmeta, writeDdmeta } from "./sidecar/ddmeta";
export { parseGodotImport } from "./sidecar/godot-import";
export { ddmetaPath, godotImportPath, unityMetaPath } from "./sidecar/resolver";
export { createDefaultImportSettings, mergeImportSettings } from "./sidecar/types";
export type { ImportSettings, SettingsSource, UnitSystem, UpAxis } from "./sidecar/types";
export { parseUnityMeta } from "./sidecar/unity-meta";

// Material adapter — bridges serialized MaterialData to the core Material surface.
export { materialDataArrayToMaterials, materialDataToMaterial } from "./material-adapter";
export type { MaterialAdapterOptions } from "./material-adapter";

import { createModelAsyncLoader, loadModel, registerModelLoaders } from "./loader";

export { createModelAsyncLoader, registerModelLoaders };

export const ModelsPlugin: Plugin = {
  name: "models",
  version: "0.2.0",
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
