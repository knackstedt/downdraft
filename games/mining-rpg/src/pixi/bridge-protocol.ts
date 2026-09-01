// ============================================================================
// bridge-protocol — pixi-ui adapter for mining-rpg.
// Defines the SAB layout, postMessage event types, and worker→main action
// types for the @downdraft/library-pixi-ui overlay.
// ============================================================================

import type { UiStatsLayout } from "@downdraft/library-pixi-ui";
import type { BuildMaterialType, UpgradeConfig } from "../shared/constants";
import type { CraftingRecipe } from "../shared/crafting-recipes";
import type { BuildMaterials, CraftedItems, InventoryEntry, PlayerStats, PlayerUpgrades } from "../shared/types";

// ── Per-frame scalar slots (UiStatsSAB) ──
export const MINING_STATS_LAYOUT: UiStatsLayout = {
  slots: [
    "fps", "health", "oxygen", "depth",
    "loadedChunks", "activeChunks",
    "nearSignpost", "onGround", "playerFacing",
    "playerX", "playerY", "playerVx", "playerVy",
    "deathCause", "simReady", "tick", "gameOver",
    "zoom", "glowstickCount", "bombCount",
    "teleportCooldown", "playerSpeed",
    // Menu visibility (0/1)
    "showTitleScreen", "showInventory", "showEscapeMenu",
    "showStats", "showAchievements", "showMinimap",
    "showShop", "showHUD", "showFPS", "showHelp",
    "paused", "buildMode", "headlampOn", "noclip",
    // Derived
    "currency", "digRadius", "goldFlashTime",
    "maxInventory", "inventoryCount",
    "canvasW", "canvasH",
  ],
};

// ── Main → worker events (postMessage) ──

export interface CollectedItemsEvent { kind: "collected"; items: InventoryEntry[] }
export interface SaveLoadedEvent {
  kind: "saveLoaded";
  inventory: InventoryEntry[]; upgrades: PlayerUpgrades; currency: number;
  buildMaterials: BuildMaterials; health: number; stats: PlayerStats;
  unlockedAchievements: string[]; craftedItems: CraftedItems; welcomeBack: string | null;
}
export interface SavedAtEvent { kind: "savedAt"; time: number }
export interface AchievementUnlockedEvent { kind: "achievement"; id: string }
export interface FloatingTextEvent { kind: "floatingText"; x: number; y: number; text: string; color: string }
export interface ScreenShakeEvent { kind: "screenShake"; intensity: number }
export interface DeathEvent { kind: "death"; cause: number; quip: string }
export interface BuildMaterialsUpdateEvent { kind: "buildMaterials"; mats: BuildMaterials }
export interface SetInventoryEvent { kind: "setInventory"; inventory: InventoryEntry[] }

export interface BombSnap { x: number; y: number; progress: number }
export interface ExplosionSnap { x: number; y: number; progress: number }
export interface GlowstickSnap { x: number; y: number; r: number; g: number; b: number }
export interface EnemySnap { x: number; y: number; color: string; size: number; health: number; maxHealth: number; name: string }

export interface RendererSnapshotEvent {
  kind: "rendererSnapshot";
  camX: number; camY: number; camZoom: number; camWidth: number; camHeight: number;
  signpostX: number; signpostY: number; signpostVisible: boolean;
  bombs: BombSnap[]; explosions: ExplosionSnap[];
  glowsticks: GlowstickSnap[]; enemies: EnemySnap[];
  hoveredMat: number; mouseX: number; mouseY: number;
  gridOriginX: number; gridOriginY: number; gridOriginW: number; gridOriginH: number;
  playerX: number; playerY: number; npcSurfaceYs: number[];
}

export type MainToWorkerEvent =
  | CollectedItemsEvent | SaveLoadedEvent | SavedAtEvent | AchievementUnlockedEvent
  | FloatingTextEvent | ScreenShakeEvent | DeathEvent | BuildMaterialsUpdateEvent
  | SetInventoryEvent | RendererSnapshotEvent;

// ── Worker → main actions ──

export interface PauseAction { kind: "pause" }
export interface ResumeAction { kind: "resume" }
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
export interface SetFontScaleAction { kind: "setFontScale"; scale: number }

export type WorkerToMainAction =
  | PauseAction | ResumeAction | TeleportAction | RespawnAction | SaveAction
  | SellAllAction | BuyUpgradeAction | CraftAction | ToggleBuildModeAction
  | SelectBuildAction | ToggleHeadlampAction | ToggleNoclipAction | SetZoomAction
  | BuyBuildMaterialAction | StartGameAction | SetShowTitleScreenAction
  | DeleteSaveAction | ToggleShopAction | SetShowShopAction | SetFontScaleAction;

export type MiningAction = WorkerToMainAction;
