// ============================================================================
// worker-store — reactive store for the @pixi/react components in the worker.
//
// Updated from SAB scalars + postMessage events. Uses useSyncExternalStore
// for React integration. Actions are sent back to the main thread via
// postAction.
// ============================================================================

import { useSyncExternalStore } from "react";
import type {
  Bookmark, BuildModuleData, CraftQueueEntryData, CraftRecipeData,
  MapSnapshotData, NotificationData, PlayerDiedData, ShipHoldData,
  TradeItemData, WeatherData,
} from "./bridge-protocol";

export interface HudState {
  health: number; maxHealth: number; hunger: number; thirst: number;
  oxygen: number; maxOxygen: number; temperature: number; timeOfDay: number;
  weatherType: number; biome: number; security: number; cameraMode: number;
  isFishing: boolean; fishingTension: number; fishingProgress: number;
  activeSlot: number; isPiloting: boolean; isOnboard: boolean; gold: number;
  playerX: number; playerZ: number; heading: number;
}

export interface OceanWorkerState {
  // SAB scalars
  fps: number;
  ready: boolean; simReady: boolean; lutReady: boolean;
  hudState: HudState;
  showInventory: boolean; showMap: boolean; showBuildMenu: boolean;
  showCraftMenu: boolean; showFishingMinigame: boolean; showTradeMenu: boolean;
  showSettings: boolean; showPauseMenu: boolean; showCharacterCustomization: boolean;
  showCredits: boolean; showBuilderWheel: boolean; hudHidden: boolean;
  pointerLocked: boolean; playerDied: boolean; isDev: boolean;
  suppressPauseMenu: boolean;
  builderCellType: number; builderRotation: number; reticleSize: number;
  canvasW: number; canvasH: number;
  // Event-driven data
  shipHoldData: ShipHoldData | null;
  bookmarks: Bookmark[];
  waypoint: { x: number; z: number } | null;
  playerDiedData: PlayerDiedData | null;
  weather: WeatherData | null;
  notifications: NotificationData[];
  equipment: Record<string, string | null>;
  recipes: CraftRecipeData[];
  craftQueue: CraftQueueEntryData[];
  tradeItems: TradeItemData[];
  buildModules: BuildModuleData[];
  mapSnapshot: MapSnapshotData | null;
}

const initialState: OceanWorkerState = {
  fps: 0,
  ready: false, simReady: false, lutReady: false,
  hudState: {
    health: 100, maxHealth: 100, hunger: 100, thirst: 100,
    oxygen: 100, maxOxygen: 100, temperature: 20, timeOfDay: 0.5,
    weatherType: 0, biome: 0, security: 0, cameraMode: 0,
    isFishing: false, fishingTension: 0, fishingProgress: 0,
    activeSlot: 0, isPiloting: false, isOnboard: false, gold: 0,
    playerX: 0, playerZ: 0, heading: 0,
  },
  showInventory: false, showMap: false, showBuildMenu: false,
  showCraftMenu: false, showFishingMinigame: false, showTradeMenu: false,
  showSettings: false, showPauseMenu: false, showCharacterCustomization: false,
  showCredits: false, showBuilderWheel: false, hudHidden: false,
  pointerLocked: false, playerDied: false, isDev: false,
  suppressPauseMenu: false,
  builderCellType: 0, builderRotation: 0, reticleSize: 80,
  canvasW: 1280, canvasH: 720,
  shipHoldData: null, bookmarks: [], waypoint: null,
  playerDiedData: null, weather: null, notifications: [],
  equipment: { rod: null, weapon: null, armor: null, accessory: null },
  recipes: [], craftQueue: [], tradeItems: [], buildModules: [],
  mapSnapshot: null,
};

let state: OceanWorkerState = initialState;
const listeners = new Set<() => void>();

export function getWorkerState(): OceanWorkerState { return state; }
export function setWorkerState(partial: Partial<OceanWorkerState>): void {
  state = { ...state, ...partial };
  listeners.forEach((l) => l());
}
export function subscribeWorkerState(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useWorkerState<T>(selector: (s: OceanWorkerState) => T): T {
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
