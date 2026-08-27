// ============================================================================
// WeatherFxLib — declarative engine library descriptor for @downdraft/library-weatherfx
//
// Games declare `libraries: [WeatherFxLib]` (or with config override) in their
// GameModule. The host creates the ParticleSystem (renderer-side only — weather
// visual effects are GPU compute + render passes) and exposes it via the
// WeatherFxTok typed token.
//
// CloudSystem requires a game-specific CloudMeshProvider, so games create it in
// onReady (injecting the GPU device from the renderer context). Games that need
// full control can still import CloudSystem / ParticleSystem directly (escape
// hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { ParticleSystem } from "./particle-system";

// ── Config ──

export interface WeatherFxLibConfig {
  /** Maximum particle count. Default: 20000 (from ParticleSystem). */
  maxParticles?: number;
}

// ── Typed tokens (DI) ──

/** Token for the renderer-side weather particle system. Inject in renderer passes. */
export const WeatherFxTok = resourceToken<ParticleSystem>("weatherfx:particles");

// ── Descriptor ──

export const WeatherFxLib: EngineLibrary<WeatherFxLibConfig> = {
  name: "weatherfx",
  version: "1.0.0",

  // No SAB channels — weather FX are renderer-only GPU compute/render passes.
  sabChannels: [],

  provides: [WeatherFxTok],

  // No sim setup — weather visual effects are entirely renderer-side.

  renderer: {
    async init(_config, ctx) {
      const particles = new ParticleSystem(ctx.device, ctx.format);
      await particles.init();
      ctx.provide(WeatherFxTok, particles);
      return particles;
    },
    dispose(particles) {
      (particles as ParticleSystem).destroy();
    },
  },

  defaultConfig: {
    maxParticles: 20000,
  },
};
