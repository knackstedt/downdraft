// ============================================================================
// PhysicsNativeLib — declarative engine library descriptor for @downdraft/library-physics-native
//
// Games declare `libraries: [PhysicsNativeLib]` (or with config override)
// in their GameModule. The host creates the NativePhysicsBackend (sim-side
// only — physics has no renderer component).
//
// Games that need full control can still import NativePhysicsBackend directly
// (escape hatch).
// ============================================================================

import { RealmTier, resourceToken, type EngineLibrary } from "@downdraft/core";
import { NativePhysicsBackend } from "./backend";

// ── Config ──

export interface PhysicsNativeLibConfig {
  /** Gravity vector. Default: [0, -9.8, 0]. */
  gravity?: [number, number, number];
  /** Fixed timestep for physics simulation. Default: 1/60. */
  fixedDt?: number;
  /** Max entities. Default: 4096. */
  maxEntities?: number;
}

// ── Typed tokens (DI) ──

/** Token for the native physics backend. Inject in sim systems that need physics. */
export const PhysicsNativeAPITok = resourceToken<NativePhysicsBackend>("physics-native:api");

// ── Descriptor ──

export const PhysicsNativeLib: EngineLibrary<PhysicsNativeLibConfig> = {
  name: "physics-native",
  version: "1.0.0",

  // No SAB channels — physics is sim-only, results synced via main SimBuffer.
  sabChannels: [],

  provides: [PhysicsNativeAPITok],

  sim: {
    create(config, ctx) {
      const backend = new NativePhysicsBackend();
      // Create a default realm with the configured gravity.
      // Games can create additional realms via backend.createRealm().
      backend.createRealm({
        id: 0,
        name: "default",
        tier: RealmTier.Near,
        gravity: config.gravity ?? [0, -9.8, 0],
        tierConfig: {
          tickFrequency: 1,
          solverIterations: 4,
          promoteThreshold: 0,
          demoteThreshold: 50,
          demoteDwellTime: 0,
        },
      });
      ctx.provide(PhysicsNativeAPITok, backend);
      return backend;
    },
    dispose(backend) {
      (backend as NativePhysicsBackend).destroy();
    },
    // tick is game-specific (calls backend.step() with entity data, reads back
    // transforms, etc.) — games wire this via onReady or a sim system.
  },

  tickPhase: "physics",

  // No renderer setup — physics is entirely sim-side.

  defaultConfig: {
    gravity: [0, -9.8, 0],
    fixedDt: 1 / 60,
    maxEntities: 4096,
  },
};
