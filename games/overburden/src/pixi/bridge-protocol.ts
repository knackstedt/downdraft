// ============================================================================
// bridge-protocol — typed events + actions for the overburden PixiUI.
//
// The pixi-ui worker cannot read the main-thread zustand store directly.
// State flows through three channels:
//   1. UiStatsSAB — per-frame scalars (see STATS_LAYOUT below)
//   2. postEvent  — structured data (inventory, blockheads, recipes, etc.)
//   3. onAction   — worker→main side-effect requests (buttons, craft, etc.)
// ============================================================================

import type { PixiUiAction, PixiUiEvent, UiStatsLayout } from "@downdraft/library-pixi-ui";

// ── Per-frame scalar slots (UiStatsSAB) ──
export const OVERBURDEN_STATS_LAYOUT: UiStatsLayout = {
  slots: [
    "fps",
    // Active blockhead stats
    "health",
    "hunger",
    "energy",
    "air",
    "happiness",
    "environment",
    // Blockhead roster
    "activeBhIndex",
    "blockheadCount",
    // Inventory
    "selectedSlot",
    "inventoryTab",      // 0=inventory, 1=crafting, 2=creative
    // Panel visibility
    "showTitleScreen",   // 0/1
    "paused",            // 0/1
    "showInventoryPanel",// 0/1
    "showCraftPanel",    // 0/1
    "showTaskQueue",     // 0/1
    "taskMode",          // 0/1
    "deterministic",     // 0/1
    "hasSelectedStation",// 0/1
    "selectedStationAx",
    "selectedStationAy",
    // Season
    "season",            // 0=spring, 1=summer, 2=autumn, 3=winter
    "dayInSeason",
    "year",
    // Character
    "characterGender",   // 0=male, 1=female
    // Camera/debug
    "cameraDetached",    // 0/1
    "debugNoShadows",    // 0/1
    "debugInspect",      // 0/1
    // Canvas dimensions
    "canvasW",
    "canvasH",
    // Map-mode (zoomed-out overview) — per-frame so the 2D map overlay can
    // track the camera during the cross-fade + pan without per-frame
    // postMessage. camWorldX/Y are the camera center in world block coords;
    // camZoom is px/block; mapOpacity is the cross-fade alpha [0,1].
    "camWorldX",
    "camWorldY",
    "camZoom",
    "mapOpacity",
    // Player world position + facing (for the map overlay marker).
    "playerWorldX",
    "playerWorldY",
    "playerFacing",
  ],
};

// ── Types (mirrored from the main-thread store) ──

export interface InventorySlotUI { itemId: string; count: number }
export type InventoryUI = (InventorySlotUI | null)[];
export type InventoryTab = "inventory" | "crafting" | "creative";
export interface RecipeUI { id: string; name: string; station: string }
export interface PickupToast { id: number; itemId: string; count: number; ts: number }
export interface BlockheadUIState { health: number; hunger: number; energy: number; air: number; happiness: number; environment: number }
export type Season = "spring" | "summer" | "autumn" | "winter";

export interface CraftJobUI {
  jobId: number;
  recipeId: string;
  recipeName: string;
  progress: number; // 0..1
  status: string;
  rushable: boolean;
}
export interface CraftQueueUI {
  active: CraftJobUI | null;
  queued: CraftJobUI[];
  fuelCount: number;
  fuelMax: number;
  stationName: string;
  stationFueled: boolean;
}
export interface TaskUI {
  id: number;
  type: string;
  targetX: number;
  targetY: number;
  blockId: number;
  status: string;
}
// Map-region thumbnail bitmap sent to the overlay. `cells` is a dense
// Uint32Array of packed 0xRRGGBB colors, one per thumbnail cell, laid out
// row-major as ((row * MAP_REGION_COLS + col) * THUMB_H + ty) * THUMB_W + tx
// (see shared/map-buffer.ts). Length = REGION_BLOCK_W * REGION_BLOCK_H
// (1024 * 128 = 131072). 0x000000 = fog (unexplored); 0x1a1a2e = explored
// air (sky); any other value = the topmost non-air block's palette color.
// `cx0` is the leftmost chunk X of the strip (wrapped to [0, CHUNKS_X)) so
// the overlay can convert world coords → strip-relative coords for alignment.
export interface MapStationUI {
  x: number; // world block X
  y: number; // world block Y
  color: number; // packed 0xRRGGBB marker color
}
export interface TaskMarkerUI {
  x: number;
  y: number;
  type: string; // "MINE_BLOCK" | "MOVE_TO"
}

