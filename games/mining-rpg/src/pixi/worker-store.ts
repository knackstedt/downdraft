// ============================================================================
// worker-store — reactive store for @pixi/react components in the worker.
// ============================================================================

import { useSyncExternalStore } from "react";
import { createCraftedItems, type BuildMaterials, type CraftedItems, type InventoryEntry, type PlayerStats, type PlayerUpgrades } from "../shared/types";

// Inline the snapshot types (avoid importing from ../solid/ which is in a
// separate tsconfig project).
export interface BombSnap { x: number; y: number; progress: number }
export interface ExplosionSnap { x: number; y: number; progress: number }
export interface GlowstickSnap { x: number; y: number; r: number; g: number; b: number }
export interface EnemySnap { x: number; y: number; color: string; size: number; health: number; maxHealth: number; name: string }

export interface AchievementData { id: string; name: string; description: string; }
export interface RendererSnapshot {
  camX: number; camY: number; camZoom: number; camWidth: number; camHeight: number;
  signpostX: number; signpostY: number; signpostVisible: boolean;
  bombs: BombSnap[]; explosions: ExplosionSnap[];
  glowsticks: GlowstickSnap[]; enemies: EnemySnap[];
  hoveredMat: number; mouseX: number; mouseY: number;
  gridOriginX: number; gridOriginY: number; gridOriginW: number; gridOriginH: number;
  playerX: number; playerY: number; npcSurfaceYs: number[];
}

export interface MiningWorkerState {
  // SAB scalars
  fps: number; health: number; oxygen: number; depth: number;
  loadedChunks: number; activeChunks: number;
  nearSignpost: boolean; onGround: boolean; playerFacing: number;
  playerX: number; playerY: number; playerVx: number; playerVy: number;
  deathCause: number; simReady: boolean; tick: number; gameOver: boolean;
  zoom: number; glowstickCount: number; bombCount: number;
  teleportCooldown: number; playerSpeed: number;
  showTitleScreen: boolean; showInventory: boolean; showEscapeMenu: boolean;
  showStats: boolean; showAchievements: boolean; showMinimap: boolean;
  showShop: boolean; showHUD: boolean; showFPS: boolean; showHelp: boolean;
  paused: boolean; buildMode: boolean; headlampOn: boolean; noclip: boolean;
  currency: number; digRadius: number; goldFlashTime: number;
  maxInventory: number; inventoryCount: number;
  canvasW: number; canvasH: number;
  // Event-driven data
  inventory: InventoryEntry[];
  upgrades: PlayerUpgrades;
  buildMaterials: BuildMaterials;
  craftedItems: CraftedItems;
  stats: PlayerStats;
  unlockedAchievements: string[];
  recentAchievement: AchievementData | null;
  welcomeBack: string | null;
  deathQuip: string;
  lastSaveTime: number;
  rendererSnapshot: RendererSnapshot | null;
  floatingTexts: { id: number; x: number; y: number; text: string; color: string }[];
  screenShakeIntensity: number;
}

const initialState: MiningWorkerState = {
  fps: 0, health: 100, oxygen: 0, depth: 0,
  loadedChunks: 0, activeChunks: 0,
  nearSignpost: false, onGround: false, playerFacing: 1,
  playerX: 0, playerY: 0, playerVx: 0, playerVy: 0,
  deathCause: 0, simReady: false, tick: 0, gameOver: false,
  zoom: 1, glowstickCount: 0, bombCount: 0,
  teleportCooldown: 1, playerSpeed: 0,
  showTitleScreen: true, showInventory: false, showEscapeMenu: false,
  showStats: false, showAchievements: false, showMinimap: true,
  showShop: false, showHUD: true, showFPS: false, showHelp: false,
  paused: false, buildMode: false, headlampOn: false, noclip: false,
  currency: 0, digRadius: 3, goldFlashTime: 0,
  maxInventory: 24, inventoryCount: 0,
  canvasW: 1280, canvasH: 720,
  inventory: [], upgrades: { damage: 0, radius: 0, rate: 0, inventorySize: 0 },
  buildMaterials: { scaffolding: 0, ladder: 0, rope: 0, torch: 0 }, craftedItems: createCraftedItems(),
  stats: {} as PlayerStats, unlockedAchievements: [],
  recentAchievement: null, welcomeBack: null, deathQuip: "",
  lastSaveTime: 0, rendererSnapshot: null,
  floatingTexts: [], screenShakeIntensity: 0,
};

let state: MiningWorkerState = initialState;
const listeners = new Set<() => void>();
let ftId = 0;

export function getWorkerState(): MiningWorkerState { return state; }
export function setWorkerState(partial: Partial<MiningWorkerState>): void {
  state = { ...state, ...partial };
  listeners.forEach((l) => l());
}
export function subscribeWorkerState(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useWorkerState<T>(selector: (s: MiningWorkerState) => T): T {
  return useSyncExternalStore(
    subscribeWorkerState,
    () => selector(state),
    () => selector(initialState),
  );
}

let _postAction: ((action: any) => void) | null = null;
export function setPostAction(fn: (action: any) => void): void { _postAction = fn; }
export function postAction(action: any): void {
  if (_postAction) _postAction(action);
}

export function addFloatingText(x: number, y: number, text: string, color: string): void {
  const id = ++ftId;
  setWorkerState({ floatingTexts: [...state.floatingTexts, { id, x, y, text, color }] });
  setTimeout(() => {
    setWorkerState({ floatingTexts: state.floatingTexts.filter((f) => f.id !== id) });
  }, 2000);
}
