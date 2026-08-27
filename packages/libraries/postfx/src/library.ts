// ============================================================================
// PostfxLib — declarative engine library descriptor for @downdraft/library-postfx
//
// Games declare `libraries: [PostfxLib]` (or with config override) in their
// GameModule. The host creates the PixelationSystem (renderer-side) and
// exposes it via a typed token.
//
// Games that need full control can still import PixelationSystem directly
// (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { PixelationSystem } from "./pixelation";

// ── Config ──

export interface PostfxLibConfig {
  /** Pixel size for the pixelation effect. Default: 6. */
  pixelSize?: number;
  /** Depth edge detection strength (0–1). Default: 0.4. */
  depthEdgeStrength?: number;
  /** Normal edge detection strength (0–1). Default: 0.3. */
  normalEdgeStrength?: number;
  /** Whether the effect is enabled on startup. Default: false. */
  enabled?: boolean;
}

// ── Typed tokens (DI) ──

/** Token for the renderer-side pixelation post-process system. Inject in renderer passes. */
export const PostfxTok = resourceToken<PixelationSystem>("postfx:pixelation");

// ── Descriptor ──

export const PostfxLib: EngineLibrary<PostfxLibConfig> = {
  name: "postfx",
  version: "1.0.0",

  provides: [PostfxTok],

  // Renderer-side only — no sim system.

  renderer: {
    init(config, ctx) {
      const system = new PixelationSystem(ctx.device, ctx.format);
      system.init();
      if (config.pixelSize !== undefined) system.setPixelSize(config.pixelSize);
      if (config.depthEdgeStrength !== undefined) system.setDepthEdgeStrength(config.depthEdgeStrength);
      if (config.normalEdgeStrength !== undefined) system.setNormalEdgeStrength(config.normalEdgeStrength);
      system.setEnabled(config.enabled ?? false);
      ctx.provide(PostfxTok, system);
      return system;
    },
    dispose(system) {
      (system as PixelationSystem).destroy();
    },
  },

  defaultConfig: {
    pixelSize: 6,
    depthEdgeStrength: 0.4,
    normalEdgeStrength: 0.3,
    enabled: false,
  },
};
