// ============================================================================
// bridge-protocol — typed events + actions for the to-the-ocean PixiUI.
// ============================================================================

import type { PixiUiAction, PixiUiEvent, UiStatsLayout } from "@downdraft/library-pixi-ui";

// ── Per-frame scalar slots (UiStatsSAB) ──
export const OCEAN_STATS_LAYOUT: UiStatsLayout = {
  slots: [
    "fps",
    // Readiness
    "ready", "simReady", "lutReady",
    // HUD state (high-frequency)
    "health", "maxHealth", "hunger", "thirst",
    "oxygen", "maxOxygen", "temperature", "timeOfDay",
    "weatherType", "biome", "security", "cameraMode",
    "isFishing", "fishingTension", "fishingProgress",
    "activeSlot", "isPiloting", "isOnboard", "gold",
    "playerX", "playerZ", "heading",
    // Menu visibility (0/1)
    "showInventory", "showMap", "showBuildMenu", "showCraftMenu",
    "showFishingMinigame", "showTradeMenu", "showSettings",
    "showPauseMenu", "showCharacterCustomization", "showCredits",
    "showBuilderWheel", "hudHidden", "pointerLocked",
    "playerDied", "isDev", "suppressPauseMenu",
    // Builder
    "builderCellType", "builderRotation", "reticleSize",
    // Canvas
    "canvasW", "canvasH",
  ],
};

// ── Types ──
export interface ShipHoldItem { x: number; y: number; itemId: string; quantity: number; spoilProgress: number; width: number; height: number }
export interface ShipHoldData { isOnboard: boolean; shipEntityId: number; shipName: string; holdItems: ShipHoldItem[]; playerItems: ShipHoldItem[] }
export interface Bookmark { id: number; x: number; z: number; label: string }
export interface NotificationData { id: number; text: string; type: string }
export interface PlayerDiedData { playerId: number; cause: string }
export interface WeatherData { type: number; intensity: number }
export interface CraftRecipeData { id: string; name: string; station: string; ingredients: { itemId: string; count: number }[]; outputs: { itemId: string; count: number }[]; craftTime: number }
export interface CraftQueueEntryData { id: number; recipeId: string; recipeName: string; progress: number; status: string }
export interface TradeItemData { id: string; name: string; basePrice: number; quantity: number; owned: number }
export interface BuildModuleData { id: string; name: string; category: string; cost: number }
export interface MapSnapshotData {
  playerX: number; playerZ: number; heading: number;
  cameraX: number; cameraZ: number; zoom: number;
  bookmarks: Bookmark[];
  waypoint: { x: number; z: number } | null;
  // Compact tile data (downsampled)
  tiles: number[]; // packed colors
  tilesW: number; tilesH: number;
}

// ── Main→worker events ──
export interface SetShipHoldEvent extends PixiUiEvent { kind: "setShipHold"; data: ShipHoldData | null }
export interface SetBookmarksEvent extends PixiUiEvent { kind: "setBookmarks"; bookmarks: Bookmark[] }
export interface SetWaypointEvent extends PixiUiEvent { kind: "setWaypoint"; waypoint: { x: number; z: number } | null }
export interface SetPlayerDiedEvent extends PixiUiEvent { kind: "setPlayerDied"; data: PlayerDiedData | null }
export interface SetWeatherEvent extends PixiUiEvent { kind: "setWeather"; data: WeatherData | null }
export interface AddNotificationEvent extends PixiUiEvent { kind: "addNotification"; notification: NotificationData }
export interface RemoveNotificationEvent extends PixiUiEvent { kind: "removeNotification"; id: number }
export interface SetEquipmentEvent extends PixiUiEvent { kind: "setEquipment"; equipment: Record<string, string | null> }
export interface SetRecipesEvent extends PixiUiEvent { kind: "setRecipes"; recipes: CraftRecipeData[] }
export interface SetCraftQueueEvent extends PixiUiEvent { kind: "setCraftQueue"; queue: CraftQueueEntryData[] }
export interface SetTradeItemsEvent extends PixiUiEvent { kind: "setTradeItems"; items: TradeItemData[] }
export interface SetBuildModulesEvent extends PixiUiEvent { kind: "setBuildModules"; modules: BuildModuleData[] }
export interface SetMapSnapshotEvent extends PixiUiEvent { kind: "setMapSnapshot"; snapshot: MapSnapshotData }
export interface SetNotificationsEvent extends PixiUiEvent { kind: "setNotifications"; notifications: NotificationData[] }

