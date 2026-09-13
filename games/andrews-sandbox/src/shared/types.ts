// ============================================================================
// Core Type Definitions — shared across all threads (main, sim, renderer)
// ============================================================================

// --- Engine-level types (re-exported from core) ---
export { CameraMode, EntityFlags } from "@downdraft/core";
export type { EntityId, MainToSimMessage, PlayerId, Quat, RendererToSimMessage, SimToMainMessage, Transform, Vec2, Vec3, Vec4 } from "@downdraft/core";

// --- Entity Types ---

export enum EntityType {
  Prop = 0,
  Projectile = 1,
  Player = 2,
  Mannequin = 3,
}

// --- Tool Types ---

export enum ToolType {
  None = 0,
  Physgun = 1,
  Toolgun = 2,
  Pistol = 3,
  Paintgun = 4,
}

// --- Fun Mode ---

export enum FunMode {
  Normal = 0,
  Moon = 1,
  ZeroG = 2,
  Bouncy = 3,
  Squishy = 4,
}

// --- Pose State ---
// Player stance. Each pose has its own capsule dimensions, eye height, and
// movement-speed multiplier (see POSE_CONFIG in sim-worker-web.ts). The sim
// owns the authoritative pose (it recreates the character controller on
// change); the renderer reads it to scale movement + position the camera.

export enum PoseState {
  Standing = 0,
  Crouching = 1,
  Prone = 2,
}

// --- Prop Flags (bitfield stored in SAB) ---

export const PropFlags = {
  Paintable: 1 << 0,
  FunModeOverride: 1 << 1,
} as const;

// --- Toolgun Contexts ---

export enum ToolgunContext {
  Spawn = 0,
  Remove = 1,
  SetFunMode = 2,
}

// --- Physgun Modes ---
// Ghost: grabbed prop becomes kinematic and is teleported to the target each
//   frame — it passes through walls and other objects freely (original behavior).
// Solid: grabbed prop stays dynamic and is driven toward the target via velocity
//   each sim tick, so the physics engine resolves collisions and the prop can't
//   arbitrarily clip through other objects.

export enum PhysgunMode {
  Ghost = 0,
  Solid = 1,
}

// --- Physgun Rotation Axis ---
// Cycled with the scroll wheel while right-click rotating a held prop
// (Garry's Mod-style). Free = trackball (mouse X yaws, mouse Y pitches);
// the single-axis modes constrain rotation to one axis; Roll spins around
// the view forward axis.

export enum RotAxis {
  Free = 0,
  Yaw = 1,
  Pitch = 2,
  Roll = 3,
}

// --- Sim→Renderer message types ---

export interface PropSpawnedData {
  entityId: number;
  contentId: string;
  nodeId: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
  paintable: boolean;
  /** Stub: durability/HP (not yet consumed by damage systems). */
  strength?: number;
  /** Stub: texture-override id (not yet applied by the renderer). */
  texture?: string;
  /** Stub: shader-override id (not yet applied by the renderer). */
  shader?: string;
  /** Per-prop jelly deformation on impact (independent of the global Squishy fun mode). */
  squishy?: boolean;
}

export interface PropRemovedData {
  entityId: number;
}

export interface PaintUpdatedData {
  nodeId: number;
  dirtyX: number;
  dirtyY: number;
  dirtyW: number;
  dirtyH: number;
}

export interface FunModeChangedData {
  mode: FunMode;
}

export interface PoseChangedData {
  pose: PoseState;
  /** Eye height above feet for the new pose — renderer uses this for the camera. */
  eyeHeight: number;
}

export interface PlayerMovedData {
  position: [number, number, number];
  grounded: boolean;
  pose: PoseState;
  /** Current player health (0–maxHealth). The sim is authoritative. */
  health: number;
  /** Max player health (constant; included so the HUD can scale the bar). */
  maxHealth: number;
  /** True while the player is in the dead state (awaiting respawn). */
  dead: boolean;
}

export interface PlayerDamagedData {
  health: number;
  maxHealth: number;
  amount: number;
  cause: "fall" | "prop";
}

export interface PlayerDiedData {
  cause: "fall" | "prop";
  /** Damage that exceeded the player's remaining health (overkill). */
  overkill: number;
}

export interface PlayerRespawnedData {
  health: number;
  maxHealth: number;
}

export interface SandboxSimMessage {
  kind: "prop_spawned" | "prop_removed" | "paint_updated" | "fun_mode_changed" | "pose_changed" | "ready" | "error" | "player_moved" | "player_damaged" | "player_died" | "player_respawned";
  data: PropSpawnedData | PropRemovedData | PaintUpdatedData | FunModeChangedData | PoseChangedData | PlayerMovedData | PlayerDamagedData | PlayerDiedData | PlayerRespawnedData | { message?: string } | Record<string, unknown>;
}

// --- Sim commands (renderer→sim) ---

export type SimCommand =
  | { type: "spawn"; contentId: string; position: [number, number, number]; rotation?: [number, number, number, number]; physics?: { mass?: number; restitution?: number; friction?: number; gravityScale?: number }; shape?: "box" | "sphere"; scale?: number; strength?: number; texture?: string; shader?: string; squishy?: boolean }
  | { type: "remove"; entityId: number }
  | { type: "clear" }
  | { type: "setFunMode"; mode: FunMode }
  | { type: "setPose"; pose: PoseState }
  | { type: "setTool"; tool: ToolType }
  | { type: "fireWeapon"; origin: [number, number, number]; direction: [number, number, number] }
  | { type: "grabProp"; entityId: number; origin: [number, number, number]; mode: PhysgunMode }
  | { type: "releaseProp"; entityId: number; velocity: [number, number, number] }
  | { type: "updateGrab"; entityId: number; targetPos: [number, number, number] }
  | { type: "rotateGrab"; entityId: number; quaternion: [number, number, number, number] }
  | { type: "updatePropPhysics"; entityId: number; mass?: number; restitution?: number; friction?: number; gravityScale?: number }
  | { type: "applyImpulse"; entityId: number; impulse: [number, number, number] }
  | { type: "movePlayer"; desiredDelta: [number, number, number] }
  | { type: "setPropColliderHull"; entityId: number; vertices: Float32Array | number[] }
  | { type: "respawn" };
