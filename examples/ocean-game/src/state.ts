// ─── Shared mutable game state ─────────────────────────────
// Module-level singletons that are set in init() and read/modified
// across lifecycle.ts, systems.ts, helpers.ts, and weather.ts.

import type { Camera, Entity, GameWorld, ParticleSystem, TelemetryCollector, World } from "@downdraft/core";

export const gameState = {
  ecsWorld: null as World | null,
  gameWorld: null as GameWorld | null,
  camera: null as Camera | null,
  particles: null as ParticleSystem | null,
  telemetry: null as TelemetryCollector | null,
  playerEntity: 0 as unknown as Entity,
  shipEntity: 0 as unknown as Entity,
  frameCount: 0,
  timeOfDay: 0.3,
  fps: 0,
  fpsAccum: 0,
  fpsFrames: 0,
  deathCause: "",
  playerSpawnX: 0,
  playerSpawnZ: 0,
  inventoryVisible: false,
  shipDestroyedLogged: false,
  islandsGenerated: 0,
  islandsTotal: 0,
  meshesDirty: false,
};
