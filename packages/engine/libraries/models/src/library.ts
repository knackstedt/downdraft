// ============================================================================
// ModelsLib — declarative engine library descriptor for @downdraft/library-models
//
// Games declare `libraries: [ModelsLib]` (or with config override) in their
// GameModule. The host creates the async model loader (renderer-side only —
// model loading + parsing happens on the renderer thread where the GPU device
// and AssetManager live) and exposes it via the ModelLoaderTok typed token.
//
// Games that need full control can still import loadModel /
// createModelAsyncLoader / registerModelLoaders directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { createModelAsyncLoader } from "./loader";
import type { ModelData } from "./types";
import type { ModelLoaderOptions } from "./loader";

// ── Config ──

export interface ModelsLibConfig {
  /** Whether to normalize parsed models (up-axis, units, bounds). Default: true. */
  normalize?: boolean;
  /** Custom fetch function (defaults to global fetch). */
  fetchFn?: ModelLoaderOptions["fetchFn"];
  /** MTL resolver for OBJ files with external materials. */
  mtlResolver?: ModelLoaderOptions["mtlResolver"];
  /** BIN resolver for glTF files with external .bin buffers. */
  binResolver?: ModelLoaderOptions["binResolver"];
  /** Custom sidecar resolver for import settings (.ddmeta, .meta, .import). */
  sidecarResolver?: ModelLoaderOptions["sidecarResolver"];
}

// ── Typed tokens (DI) ──

/** The async model loader function: URI → ModelData. Inject in renderer passes/systems. */
export type ModelAsyncLoader = (uri: string) => Promise<ModelData>;

/** Token for the renderer-side async model loader. Inject in renderer systems. */
export const ModelLoaderTok = resourceToken<ModelAsyncLoader>("models:loader");

// ── Descriptor ──

export const ModelsLib: EngineLibrary<ModelsLibConfig> = {
  name: "models",
  version: "1.0.0",

  // No SAB channels — model loading is renderer-only; parsed ModelData is
  // consumed in-process by the renderer's mesh upload path.
  sabChannels: [],

  provides: [ModelLoaderTok],

  // No sim setup — model loading happens entirely on the renderer thread.

  renderer: {
    init(config, ctx) {
      const loader = createModelAsyncLoader({
        normalize: config.normalize,
        fetchFn: config.fetchFn,
        mtlResolver: config.mtlResolver,
        binResolver: config.binResolver,
        sidecarResolver: config.sidecarResolver,
      });
      ctx.provide(ModelLoaderTok, loader);
      return loader;
    },
    dispose(_loader) {
      // The async loader is a pure function — no GPU resources or state to free.
    },
  },

  defaultConfig: {
    normalize: true,
  },
};
