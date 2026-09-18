import { BuoyancySystem } from "./buoyancy";
import { WaterBuffer } from "./water-buffer";
import { WaterPhysics } from "./water-physics";
import { WaterRenderer, type WaterRenderConfig } from "./water-renderer";
import {
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
export { collectShoreSources, collectWakeSources, MAX_SHORES, MAX_WAKES, packShoreSources, SHORE_FLOATS, WAKE_FLOATS } from "./wave-sources";
export type { ShoreProvider, ShoreSource, WakeProvider, WakeSource } from "./wave-sources";

// Water SAB Channel (defineChannel-based SharedArrayBuffer protocol)
export { WATER_FLOW_OFFSET_SAB, WATER_GRID_SAB, WATER_HDR_SAB, WATER_HEIGHT_OFFSET_SAB, WATER_MAGIC_SAB, WATER_NORMAL_OFFSET_SAB, WATER_VERSION_SAB, WaterBufferReader, WaterBufferWriter, WaterChannel } from "./water-sab";

// Declarative library descriptor
export { WaterLib, WaterReaderTok, WaterWriterTok } from "./library";
export type { WaterLibConfig } from "./library";

export interface WaterModuleResources {
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
