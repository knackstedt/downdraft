// ─── Water Physics State ────────────────────────────────────
// Low-poly water heightfield (256×256 grid, 4m per cell = 1024m coverage)

import {
  MAX_SHORES,
  MAX_WAKES,
  BuoyancySystem as PluginBuoyancySystem,
  SHORE_FLOATS,
  WAKE_FLOATS,
  WaterBuffer,
  WaterPhysics,
  type BuoyancyEntity,
  type ShoreProvider,
  type ShoreSource,
  type WakeProvider,
  type WakeSource,
} from "@downdraft/plugin-water";

export const waterBuffer = new WaterBuffer(4);
export const waterPhysics = new WaterPhysics(waterBuffer, { waterLevel: 0, waterRenderDistance: 300 });
export const buoyancySystem = new PluginBuoyancySystem(waterPhysics);

export const waterWakeProviders: WakeProvider[] = [];
export const waterShoreProviders: ShoreProvider[] = [];
export const waterShoreSources: ShoreSource[] = [];
for (let i = 0; i < MAX_SHORES; i++) {
  waterShoreSources.push({ x: 0, z: 0, radius: 0, cutoutRadius: 0 });
}
export const waterWakeSources: WakeSource[] = [];
for (let i = 0; i < MAX_WAKES; i++) {
  waterWakeSources.push({ x: 0, z: 0, dirX: 0, dirZ: 0, speed: 0 });
}
export const waterWakeData = new Float32Array(MAX_WAKES * WAKE_FLOATS);
export const waterShoreData = new Float32Array(MAX_SHORES * SHORE_FLOATS);
export let waterPhysicsTime = 0;

export function advanceWaterPhysicsTime(dt: number) {
  waterPhysicsTime += dt;
}

export type { BuoyancyEntity };
