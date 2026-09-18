// ============================================================================
// EntitiesLib — declarative engine library descriptor for @downdraft/engine/libraries/entities
//
// Renders imported 3D models (FBX/GLTF/OBJ) via WebGPU using a bindless binding
// model. The ModelRenderer manages per-draw uniform data, GPU vertex/index
// buffers, skinning resources, and bindless material/texture registration.
//
// Games declare `libraries: [EntitiesLib]` in their GameModule. The host
// creates the ModelRenderer (renderer-side) during renderer init and exposes
// it via the ModelRendererTok token.
//
// Games that need full control can still import ModelRenderer directly
// (escape hatch). Note: setBindlessDeps() must be called before init().
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import { ModelRenderer } from "./model-renderer";

// ── Config ──

export interface EntitiesLibConfig {
  /** Maximum number of concurrent model instances. Default: 256. */
  maxModels?: number;
  /** Initial bone buffer capacity (grows on demand). Default: 256. */
  initialBoneCapacity?: number;
}

// ── Typed tokens (DI) ──

/** Token for the renderer-side ModelRenderer. Inject in renderer passes. */
export const ModelRendererTok = resourceToken<ModelRenderer>("entities:renderer");

// ── Descriptor ──

export const EntitiesLib: EngineLibrary<EntitiesLibConfig> = {
  name: "entities",
  version: "1.0.0",

  provides: [ModelRendererTok],

  // Renderer-side only — ModelRenderer is a GPU resource, no sim-side system.

  renderer: {
    init(_config, ctx) {
      const renderer = new ModelRenderer(ctx.device, ctx.format);
      // init() is async (creates pipelines, buffers, shaders). The host
      // awaits this during renderer setup. setBindlessDeps() must be called
      // by the game (in onReady) before init() for bindless materials.
      void renderer.init();
      ctx.provide(ModelRendererTok, renderer);
      return renderer;
    },
    dispose(renderer) {
      // ModelRenderer.destroy() frees all per-model GPU buffers (vertex,
      // index, skin) and the shared skin matrix storage buffer.
      (renderer as ModelRenderer).destroy();
    },
  },

  defaultConfig: {
    maxModels: 256,
    initialBoneCapacity: 256,
  },
};
