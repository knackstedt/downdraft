// ============================================================================
// game-store-worker — worker-safe version of the game store.
//
// The main thread's game-store.ts imports WebGPURenderer (a class), which
// pulls in the entire rendering engine and fails in the worker. This file
// creates an identical store but uses `unknown` for the renderer type,
// avoiding the import chain.
// ============================================================================

import { createBaseGameStoreState, type BaseGameStoreState } from "@downdraft/core";
import { WeatherType } from "@shared/types";
import { create } from "zustand";

// Re-export the types that components need (without importing WebGPURenderer)
export interface ShipHoldData {
  isOnboard: boolean;
  shipEntityId: number;
  shipName: string;
  holdItems: { x: number; y: number; itemId: string; quantity: number; spoilProgress: number; width: number; height: number }[];
  playerItems: { x: number; y: number; itemId: string; quantity: number; spoilProgress: number; width: number; height: number }[];
}

interface Bookmark {
  id: number;
  x: number;
  z: number;
  label: string;
}

interface GameStoreWorkerState extends BaseGameStoreState<unknown> {
  weather: { type: WeatherType; intensity: number } | null;
  playerDied: { playerId: number; cause: string } | null;
  showInventory: boolean;
  shipHoldData: ShipHoldData | null;
  showMap: boolean;
  showBuildMenu: boolean;
  showCraftMenu: boolean;
  showFishingMinigame: boolean;
  showTradeMenu: boolean;
  showSettings: boolean;
  showCharacterCustomization: boolean;
  showCredits: boolean;
  equipment: Record<string, string | null>;
  suppressPauseMenu: boolean;
  reticleSize: number;
  builderCellType: number;
  builderRotation: number;
  showBuilderWheel: boolean;
  bookmarks: Bookmark[];
  waypoint: { x: number; z: number } | null;
  simBridge: unknown | null;
  currentSimSpeed: number;

  setWeather: (w: any) => void;
  setPlayerDied: (d: any) => void;
  toggleInventory: () => void;
  toggleMap: () => void;
  toggleBuildMenu: () => void;
  toggleCraftMenu: () => void;
  toggleFishingMinigame: () => void;
  toggleTradeMenu: () => void;
  toggleSettings: () => void;
  togglePauseMenu: () => void;
  toggleCharacterCustomization: () => void;
  toggleCredits: () => void;
  equipItem: (slot: string, itemId: string | null) => void;
  setSuppressPauseMenu: (v: boolean) => void;
  setReticleSize: (v: number) => void;
  setBuilderCellType: (idx: number) => void;
  setBuilderRotation: (r: number) => void;
  setShowBuilderWheel: (v: boolean) => void;
  addBookmark: (x: number, z: number, label: string) => void;
  removeBookmark: (id: number) => void;
  setWaypoint: (wp: { x: number; z: number } | null) => void;
  setShipHoldData: (data: ShipHoldData | null) => void;
  setSimBridge: (b: unknown) => void;
  setCurrentSimSpeed: (v: number) => void;
}

let bookmarkId = 0;

export const useGameStore = create<GameStoreWorkerState>((set, get) => ({
  ...createBaseGameStoreState<unknown>(set as any, get as any),

  weather: null,
  playerDied: null,
  showInventory: false,
  shipHoldData: null,
  showMap: false,
  showBuildMenu: false,
  showCraftMenu: false,
  showFishingMinigame: false,
  showTradeMenu: false,
  showSettings: false,
  showCharacterCustomization: false,
  showCredits: false,
  equipment: { rod: null, weapon: null, armor: null, accessory: null },
  suppressPauseMenu: false,
  reticleSize: 80,
  builderCellType: 0,
  builderRotation: 0,
  showBuilderWheel: false,
  bookmarks: [],
  waypoint: null,
  simBridge: null,
  currentSimSpeed: 1.0,

  setWeather: (w) => set({ weather: w }),
  setPlayerDied: (d) => set({ playerDied: d }),
  toggleInventory: () => set((s) => ({ showInventory: !s.showInventory })),
  toggleMap: () => set((s) => ({ showMap: !s.showMap })),
  toggleBuildMenu: () => set((s) => ({ showBuildMenu: !s.showBuildMenu })),
  toggleCraftMenu: () => set((s) => ({ showCraftMenu: !s.showCraftMenu })),
  toggleFishingMinigame: () => set((s) => ({ showFishingMinigame: !s.showFishingMinigame })),
  toggleTradeMenu: () => set((s) => ({ showTradeMenu: !s.showTradeMenu })),
  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),
  togglePauseMenu: () => set((s) => ({ showPauseMenu: !s.showPauseMenu })),
  toggleCharacterCustomization: () => set((s) => ({ showCharacterCustomization: !s.showCharacterCustomization })),
  toggleCredits: () => set((s) => ({ showCredits: !s.showCredits })),
  equipItem: (slot, itemId) =>
    set((s) => ({ equipment: { ...s.equipment, [slot]: itemId } })),
  setSuppressPauseMenu: (v) => set({ suppressPauseMenu: v }),
  setReticleSize: (v) => set({ reticleSize: v }),
  setBuilderCellType: (idx) => set({ builderCellType: idx }),
  setBuilderRotation: (r) => set({ builderRotation: ((r % 4) + 4) % 4 }),
  setShowBuilderWheel: (v) => set({ showBuilderWheel: v }),
  addBookmark: (x, z, label) =>
    set((s) => ({ bookmarks: [...s.bookmarks, { id: ++bookmarkId, x, z, label }] })),
  removeBookmark: (id) =>
    set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) })),
  setWaypoint: (wp) => set({ waypoint: wp }),
  setShipHoldData: (data) => set({ shipHoldData: data }),
  setSimBridge: (b) => set({ simBridge: b }),
  setCurrentSimSpeed: (v) => set({ currentSimSpeed: v }),
}));
