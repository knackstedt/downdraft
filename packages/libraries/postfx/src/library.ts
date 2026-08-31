// ============================================================================
// PostfxLib — declarative engine library descriptor for @downdraft/library-postfx
//
// Games declare `libraries: [PostfxLib]` (or with config override) in their
// GameModule. The host creates the PixelationSystem, GaussianBlurSystem,
// and/or AsciiSystem (renderer-side) and exposes them via typed tokens.
//
// Games that need full control can still import the systems directly
// (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { AsciiSystem } from "./ascii";
import { GaussianBlurSystem } from "./gaussian-blur";
import { PixelationSystem } from "./pixelation";

// ── Config ──

export interface PostfxLibConfig {
  /** Pixel size for the pixelation effect. Default: 6. */
  pixelSize?: number;
  /** Depth edge detection strength (0–1). Default: 0.4. */
  depthEdgeStrength?: number;
  /** Normal edge detection strength (0–1). Default: 0.3. */
  normalEdgeStrength?: number;
  /** Whether the pixelation effect is enabled on startup. Default: false. */
  pixelationEnabled?: boolean;
  /** Whether to create the GaussianBlurSystem. Default: false. */
  gaussianBlur?: boolean;
  /** Blur radius in texels for the Gaussian blur. Default: 4. */
  gaussianBlurRadius?: number;
  /** Whether the Gaussian blur is enabled on startup. Default: false. */
  gaussianBlurEnabled?: boolean;
  /** Whether to create the AsciiSystem. Default: false. */
  ascii?: boolean;
  /** Grid cell size in pixels for the ASCII effect. Default: 8. */
  asciiCellSize?: number;
  /** Whether the ASCII effect uses color (vs. green terminal). Default: false. */
  asciiUseColor?: boolean;
  /** Whether the ASCII effect is enabled on startup. Default: false. */
  asciiEnabled?: boolean;
}

// ── Typed tokens (DI) ──

/** Token for the renderer-side pixelation post-process system. Inject in renderer passes. */
export const PostfxTok = resourceToken<PixelationSystem>("postfx:pixelation");

/** Token for the renderer-side Gaussian blur post-process system. Inject in renderer passes. */
export const GaussianBlurTok = resourceToken<GaussianBlurSystem>("postfx:gaussian-blur");

/** Token for the renderer-side ASCII post-process system. Inject in renderer passes. */
export const AsciiTok = resourceToken<AsciiSystem>("postfx:ascii");

// ── Descriptor ──

export const PostfxLib: EngineLibrary<PostfxLibConfig> = {
  name: "postfx",
  version: "1.0.0",

  provides: [PostfxTok, GaussianBlurTok, AsciiTok],

  // Renderer-side only — no sim system.

  renderer: {
    init(config, ctx) {
      const pixelation = new PixelationSystem(ctx.device, ctx.format);
      pixelation.init();
      if (config.pixelSize !== undefined) pixelation.setPixelSize(config.pixelSize);
      if (config.depthEdgeStrength !== undefined) pixelation.setDepthEdgeStrength(config.depthEdgeStrength);
      if (config.normalEdgeStrength !== undefined) pixelation.setNormalEdgeStrength(config.normalEdgeStrength);
      pixelation.setEnabled(config.pixelationEnabled ?? false);
      ctx.provide(PostfxTok, pixelation);

      let blur: GaussianBlurSystem | null = null;
      if (config.gaussianBlur) {
        blur = new GaussianBlurSystem(ctx.device, ctx.format);
        blur.init();
        blur.setRadius(config.gaussianBlurRadius ?? 4);
        blur.setEnabled(config.gaussianBlurEnabled ?? false);
        ctx.provide(GaussianBlurTok, blur);
      }

      let ascii: AsciiSystem | null = null;
      if (config.ascii) {
        ascii = new AsciiSystem(ctx.device, ctx.format);
        ascii.init();
        ascii.setCellSize(config.asciiCellSize ?? 8);
        ascii.setUseColor(config.asciiUseColor ?? false);
        ascii.setEnabled(config.asciiEnabled ?? false);
        ctx.provide(AsciiTok, ascii);
      }

      // Return a composite so dispose() can clean up all systems.
      return { pixelation, blur, ascii };
    },
    dispose(instance) {
      const { pixelation, blur, ascii } = instance as {
        pixelation: PixelationSystem;
        blur: GaussianBlurSystem | null;
        ascii: AsciiSystem | null;
      };
      pixelation.destroy();
      blur?.destroy();
      ascii?.destroy();
    },
  },

  defaultConfig: {
    pixelSize: 6,
    depthEdgeStrength: 0.4,
    normalEdgeStrength: 0.3,
    pixelationEnabled: false,
    gaussianBlur: false,
    gaussianBlurRadius: 4,
    gaussianBlurEnabled: false,
    ascii: false,
    asciiCellSize: 8,
    asciiUseColor: false,
    asciiEnabled: false,
  },
};