// ── Main→worker events (structured data) ──

export interface SetInventoryEvent extends PixiUiEvent { kind: "setInventory"; inventory: InventoryUI }
export interface SetBlockheadsEvent extends PixiUiEvent { kind: "setBlockheads"; blockheads: BlockheadUIState[] }
export interface SetRecipesEvent extends PixiUiEvent { kind: "setRecipes"; recipes: RecipeUI[] }
export interface SetPickupsEvent extends PixiUiEvent { kind: "setPickups"; pickups: PickupToast[] }
export interface SetNotificationEvent extends PixiUiEvent { kind: "setNotification"; message: string | null }
export interface SetCraftQueueEvent extends PixiUiEvent { kind: "setCraftQueue"; queue: CraftQueueUI | null }
export interface SetTasksEvent extends PixiUiEvent { kind: "setTasks"; tasks: TaskUI[] }
export interface SetTaskMarkersEvent extends PixiUiEvent { kind: "setTaskMarkers"; markers: TaskMarkerUI[] }
export interface SetMapRegionEvent extends PixiUiEvent {
  kind: "setMapRegion";
  cells: Uint32Array; // packed 0xRRGGBB, length REGION_BLOCK_W*REGION_BLOCK_H
  cx0: number; // leftmost chunk X of the strip (wrapped to [0, CHUNKS_X))
  stations: MapStationUI[];
}

export type OverburdenEvent =
  | SetInventoryEvent
  | SetBlockheadsEvent
  | SetRecipesEvent
  | SetPickupsEvent
  | SetNotificationEvent
  | SetCraftQueueEvent
  | SetTasksEvent
  | SetTaskMarkersEvent
  | SetMapRegionEvent;

// ── Worker→main actions (side-effect requests) ──

export interface StartGameAction extends PixiUiAction { kind: "startGame" }
export interface SetPausedAction extends PixiUiAction { kind: "setPaused"; paused: boolean }
export interface ToggleInventoryPanelAction extends PixiUiAction { kind: "toggleInventoryPanel" }
export interface SetInventoryTabAction extends PixiUiAction { kind: "setInventoryTab"; tab: InventoryTab }
export interface ToggleTaskQueueAction extends PixiUiAction { kind: "toggleTaskQueue" }
export interface SetTaskModeAction extends PixiUiAction { kind: "setTaskMode"; mode: boolean }
export interface CloseStationAction extends PixiUiAction { kind: "closeStation" }
export interface CraftAction extends PixiUiAction { kind: "craft"; recipeId: string; ax: number; ay: number }
export interface RushCraftAction extends PixiUiAction { kind: "rushCraft"; ax: number; ay: number; jobId: number }
export interface AbortCraftAction extends PixiUiAction { kind: "abortCraft"; ax: number; ay: number; jobId: number }
export interface AddFuelAction extends PixiUiAction { kind: "addFuel"; ax: number; ay: number; itemId: string }
export interface GiveItemAction extends PixiUiAction { kind: "giveItem"; itemId: string; count: number }
export interface MoveSlotAction extends PixiUiAction { kind: "moveSlot"; from: number; to: number }
export interface SpawnBlockheadAction extends PixiUiAction { kind: "spawnBlockhead" }
export interface SetActiveBhIndexAction extends PixiUiAction { kind: "setActiveBhIndex"; index: number }
export interface ResetGameAction extends PixiUiAction { kind: "resetGame" }
export interface SaveNowAction extends PixiUiAction { kind: "saveNow" }
export interface QueueTaskAction extends PixiUiAction { kind: "queueTask"; type: string; targetX: number; targetY: number }
export interface CancelTaskAction extends PixiUiAction { kind: "cancelTask"; targetX: number; targetY: number }
export interface MapZoomAction extends PixiUiAction { kind: "mapZoom"; delta: number }
export interface ToggleCameraDetachedAction extends PixiUiAction { kind: "toggleCameraDetached" }

export type OverburdenAction =
  | StartGameAction
  | SetPausedAction
  | ToggleInventoryPanelAction
  | SetInventoryTabAction
  | ToggleTaskQueueAction
  | SetTaskModeAction
  | CloseStationAction
  | CraftAction
  | RushCraftAction
  | AbortCraftAction
  | AddFuelAction
  | GiveItemAction
  | MoveSlotAction
  | SpawnBlockheadAction
  | SetActiveBhIndexAction
  | ResetGameAction
  | SaveNowAction
  | QueueTaskAction
  | CancelTaskAction
  | MapZoomAction
  | ToggleCameraDetachedAction;
