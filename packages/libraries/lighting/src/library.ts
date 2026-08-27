// ============================================================================
// LightingLib — declarative engine library descriptor for @downdraft/library-lighting
//
// Provides directional sun/moon lighting, ambient, bioluminescent blending, and
// dynamic point/spot lights. LightSystem extends LightingSystem with a
// read-only storage buffer shared across all entity pipelines, plus optional
// debug gizmo rendering.
//
// Games declare `libraries: [LightingLib]` in their GameModule. The host
// creates the LightSystem (renderer-side) during renderer init and exposes it
// via the LightingTok token. Games inject LightingTok to call
// getLightingParams(), addPointLight(), upload(), etc.
//
// Games that need full control can still import LightSystem directly
// (escape hatch). Note: init() must be called after construction to allocate
// the GPU storage buffer + bind group.
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { LightSystem } from "./light-system";

// ── Config ──

export interface LightingLibConfig {
  /** WeatherBlend transition duration in seconds. Default: 30. */
  blendDuration?: number;
  /** Show debug light gizmos (point/spot light spheres). Default: false. */
  showDebugGizmos?: boolean;
}

// ── Typed tokens (DI) ──

/** Token for the renderer-side LightSystem. Inject in renderer passes. */
export const LightingTok = resourceToken<LightSystem>("lighting:system");

// ── Descriptor ──

export const LightingLib: EngineLibrary<LightingLibConfig> = {
  name: "lighting",
  version: "1.0.0",

  provides: [LightingTok],

  // Renderer-side only — LightSystem owns GPU buffers for the light storage.

  renderer: {
    init(config, ctx) {
      const lighting = new LightSystem(ctx.device);
      lighting.init();
      if (config.showDebugGizmos) {
        lighting.showDebugGizmos = true;
        lighting.initDebugGizmos(ctx.format);
      }
      ctx.provide(LightingTok, lighting);
      return lighting;
    },
    dispose(lighting) {
      (lighting as LightSystem).destroy();
    },
  },

  defaultConfig: {
    blendDuration: 30,
    showDebugGizmos: false,
  },
};
