import { createLayout, type BufferLayout } from "./seqlock.ts";

export interface ChannelConfig {
  name: string;
  layout: BufferLayout;
  capacity: number;
}

export const TRANSFORM_LAYOUT = createLayout([
  { name: "position", type: "f32", count: 3 },
  { name: "rotation", type: "f32", count: 4 },
  { name: "scale", type: "f32", count: 1 },
]);

export const INPUT_LAYOUT = createLayout([
  { name: "keys", type: "i32", count: 8 },
  { name: "mouseX", type: "f32", count: 1 },
  { name: "mouseY", type: "f32", count: 1 },
  { name: "mouseDeltaX", type: "f32", count: 1 },
  { name: "mouseDeltaY", type: "f32", count: 1 },
  { name: "mouseButtons", type: "i32", count: 3 },
  { name: "wheelDelta", type: "f32", count: 1 },
  { name: "gamepadButtons", type: "i32", count: 4 },
  { name: "gamepadAxes", type: "f32", count: 4 },
]);

export const PHYSICS_LAYOUT = createLayout([
  { name: "velocity", type: "f32", count: 3 },
  { name: "angularVelocity", type: "f32", count: 3 },
  { name: "contacts", type: "i32", count: 1 },
]);

export const AUDIO_POSITION_LAYOUT = createLayout([
  { name: "sourcePositions", type: "f32", count: 32 },
  { name: "listenerPosition", type: "f32", count: 3 },
  { name: "listenerOrientation", type: "f32", count: 4 },
]);

export const WATER_LAYOUT = createLayout([
  { name: "waveData", type: "f32", count: 16 },
  { name: "time", type: "f32", count: 1 },
]);

export const TERRAIN_LAYOUT = createLayout([
  { name: "heightmap", type: "f32", count: 64 },
  { name: "chunkX", type: "i32", count: 1 },
  { name: "chunkZ", type: "i32", count: 1 },
]);

export const CHANNEL_LAYOUTS = {
  transform: TRANSFORM_LAYOUT,
  input: INPUT_LAYOUT,
  physics: PHYSICS_LAYOUT,
  "audio-position": AUDIO_POSITION_LAYOUT,
  water: WATER_LAYOUT,
  terrain: TERRAIN_LAYOUT,
} as const;

export type ChannelName = keyof typeof CHANNEL_LAYOUTS;

export function createSABForChannel(name: ChannelName, entityCapacity: number = 1): SharedArrayBuffer {
  const layout = CHANNEL_LAYOUTS[name];
  const bytesPerEntity = layout.totalBytes;
  const totalBytes = 4 + bytesPerEntity * entityCapacity;
  return new SharedArrayBuffer(totalBytes);
}
