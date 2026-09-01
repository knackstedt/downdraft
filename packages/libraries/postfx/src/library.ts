// ============================================================================
// PostfxLib — declarative engine library descriptor for the PostProcessStack
//
// Games declare `libraries: [PostfxLib]` (or with config override) in their
// GameModule. The host creates a PostProcessStack (renderer-side) and exposes
// it via the PostProcessStackTok typed token.
//
// Games that need full control can still import PostProcessStack directly
// (escape hatch) — this descriptor is a convenience for declarative wiring.
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { PostProcessStack, type EffectId } from "./post-process-stack";

// ── Config ──

export interface PostfxLibConfig {
  /** Effects to enable on startup. Default: none. */
  enabled?: EffectId[];
  /** Depth format for the stack's offscreen depth target. Default: "depth32float". */
  depthFormat?: GPUTextureFormat;
  // ── Per-effect initial parameters (optional) ──
  /** Pixel size for the pixelation effect. Default: 6. */
  pixelSize?: number;
  /** Depth edge strength for pixelation (0–1). Default: 0.4. */
  depthEdgeStrength?: number;
  /** Blur radius for gaussian blur. Default: 2.0. */
  gaussianBlurRadius?: number;
  /** DOF focus distance (0–1). Default: 0.5. */
  dofFocusDist?: number;
  /** DOF focus range (0–1). Default: 0.3. */
  dofFocusRange?: number;
  /** DOF max blur radius. Default: 8. */
  dofMaxBlur?: number;
  /** Bloom threshold (0–2). Default: 0.8. */
  bloomThreshold?: number;
  /** Bloom strength (0–3). Default: 1.0. */
  bloomStrength?: number;
  /** Afterimage damping (0–0.99). Default: 0.96. */
  afterimageDamp?: number;
  /** ASCII cell size in pixels. Default: 8. */
  asciiCellSize?: number;
  /** Whether ASCII uses color. Default: false. */
  asciiUseColor?: boolean;
  /** Tonemap exposure. Default: 1.0. */
  exposure?: number;
  /** Tonemap gamma. Default: 2.2. */
  gamma?: number;
}

// ── Typed token (DI) ──

/** Token for the renderer-side PostProcessStack. Inject in renderer passes/modules. */
export const PostProcessStackTok = resourceToken<PostProcessStack>("postfx:stack");

// ── Descriptor ──

export const PostfxLib: EngineLibrary<PostfxLibConfig> = {
  name: "postfx",
  version: "2.0.0",

  provides: [PostProcessStackTok],

  // Renderer-side only — no sim system.

  renderer: {
    init(config, ctx) {
      const stack = new PostProcessStack(ctx.device, ctx.format, {
        depthFormat: config.depthFormat ?? "depth32float",
      });
      stack.init();

      // Enable requested effects
      if (config.enabled) {
        for (const id of config.enabled) {
          stack.setEnabled(id, true);
        }
      }

      // Apply per-effect parameters
      if (config.pixelSize !== undefined) stack.setPixelationPixelSize(config.pixelSize);
      if (config.depthEdgeStrength !== undefined) stack.setPixelationDepthEdgeStrength(config.depthEdgeStrength);
      if (config.gaussianBlurRadius !== undefined) stack.setGaussianBlurRadius(config.gaussianBlurRadius);
      if (config.dofFocusDist !== undefined) stack.setDOFFocusDist(config.dofFocusDist);
      if (config.dofFocusRange !== undefined) stack.setDOFFocusRange(config.dofFocusRange);
      if (config.dofMaxBlur !== undefined) stack.setDOFMaxBlur(config.dofMaxBlur);
      if (config.bloomThreshold !== undefined) stack.setBloomThreshold(config.bloomThreshold);
      if (config.bloomStrength !== undefined) stack.setBloomStrength(config.bloomStrength);
      if (config.afterimageDamp !== undefined) stack.setAfterimageDamp(config.afterimageDamp);
      if (config.asciiCellSize !== undefined) stack.setASCIICellSize(config.asciiCellSize);
      if (config.asciiUseColor !== undefined) stack.setASCIIUseColor(config.asciiUseColor);
      if (config.exposure !== undefined) stack.setExposure(config.exposure);
      if (config.gamma !== undefined) stack.setGamma(config.gamma);

      ctx.provide(PostProcessStackTok, stack);
      return stack;
    },
    dispose(instance) {
      (instance as PostProcessStack).destroy();
    },
  },

  defaultConfig: {
    enabled: [],
    depthFormat: "depth32float",
    pixelSize: 6,
    depthEdgeStrength: 0.4,
    gaussianBlurRadius: 2.0,
    dofFocusDist: 0.5,
    dofFocusRange: 0.3,
    dofMaxBlur: 8,
    bloomThreshold: 0.8,
    bloomStrength: 1.0,
    afterimageDamp: 0.96,
    asciiCellSize: 8,
    asciiUseColor: false,
    exposure: 1.0,
    gamma: 2.2,
  },
};
