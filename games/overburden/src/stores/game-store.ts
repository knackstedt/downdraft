import { create } from "zustand";
import type { BlockheadsRenderer } from "../renderer/blockheads-renderer";

// Blockhead attribute state (mirrored from SAB for UI display)
export interface BlockheadUIState {
  health: number;
  hunger: number;
  energy: number;
  air: number;
  happiness: number;
  environment: number;
}

export interface InventorySlotUI {
  itemId: string;
  count: number;
}

export interface RecipeUI {
  id: string;
  name: string;
  station: string;
}

interface GameState {
  // UI state
  showTitleScreen: boolean;
  paused: boolean;
  fps: number;
  showCraftPanel: boolean;
  showInventoryPanel: boolean;
  showTaskQueue: boolean;
  // Task mode (click to queue tasks instead of direct mining/placing)
  taskMode: boolean;
  // Deterministic mode (e2e test environment) — disables persistence
  deterministic: boolean;
  // Selected station (for station panel UI)
  selectedStation: { ax: number; ay: number } | null;
  // Blockhead state (updated by polling SAB from the UI)
  blockhead: BlockheadUIState;
  // Selected hotbar slot
  selectedSlot: number;
  // Inventory (polled from worker via RPC)
  inventory: InventorySlotUI[];
  // Available recipes (hand-craftable)
  recipes: RecipeUI[];
  // Notification toast (auto-dismisses after a few seconds)
  notification: string | null;
  // Renderer reference (set by main.tsx after init)
  renderer: BlockheadsRenderer | null;
  // Actions
  setShowTitleScreen: (show: boolean) => void;
  setPaused: (paused: boolean) => void;
  setFps: (fps: number) => void;
  setShowCraftPanel: (show: boolean) => void;
  setShowInventoryPanel: (show: boolean) => void;
  setShowTaskQueue: (show: boolean) => void;
  setTaskMode: (mode: boolean) => void;
  setDeterministic: (det: boolean) => void;
  setSelectedStation: (station: { ax: number; ay: number } | null) => void;
  setRenderer: (renderer: BlockheadsRenderer | null) => void;
  setBlockhead: (bh: BlockheadUIState) => void;
  setSelectedSlot: (slot: number) => void;
  setInventory: (inv: InventorySlotUI[]) => void;
  setRecipes: (recipes: RecipeUI[]) => void;
  setNotification: (msg: string | null) => void;
}

const defaultBh: BlockheadUIState = {
  health: 100,
  hunger: 100,
  energy: 100,
  air: 100,
  happiness: 100,
  environment: 100,
};

export const useGameStore = create<GameState>((set) => ({
  showTitleScreen: true,
  paused: false,
  fps: 0,
  showCraftPanel: false,
  showInventoryPanel: false,
  showTaskQueue: false,
  taskMode: false,
  deterministic: false,
  selectedStation: null,
  blockhead: defaultBh,
  selectedSlot: 0,
  inventory: [],
  recipes: [],
  notification: null,
  renderer: null,
  setShowTitleScreen: (show) => set({ showTitleScreen: show }),
  setPaused: (paused) => set({ paused }),
  setFps: (fps) => set({ fps }),
  setShowCraftPanel: (show) => set({ showCraftPanel: show }),
  setShowInventoryPanel: (show) => set({ showInventoryPanel: show }),
  setShowTaskQueue: (show) => set({ showTaskQueue: show }),
  setTaskMode: (mode) => set({ taskMode: mode }),
  setDeterministic: (det) => set({ deterministic: det }),
  setSelectedStation: (station) => set({ selectedStation: station }),
  setRenderer: (renderer) => set({ renderer }),
  setBlockhead: (bh) => set({ blockhead: bh }),
  setSelectedSlot: (slot) => set({ selectedSlot: slot }),
  setInventory: (inventory) => set({ inventory }),
  setRecipes: (recipes) => set({ recipes }),
  setNotification: (msg) => set({ notification: msg }),
}));
