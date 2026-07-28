// ============================================================================
// Fishing Plugin — Types and Interfaces
// ============================================================================

export enum FishingMethod {
  LineFishing = 0,
  NetHauling = 1,
  TrapChecking = 2,
}

export interface FishingMinigame {
  active: boolean;
  method: FishingMethod;
  tension: number;
  fishStrength: number;
  fishSize: number;
  fishRarity: number;
  progress: number;
  duration: number;
  reelDir: number;
  reelTimer: number;
  catchPool: string[];
}

// Player interface for fishing
export interface FishingPlayer {
  active: boolean;
  position: { x: number; y: number; z: number };
  flags: number;
  inventory: { slots: unknown[]; width: number; height: number };
}

// Input interface — games provide this
export interface FishingInput {
  isKeyDown(playerSlot: number, key: number): boolean;
  isMouseDown(playerSlot: number, button: number): boolean;
}

// Water provider — games provide this for water proximity checks
export interface WaterProvider {
  getPatchSize(): number;
  getOrigin(): { x: number; z: number };
  sampleHeight(gx: number, gz: number): number;
}

// Biome provider — games provide this
export interface FishingBiomeProvider {
  getBiomeAt(worldX: number, worldZ: number): number;
}

// Weather provider — only needs state
export interface FishingWeatherProvider {
  getState(): { type: number; visibility: number };
}

// Inventory add function — games provide this
export type AddItemFn = (inventory: FishingPlayer["inventory"], itemId: string, quantity: number) => number;

// Event callback
export type FishingEventFn = (event: { kind: string; data: unknown }) => void;

// Key constants
export const FISHING_KEY = {
  F: 70,
  SPACE: 32,
} as const;

export interface FishingConfig {
  castRange: number;
  minigameDuration: number;
  tensionMax: number;
  tensionBreak: number;
  tensionSlip: number;
  perfectZone: number;
  reelPower: number;
  fishPullMult: number;
  goodZoneMin: number;
  goodZoneMax: number;
  progressRate: number;
  perfectProgressRate: number;
  progressDecay: number;
  reelDirMinTime: number;
  reelDirMaxTime: number;
}

export const DEFAULT_FISHING_CONFIG: FishingConfig = {
  castRange: 30,
  minigameDuration: 30,
  tensionMax: 100,
  tensionBreak: 0,
  tensionSlip: 100,
  perfectZone: 0.15,
  reelPower: 35,
  fishPullMult: 15,
  goodZoneMin: 30,
  goodZoneMax: 70,
  progressRate: 0.25,
  perfectProgressRate: 0.4,
  progressDecay: 0.05,
  reelDirMinTime: 2,
  reelDirMaxTime: 4,
};
