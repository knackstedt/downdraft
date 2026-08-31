// ============================================================================
// GaussianSplatsLib — declarative engine library descriptor for @downdraft/library-gaussian-splats
//
// Games declare `libraries: [GaussianSplatsLib]` (or with config override) in
// their GameModule. The host creates the GaussianSplatRenderer (renderer-side)
// and exposes it via a typed token.
//
// Games that need full control can still import GaussianSplatRenderer directly
// (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { GaussianSplatRenderer, type GaussianSplatRendererConfig } from "./renderer";

// ── Config ──

export interface GaussianSplatsLibConfig extends GaussianSplatRendererConfig {
  /** Surface texture format for the splat pipeline. Default: "bgra8unorm". */
  surfaceFormat?: GPUTextureFormat;
}

// ── Typed tokens (DI) ──

/** Token for the renderer-side gaussian splat renderer. Inject in renderer passes. */
export const GaussianSplatsTok = resourceToken<GaussianSplatRenderer>("gaussian-splats:renderer");

// ── Descriptor ──

export const GaussianSplatsLib: EngineLibrary<GaussianSplatsLibConfig> = {
  name: "gaussian-splats",
  version: "1.0.0",

  provides: [GaussianSplatsTok],

  // Renderer-side only — no sim system.

  renderer: {
    init(config, ctx) {
      const format = config.surfaceFormat ?? ctx.format;
      const renderer = new GaussianSplatRenderer(ctx.device, format, {
        maxSplats: config.maxSplats,
        sortThreshold: config.sortThreshold,
        sortFrequency: config.sortFrequency,
        shDegree: config.shDegree,
        tileRaster: config.tileRaster,
        tileRasterOptions: config.tileRasterOptions,
      });
      renderer.prepare(ctx.device);
      ctx.provide(GaussianSplatsTok, renderer);
      return renderer;
    },
    dispose(renderer) {
      (renderer as GaussianSplatRenderer).destroy();
    },
  },

  defaultConfig: {
    surfaceFormat: "bgra8unorm",
  },
};
