// ============================================================================
// bridge-protocol — postMessage message types between the main thread and
// the UI worker.
//
// Main→worker messages carry event-driven data that can't go through the
// UiStatsSAB (non-scalar data, infrequent events).
// Worker→main messages carry action requests — the worker's Solid store
// decides which actions need main-thread side effects and forwards them.
// ============================================================================

import type { BuildMaterialType, UpgradeConfig } from "../shared/constants";
import type { CraftingRecipe } from "../shared/crafting-recipes";
import type { BuildMaterials, CraftedItems, InventoryEntry, PlayerStats, PlayerUpgrades } from "../shared/types";

// --- Main → worker events ---

export interface CollectedItemsEvent {
  kind: "collected";
  items: InventoryEntry[];
}

export interface SaveLoadedEvent {
  kind: "saveLoaded";
  inventory: InventoryEntry[];
  upgrades: PlayerUpgrades;
  currency: number;
  buildMaterials: BuildMaterials;
  health: number;
  stats: PlayerStats;
  unlockedAchievements: string[];
  craftedItems: CraftedItems;
  welcomeBack: string | null;
}

export interface SavedAtEvent {
  kind: "savedAt";
  time: number;
}

export interface AchievementUnlockedEvent {
  kind: "achievement";
  id: string;
}

export interface FloatingTextEvent {
  kind: "floatingText";
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface ScreenShakeEvent {
  kind: "screenShake";
  intensity: number;
}

export interface DeathEvent {
  kind: "death";
  cause: number;
  quip: string;
}

export interface BuildMaterialsUpdateEvent {
  kind: "buildMaterials";
  mats: BuildMaterials;
}

/** Full inventory sync — the main thread forwards the React store's inventory
 *  to the worker so the Solid store stays in sync. */
export interface SetInventoryEvent {
  kind: "setInventory";
  inventory: InventoryEntry[];
}

// Renderer snapshot — posted by the main thread at ~30fps so worker-side
// overlay components (signpost, bombs, minimap) can position DOM elements
// using the camera transform. Contains the minimum data needed: camera
// params + compact entity arrays.
export interface BombSnap { x: number; y: number; progress: number }
export interface ExplosionSnap { x: number; y: number; progress: number }
export interface GlowstickSnap { x: number; y: number; r: number; g: number; b: number }
export interface EnemySnap { x: number; y: number; color: string; size: number; health: number; maxHealth: number; name: string }

export interface RendererSnapshotEvent {
  kind: "rendererSnapshot";
  camX: number;
  camY: number;
  camZoom: number;
  camWidth: number;
  camHeight: number;
  signpostX: number;
  signpostY: number;
  signpostVisible: boolean;
  bombs: BombSnap[];
  explosions: ExplosionSnap[];
  glowsticks: GlowstickSnap[];
  enemies: EnemySnap[];
  // Hovered cell info (for ore tooltip)
  hoveredMat: number;
  mouseX: number;
  mouseY: number;
  // Active grid origin (for chunk debug overlay)
  gridOriginX: number;
  gridOriginY: number;
  gridOriginW: number;
  gridOriginH: number;
  // Player position (for village overlay proximity checks)
  playerX: number;
  playerY: number;
  // Surface heights at NPC X positions (for village overlay)
  npcSurfaceYs: number[];
}

export type MainToWorkerEvent =
  | CollectedItemsEvent
  | SaveLoadedEvent
  | SavedAtEvent
  | AchievementUnlockedEvent
  | FloatingTextEvent
  | ScreenShakeEvent
  | DeathEvent
  | BuildMaterialsUpdateEvent
  | SetInventoryEvent
  | RendererSnapshotEvent;

// --- Worker → main actions ---

export interface PauseAction { kind: "pause" }
export interface ResumeAction { kind: "resume" }
export interface SetInventoryAction { kind: "setInventory"; inventory: InventoryEntry[] }
export interface TeleportAction { kind: "teleport" }
export interface RespawnAction { kind: "respawn" }
export interface SaveAction { kind: "save" }
export interface SellAllAction { kind: "sellAll" }
export interface BuyUpgradeAction { kind: "buyUpgrade"; config: UpgradeConfig }
export interface CraftAction { kind: "craft"; recipe: CraftingRecipe }
export interface ToggleBuildModeAction { kind: "toggleBuildMode" }
export interface SelectBuildAction { kind: "selectBuild"; type: BuildMaterialType }
export interface ToggleHeadlampAction { kind: "toggleHeadlamp" }
export interface ToggleNoclipAction { kind: "toggleNoclip" }
export interface SetZoomAction { kind: "setZoom"; zoom: number }
export interface BuyBuildMaterialAction { kind: "buyBuildMaterial"; type: BuildMaterialType; qty: number }
export interface StartGameAction { kind: "startGame" }
export interface SetShowTitleScreenAction { kind: "setShowTitleScreen"; show: boolean }
export interface DeleteSaveAction { kind: "deleteSave" }
export interface ToggleShopAction { kind: "toggleShop" }
export interface SetShowShopAction { kind: "setShowShop"; show: boolean }

export type WorkerToMainAction =
  | PauseAction
  | ResumeAction
  | SetInventoryAction
  | TeleportAction
  | RespawnAction
  | SaveAction
  | SellAllAction
  | BuyUpgradeAction
  | CraftAction
  | ToggleBuildModeAction
  | SelectBuildAction
  | ToggleHeadlampAction
  | ToggleNoclipAction
  | SetZoomAction
  | BuyBuildMaterialAction
  | StartGameAction
  | SetShowTitleScreenAction
  | DeleteSaveAction
  | ToggleShopAction
  | SetShowShopAction;

// --- Init message (main → worker, carries the two SABs) ---

export interface InitMessage {
  kind: "init";
  domSab: SharedArrayBuffer;
  uiStatsSab: SharedArrayBuffer;
  minimapSab: SharedArrayBuffer;
}

export type WorkerInbound = MainToWorkerEvent | InitMessage;

/** Type guard for the init message. */
export function isInitMessage(msg: unknown): msg is InitMessage {
  return typeof msg === "object" && msg !== null && (msg as any).kind === "init";
}
