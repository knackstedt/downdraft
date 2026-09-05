// ============================================================================
// Core Type Definitions — shared across all threads (main, sim, renderer)
// ============================================================================

// --- Engine-level types (re-exported from core) ---
export { EntityFlags } from "@downdraft/core";
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

// --- Sim→Renderer message types ---

export interface PropSpawnedData {
  entityId: number;
  contentId: string;
  nodeId: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
  paintable: boolean;
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

export interface SandboxSimMessage {
  kind: "prop_spawned" | "prop_removed" | "paint_updated" | "fun_mode_changed" | "ready" | "error";
  data: PropSpawnedData | PropRemovedData | PaintUpdatedData | FunModeChangedData | { message?: string } | Record<string, unknown>;
}

// --- Sim commands (renderer→sim) ---

export type SimCommand =
  | { type: "spawn"; contentId: string; position: [number, number, number]; rotation?: [number, number, number, number]; physics?: { mass?: number; restitution?: number; friction?: number; gravityScale?: number }; shape?: "box" | "sphere"; scale?: number }
  | { type: "remove"; entityId: number }
  | { type: "clear" }
  | { type: "setFunMode"; mode: FunMode }
  | { type: "setTool"; tool: ToolType }
  | { type: "fireWeapon"; origin: [number, number, number]; direction: [number, number, number] }
  | { type: "grabProp"; entityId: number; origin: [number, number, number] }
  | { type: "releaseProp"; entityId: number; velocity: [number, number, number] }
  | { type: "updateGrab"; entityId: number; targetPos: [number, number, number] }
  | { type: "updatePropPhysics"; entityId: number; mass?: number; restitution?: number; friction?: number; gravityScale?: number }
  | { type: "applyImpulse"; entityId: number; impulse: [number, number, number] };