export type OceanEvent =
  | SetShipHoldEvent | SetBookmarksEvent | SetWaypointEvent
  | SetPlayerDiedEvent | SetWeatherEvent | AddNotificationEvent
  | RemoveNotificationEvent | SetEquipmentEvent | SetRecipesEvent
  | SetCraftQueueEvent | SetTradeItemsEvent | SetBuildModulesEvent
  | SetMapSnapshotEvent | SetNotificationsEvent;

// ── Worker→main actions ──
export interface ToggleMenuAction extends PixiUiAction { kind: "toggleMenu"; menu: string }
export interface CloseMenuAction extends PixiUiAction { kind: "closeMenu"; menu: string }
export interface EquipItemAction extends PixiUiAction { kind: "equipItem"; slot: string; itemId: string | null }
export interface AddBookmarkAction extends PixiUiAction { kind: "addBookmark"; x: number; z: number; label: string }
export interface RemoveBookmarkAction extends PixiUiAction { kind: "removeBookmark"; id: number }
export interface SetWaypointAction extends PixiUiAction { kind: "setWaypoint"; waypoint: { x: number; z: number } | null }
export interface SendCommandAction extends PixiUiAction { kind: "sendCommand"; command: string; data?: any }
export interface SaveGameAction extends PixiUiAction { kind: "saveGame" }
export interface LoadGameAction extends PixiUiAction { kind: "loadGame" }
export interface ResetGameAction extends PixiUiAction { kind: "resetGame" }
export interface QuitAction extends PixiUiAction { kind: "quit" }
export interface RespawnAction extends PixiUiAction { kind: "respawn" }
export interface SetSettingAction extends PixiUiAction { kind: "setSetting"; key: string; value: any }
export interface SetBuilderCellTypeAction extends PixiUiAction { kind: "setBuilderCellType"; idx: number }
export interface SetBuilderRotationAction extends PixiUiAction { kind: "setBuilderRotation"; rotation: number }
export interface SetReticleSizeAction extends PixiUiAction { kind: "setReticleSize"; size: number }
export interface LockPointerAction extends PixiUiAction { kind: "lockPointer" }
export interface CraftAction extends PixiUiAction { kind: "craft"; recipeId: string }
export interface AbortCraftAction extends PixiUiAction { kind: "abortCraft"; jobId: number }
export interface TradeAction extends PixiUiAction { kind: "trade"; itemId: string; quantity: number; buy: boolean }
export interface BuildAction extends PixiUiAction { kind: "build"; moduleId: string }
export interface TransferItemAction extends PixiUiAction { kind: "transferItem"; direction: "to_ship" | "from_ship"; itemId?: string; quantity?: number }
export interface OpenExternalAction extends PixiUiAction { kind: "openExternal"; url: string }
export interface SetFontScaleAction extends PixiUiAction { kind: "setFontScale"; scale: number }

export type OceanAction =
  | ToggleMenuAction | CloseMenuAction | EquipItemAction
  | AddBookmarkAction | RemoveBookmarkAction | SetWaypointAction
  | SendCommandAction | SaveGameAction | LoadGameAction | ResetGameAction
  | QuitAction | RespawnAction | SetSettingAction | SetBuilderCellTypeAction
  | SetBuilderRotationAction | SetReticleSizeAction | LockPointerAction
  | CraftAction | AbortCraftAction | TradeAction | BuildAction
  | TransferItemAction | OpenExternalAction | SetFontScaleAction;
