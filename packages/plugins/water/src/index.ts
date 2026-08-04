import type { Plugin, PluginContext } from "@downdraft/core";
import { BuoyancySystem } from "./buoyancy";
import { WaterBuffer } from "./water-buffer";
import { WaterPhysics } from "./water-physics";
import { DEFAULT_RENDER_CONFIG, WaterRenderer, type WaterRenderConfig } from "./water-renderer";
import {
    MAX_SHORES,
    MAX_WAKES,
    SHORE_FLOATS,
    WAKE_FLOATS,
    collectShoreSources,
    collectWakeSources,
    packShoreSources,
    type ShoreProvider,
    type ShoreSource,
    type WakeProvider
} from "./wave-sources";

// Re-export low-poly water physics system
export { BuoyancySystem } from "./buoyancy";
export type { BuoyancyEntity } from "./buoyancy";
export { shoreDamping, shoreDisplacement, waterCutout } from "./shore-damping";
export { WATER_BUFFER_BYTES, WATER_FLOW_OFFSET, WATER_GRID, WATER_HEIGHT_OFFSET, WATER_NORMAL_OFFSET, WaterBuffer } from "./water-buffer";
export { CHUNK_GRID, CHUNK_OVERLAP, CHUNK_SIZE, CHUNK_WORLD_SIZE, MAX_CHUNKS } from "./water-chunks";
export type { WaterChunk } from "./water-chunks";
export { DEFAULT_PHYSICS_CONFIG, WaterPhysics } from "./water-physics";
export type { GerstnerWaveParams, WaterPhysicsConfig } from "./water-physics";
export { DEFAULT_RENDER_CONFIG, WaterRenderer } from "./water-renderer";
export type { WaterRenderConfig, WaterRendererOptions } from "./water-renderer";
export {
    MAX_SHORES, MAX_WAKES, SHORE_FLOATS, WAKE_FLOATS, collectShoreSources, collectWakeSources, packShoreSources
} from "./wave-sources";
export type { ShoreProvider, ShoreSource, WakeProvider, WakeSource } from "./wave-sources";

export interface WaterPluginResources {
  buffer: WaterBuffer;
  physics: WaterPhysics;
  buoyancy: BuoyancySystem;
  renderer: WaterRenderer;
  wakeProviders: WakeProvider[];
  shoreProviders: ShoreProvider[];
  shoreSources: ShoreSource[];
  wakeData: Float32Array;
  shoreData: Float32Array;
  renderConfig: WaterRenderConfig;
}

export const WaterPlugin: Plugin = {
  name: "water",
  version: "0.2.0",
  register(ctx: PluginContext) {
    // Low-poly water physics system
    const buffer = new WaterBuffer(4); // 4m per cell, renderer subdivides for 10x density
    const physics = new WaterPhysics(buffer);
    const buoyancy = new BuoyancySystem(physics);
    const renderer = new WaterRenderer();

    const wakeProviders: WakeProvider[] = [];
    const shoreProviders: ShoreProvider[] = [];
    const shoreSources: ShoreSource[] = [];
    for (let i = 0; i < MAX_SHORES; i++) {
      shoreSources.push({ x: 0, z: 0, radius: 0, cutoutRadius: 0 });
    }
    const wakeData = new Float32Array(MAX_WAKES * WAKE_FLOATS);
    const shoreData = new Float32Array(MAX_SHORES * SHORE_FLOATS);
    const renderConfig = { ...DEFAULT_RENDER_CONFIG };

    const resources: WaterPluginResources = {
      buffer, physics, buoyancy, renderer,
      wakeProviders, shoreProviders, shoreSources,
      wakeData, shoreData, renderConfig,
    };
    ctx.registerResource("waterPlugin", resources);

    ctx.registerSystem(3, function waterUpdate(sysCtx: any) {
      const dt = sysCtx.dt;

      // Collect wake sources from providers
      const wakeCount = collectWakeSources(wakeProviders, wakeData);

      // Collect shore sources from providers
      const shoreCount = collectShoreSources(shoreProviders, shoreSources);
      packShoreSources(shoreSources, shoreCount, shoreData);

      // Update render config from weather state if available
      const weatherState = sysCtx.world?.getResource?.("weatherState");
      if (weatherState) {
        renderConfig.weatherType = weatherState.type ?? 0;
        renderConfig.visibility = weatherState.visibility ?? 1.0;
        renderConfig.windSpeed = weatherState.windSpeed ?? 3;
        renderConfig.windDirX = weatherState.windDirX ?? 1;
        renderConfig.windDirZ = weatherState.windDirZ ?? 0;
        renderConfig.weatherIntensity = weatherState.intensity ?? 0;
        physics.setConfig({
          windSpeed: weatherState.windSpeed ?? 3,
          windDirX: weatherState.windDirX ?? 1,
          windDirZ: weatherState.windDirZ ?? 0,
        });
      }

      // Update time of day
      const timeOfDay = sysCtx.world?.getResource?.("timeOfDay");
      if (timeOfDay !== undefined) {
        renderConfig.timeOfDay = timeOfDay;
      }

      // Update water physics heightfield (centered on player, chunk-snapped)
      const player = sysCtx.world?.getResource?.("playerPosition");
      const pX = player?.x ?? 0;
      const pZ = player?.z ?? 0;
      physics.setShoreSources(shoreSources, shoreCount);
      physics.update(dt, pX, pZ);

      // Update GPU dynamic source buffers
      if (renderer.isInitialized()) {
        renderer.updateDynamics(wakeData, wakeCount, shoreData, shoreCount);
      }
    });

    ctx.onDispose(() => {
      renderer.destroy();
    });
  },
};
