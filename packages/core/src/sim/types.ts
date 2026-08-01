// ============================================================================
// Generic Simulation Types — shared interfaces for plugin systems
// ============================================================================

export type EntityId = number;
export type PlayerId = number;

export interface Vec2 { x: number; y: number; }
export interface Vec3 { x: number; y: number; z: number; }
export interface Vec4 { x: number; y: number; z: number; w: number; }
export type Quat = Vec4;

export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: number;
}

// --- Generic Entity Interface ---
// Plugins depend on this interface, not the game's concrete SimEntity.
// The game's SimEntity structurally satisfies this interface.

export interface SimEntityLike {
  id: EntityId;
  type: number;
  flags: number;
  position: Vec3;
  rotation: Quat;
  scale: number;
  velocity: Vec3;
  angularVelocity: Vec3;
  health: number;
  maxHealth: number;
  parentId: number;
  chunkX: number;
  chunkZ: number;
  data: Float32Array;
}

// --- Generic Player Interface ---
// Plugins depend on this interface, not the game's concrete SimPlayer.

export interface SimPlayerLike {
  playerId: PlayerId;
  entityId: EntityId;
  name: string;
  active: boolean;
  position: Vec3;
  velocity: Vec3;
  heading: number;
  bodyHeading: number;
  pitch: number;
  rotation: Quat;
  health: number;
  maxHealth: number;
  flags: number;
  viewport: { x: number; y: number; w: number; h: number };
  activeSlot: number;
}

// --- Simulation Context ---
// Passed to plugin systems so they can access entities, players, and send events.

export interface SimulationContext {
  entities: SimEntityLike[];
  players: SimPlayerLike[];
  tick: number;
  dt: number;
  getEntity(id: EntityId): SimEntityLike | undefined;
  getPlayer(id: PlayerId): SimPlayerLike | undefined;
  spawnEntity(type: number, x: number, y: number, z: number): SimEntityLike;
  removeEntity(id: EntityId): void;
  sendEvent(kind: string, data: unknown): void;
}

// --- Input Buffer Reader (generic) ---
// Plugins that need input should use this interface.

export interface InputReaderLike {
  isKeyDown(playerSlot: number, key: number): boolean;
  getAxis(playerSlot: number, axis: number): number;
}

// --- Simulation Interface ---
// Games implement this so engine features (hot-reload, save/load, debugging)
// can depend on a stable contract instead of a concrete class.

export interface ISimulation {
  tick(dt: number): Promise<void>;
  serializeState(): string;
  restoreState(stateJson: string): void;
  rebuildAfterRestore(): Promise<void>;
  shutdown(): void;
}

// --- Hot-Reloadable Interface ---
// Worker managers implement this so the renderer's HMR handlers can interact
// with any game's worker layer through a common interface.

export interface IHotReloadable {
  start(config: unknown): Promise<void>;
  stop(): Promise<void>;
  save(slotName: string): Promise<{ slotName: string; stateJson: string } | null>;
  restoreFromState(stateJson: string): Promise<void>;
  hotReload(config: unknown, preserveState: boolean): Promise<void>;
}
