// ============================================================================
// PhysicsRapierLib — declarative engine library descriptor for @downdraft/library-physics-rapier
//
// Games declare `libraries: [PhysicsRapierLib]` (or with config override)
// in their GameModule. The host creates the RapierPhysicsBackend +
// UniversalPhysicsAPI (sim-side only — physics has no renderer component).
//
// Games that need full control can still import RapierPhysicsBackend /
// UniversalPhysicsAPI directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary, type PhysicsPluginConfig } from "@downdraft/core";
import { UniversalPhysicsAPI } from "./api";
import { RapierPhysicsBackend } from "./backend";

// ── Config ──

export interface PhysicsRapierLibConfig {
  /** Gravity vector. Default: [0, -9.8, 0]. */
  gravity?: [number, number, number];
  /** Fixed timestep for physics simulation. Default: 1/60. */
  fixedDt?: number;
  /** Max catch-up steps per tick. Default: 1. */
  maxCatchUpSteps?: number;
  /** Step budget in ms. Default: 16. */
  stepBudgetMs?: number;
  /** Max entities. Default: 4096. */
  maxEntities?: number;
  /** Worker count for physics realms. Default: 0 (single-threaded). */
  workerCount?: number;
  /** Prediction mode. Default: "server-authoritative". */
  predictionMode?: PhysicsPluginConfig["predictionMode"];
  /** Realm configs (near/mid/far tier settings). Required by PhysicsPluginConfig. */
  realmConfigs?: PhysicsPluginConfig["realmConfigs"];
  /** Memory to reserve (bytes). Default: 64MB. */
  reserveMemoryBytes?: number;
  /** Dev mode (assert on invalid input). Default: false. */
  devMode?: boolean;
}

// ── Typed tokens (DI) ──

/** Token for the physics API. Inject in sim systems that need physics. */
export const PhysicsAPITok = resourceToken<UniversalPhysicsAPI>("physics:api");

// ── Descriptor ──

export const PhysicsRapierLib: EngineLibrary<PhysicsRapierLibConfig> = {
  name: "physics-rapier",
  version: "1.0.0",

  // No SAB channels — physics is sim-only, results synced via main SimBuffer.
  sabChannels: [],

  provides: [PhysicsAPITok],

  sim: {
    async create(config, ctx) {
      const backend = new RapierPhysicsBackend();
      await backend.init();
      const fullConfig: PhysicsPluginConfig = {
        gravity: config.gravity ?? [0, -9.8, 0],
        fixedDt: config.fixedDt ?? 1 / 60,
        maxCatchUpSteps: config.maxCatchUpSteps ?? 1,
        stepBudgetMs: config.stepBudgetMs ?? 16,
        maxEntities: config.maxEntities ?? 4096,
        workerCount: config.workerCount ?? 0,
        predictionMode: config.predictionMode ?? "server-authoritative",
        realmConfigs: config.realmConfigs ?? {
          near: { tickFrequency: 1, solverIterations: 4, promoteThreshold: 0, demoteThreshold: 50, demoteDwellTime: 0 },
          mid: { tickFrequency: 2, solverIterations: 2, promoteThreshold: 40, demoteThreshold: 200, demoteDwellTime: 1 },
          far: { tickFrequency: 4, solverIterations: 1, promoteThreshold: 150, demoteThreshold: Infinity, demoteDwellTime: 2 },
        },
        nanSweepInterval: 60,
        nanSweepVelocityThreshold: 0.1,
        ccdTunnelingRatio: 0.8,
        snapshotInterval: 30,
        devMode: config.devMode ?? false,
        duplicateStatics: true,
      };
      const api = new UniversalPhysicsAPI(backend, fullConfig);
      api.reserveMemory(config.reserveMemoryBytes ?? 64 * 1024 * 1024);
      ctx.provide(PhysicsAPITok, api);
      return api;
    },
    dispose(api) {
      (api as UniversalPhysicsAPI).destroy();
    },
    // tick is game-specific (calls api.step() with entity data, reads back
    // transforms, etc.) — games wire this via onReady or a sim system.
  },

  tickPhase: "physics",

  // No renderer setup — physics is entirely sim-side.

  defaultConfig: {
    gravity: [0, -9.8, 0],
    fixedDt: 1 / 60,
    maxCatchUpSteps: 1,
    stepBudgetMs: 16,
    maxEntities: 4096,
    workerCount: 0,
    predictionMode: "server-authoritative",
    reserveMemoryBytes: 64 * 1024 * 1024,
  },
};
