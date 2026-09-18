// ============================================================================
// Engine-level shared types — math, identifiers, enums, and message protocols
// Generic types used across engine core and any game implementation.
// ============================================================================

import { CameraMode } from "../render/camera";

// --- Math ---

export interface Vec2 { x: number; y: number; }
export interface Vec3 { x: number; y: number; z: number; }
export interface Vec4 { x: number; y: number; z: number; w: number; }
export type Quat = Vec4;

export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

// --- Identifiers ---

export type EntityId = number;
export type PlayerId = number;

// --- Camera ---
// CameraMode is exported from ./render/camera — not duplicated here.

// --- Entity Flags (generic engine-level flags) ---

export enum EntityFlags {
  None = 0,
  Static = 1 << 0,
  NoCollision = 1 << 1,
  Underwater = 1 << 2,
  Onboard = 1 << 3,
  Docked = 1 << 4,
  Sleeping = 1 << 5,
  Dead = 1 << 6,
  Hostile = 1 << 7,
  Tameable = 1 << 8,
  Bioluminescent = 1 << 9,
}

// --- Entity Component Data (generic engine-level entity representation) ---

export interface EntityData {
  id: EntityId;
  type: number;
  flags: number;
  transform: Transform;
  velocity: Vec3;
  angularVelocity: Vec3;
  health: number;
  maxHealth: number;
  parentId: EntityId;
  chunkX: number;
  chunkZ: number;
  data: Float32Array;
}

export interface PlayerState {
  id: PlayerId;
  entityId: EntityId;
  health: number;
  maxHealth: number;
  hunger: number;
  thirst: number;
  oxygen: number;
  maxOxygen: number;
  temperature: number;
  cameraMode: CameraMode;
  activeSlot: number;
  flags: number;
  viewportX: number;
  viewportY: number;
  viewportW: number;
  viewportH: number;
}

// --- Message Protocols (generic sim↔renderer↔main message types) ---

export interface SimToRendererMessage {
  kind: "entity_spawn" | "entity_despawn" | "ui_event" | "state_snapshot" | "weather_update" | "market_update" | "catch_result" | "trade_result" | "notification" | "player_update";
  data: any;
}

export interface RendererToSimMessage {
  kind: "input_action" | "build_request" | "fish_cast" | "fish_reel" | "trade" | "place_item" | "remove_item" | "sleep" | "respawn" | "customization" | "gamemode" | "save" | "load" | "settings";
  data: any;
}

export interface MainToSimMessage {
  kind: "init" | "pause" | "resume" | "save" | "load" | "set_gamemode" | "set_setting" | "add_player" | "remove_player" | "shutdown" | "respawn" | "debug_mode" | "command" | "world_command" | "set_weather" | "set_time_of_day";
  data: any;
}

/** Base engine-level event kinds emitted by the sim thread. Games can extend
 *  this with their own kinds — the `string` fallback allows game-specific event
 *  names without modifying core. Use `(string & {})` to preserve IDE autocomplete
 *  for the known base kinds while accepting any string. */
export type SimToMainKind =
  | "ready" | "saved" | "loaded" | "error" | "performance"
  | "player_died" | "weather_changed" | "gc_stats" | "gc_controller_stats"
  | "perf_stats" | "terrain_deformed" | "terrain_lod_changed"
  | "sim_speed_changed"
  | (string & {});

export interface SimToMainMessage {
  kind: SimToMainKind;
  data: any;
}

// --- DB Protocol ---

export interface DbRequest {
  id: number;
  type: "init" | "query" | "shutdown";
  dataDir?: string;
  sql?: string;
  params?: Record<string, unknown>;
}

export interface DbResponse {
  id: number;
  type: string;
  result?: unknown;
  error?: string;
}
