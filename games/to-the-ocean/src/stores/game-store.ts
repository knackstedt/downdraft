// ============================================================================
// Game Store — Zustand state management for UI
// Generic state comes from createBaseGameStoreState (core); game-specific
// state and actions are defined below.
// ============================================================================

import { createBaseGameStoreState, type BaseGameStoreState } from "@downdraft/core";
import { WeatherType } from "@shared/types";
import { create } from "zustand";
import { WebGPURenderer } from "../engine/webgpu-renderer";
import { simBridge } from "../sim-bridge";

interface Bookmark {
  id: number;
  x: number;
  z: number;
  label: string;
}

export interface ShipHoldData {
  isOnboard: boolean;
  shipEntityId: number;
  shipName: string;
  holdItems: { x: number; y: number; itemId: string; quantity: number; spoilProgress: number; width: number; height: number }[];
  playerItems: { x: number; y: number; itemId: string; quantity: number; spoilProgress: number; width: number; height: number }[];
}

interface GameStoreState extends BaseGameStoreState<WebGPURenderer> {
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
}

let bookmarkId = 0;

export const useGameStore = create<GameStoreState>((set, get) => ({
  ...createBaseGameStoreState<WebGPURenderer>(set as any, get as any),

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

  setWeather: (w) => set({ weather: w }),
  setPlayerDied: (d) => set({ playerDied: d }),
  toggleInventory: () => {
    if (get().showInventory) { get().renderer?.lockPointer(); set({ suppressPauseMenu: true }); }
    set((s) => ({ showInventory: !s.showInventory }));
  },
  toggleMap: () => {
    if (get().showMap) { get().renderer?.lockPointer(); set({ suppressPauseMenu: true }); }
    set((s) => ({ showMap: !s.showMap }));
  },
  toggleBuildMenu: () => {
    if (get().showBuildMenu) { get().renderer?.lockPointer(); set({ suppressPauseMenu: true }); }
    set((s) => ({ showBuildMenu: !s.showBuildMenu }));
  },
  toggleCraftMenu: () => {
    if (get().showCraftMenu) { get().renderer?.lockPointer(); set({ suppressPauseMenu: true }); }
    set((s) => ({ showCraftMenu: !s.showCraftMenu }));
  },
  toggleFishingMinigame: () => {
    if (get().showFishingMinigame) { get().renderer?.lockPointer(); set({ suppressPauseMenu: true }); }
    set((s) => ({ showFishingMinigame: !s.showFishingMinigame }));
  },
  toggleTradeMenu: () => {
    if (get().showTradeMenu) { get().renderer?.lockPointer(); set({ suppressPauseMenu: true }); }
    set((s) => ({ showTradeMenu: !s.showTradeMenu }));
  },
  toggleSettings: () => {
    if (get().showSettings) { get().renderer?.lockPointer(); set({ suppressPauseMenu: true }); }
    set((s) => ({ showSettings: !s.showSettings }));
  },
  togglePauseMenu: () => {
    if (get().showPauseMenu) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      simBridge.resumeGame();
    } else {
      simBridge.pauseGame();
    }
    set((s) => ({ showPauseMenu: !s.showPauseMenu }));
  },
  toggleCharacterCustomization: () => {
    if (get().showCharacterCustomization) { get().renderer?.lockPointer(); set({ suppressPauseMenu: true }); }
    set((s) => ({ showCharacterCustomization: !s.showCharacterCustomization }));
  },
  toggleCredits: () => {
    if (get().showCredits) { get().renderer?.lockPointer(); set({ suppressPauseMenu: true }); }
    set((s) => ({ showCredits: !s.showCredits }));
  },
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
}));
