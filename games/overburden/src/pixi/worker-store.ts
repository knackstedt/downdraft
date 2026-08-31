// ============================================================================
// Worker-side store mirror — a minimal reactive store that the @pixi/react
// components read from. Updated from SAB ticks + events. Uses
// useSyncExternalStore for React integration.
// ============================================================================

import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  BlockheadUIState,
  CraftQueueUI,
  InventoryUI,
  InventoryTab,
  PickupToast,
  RecipeUI,
  Season,
  TaskMarkerUI,
  TaskUI,
} from "./bridge-protocol";

export interface OverburdenWorkerState {
  // SAB scalars
  fps: number;
  health: number;
  hunger: number;
  energy: number;
  air: number;
  happiness: number;
  environment: number;
  activeBhIndex: number;
  blockheadCount: number;
  selectedSlot: number;
  inventoryTab: InventoryTab;
  showTitleScreen: boolean;
  paused: boolean;
  showInventoryPanel: boolean;
  showCraftPanel: boolean;
  showTaskQueue: boolean;
  taskMode: boolean;
  deterministic: boolean;
  hasSelectedStation: boolean;
  selectedStationAx: number;
  selectedStationAy: number;
  season: Season;
  dayInSeason: number;
  year: number;
  characterGender: "male" | "female";
  cameraDetached: boolean;
  debugNoShadows: boolean;
  debugInspect: boolean;
  canvasW: number;
  canvasH: number;
  // Event-driven data
  inventory: InventoryUI;
  blockheads: BlockheadUIState[];
  recipes: RecipeUI[];
  pickups: PickupToast[];
  notification: string | null;
  craftQueue: CraftQueueUI | null;
  tasks: TaskUI[];
  taskMarkers: TaskMarkerUI[];
  mapRegion: {
    cells: { col: number; row: number; avgColor: number }[];
    playerX: number; playerY: number; playerFacing: number;
    cameraX: number; cameraY: number; cameraZoom: number;
    mapOpacity: number;
    activeGridX: number; activeGridY: number;
    stations: { x: number; y: number; color: number }[];
  } | null;
}

const initialState: OverburdenWorkerState = {
  fps: 0, health: 100, hunger: 100, energy: 100, air: 100, happiness: 100, environment: 100,
  activeBhIndex: 0, blockheadCount: 1, selectedSlot: 0,
  inventoryTab: "inventory",
  showTitleScreen: true, paused: false, showInventoryPanel: false, showCraftPanel: false,
  showTaskQueue: false, taskMode: false, deterministic: false,
  hasSelectedStation: false, selectedStationAx: 0, selectedStationAy: 0,
  season: "spring", dayInSeason: 1, year: 1,
  characterGender: "male",
  cameraDetached: false, debugNoShadows: false, debugInspect: false,
  canvasW: 1280, canvasH: 720,
  inventory: new Array(54).fill(null),
  blockheads: [{ health: 100, hunger: 100, energy: 100, air: 100, happiness: 100, environment: 100 }],
  recipes: [], pickups: [], notification: null,
  craftQueue: null, tasks: [], taskMarkers: [], mapRegion: null,
};

// ── Store implementation (singleton in the worker) ──

let state: OverburdenWorkerState = initialState;
const listeners = new Set<() => void>();

export function getWorkerState(): OverburdenWorkerState {
  return state;
}

export function setWorkerState(partial: Partial<OverburdenWorkerState>): void {
  state = { ...state, ...partial };
  listeners.forEach((l) => l());
}

export function subscribeWorkerState(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// ── React hook for reading the worker store ──

export function useWorkerState<T>(selector: (s: OverburdenWorkerState) => T): T {
  return useSyncExternalStore(
    subscribeWorkerState,
    () => selector(state),
    () => selector(initialState),
  );
}

// ── Hook for reading + dispatching actions ──

// The postAction function is set by the scene factory.
let _postAction: ((action: any) => void) | null = null;
export function setPostAction(fn: (action: any) => void): void { _postAction = fn; }
export function postAction(action: any): void {
  if (_postAction) _postAction(action);
  else console.warn("[worker-store] postAction called before setPostAction");
}
