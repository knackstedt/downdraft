import { create } from "zustand";
import type { InventoryEntry } from "../shared/types";

export interface GameState {
  fps: number | null;
  health: number;
  depth: number; // player depth in chunks (0 = surface)
  paused: boolean;
  digRadius: number;
  inventory: InventoryEntry[];
  loadedChunks: number;
  activeChunks: number;
  renderer: unknown | null; // set to MiningRenderer at runtime; typed as unknown to avoid circular import
  showInventory: boolean;

  setFPS: (fps: number) => void;
  setHealth: (health: number) => void;
  setDepth: (depth: number) => void;
  setPaused: (p: boolean) => void;
  setDigRadius: (r: number) => void;
  setInventory: (inv: InventoryEntry[]) => void;
  addToInventory: (mat: number, count: number) => void;
  setLoadedChunks: (n: number) => void;
  setActiveChunks: (n: number) => void;
  setRenderer: (r: unknown | null) => void;
  setShowInventory: (show: boolean) => void;
}

export const useGameStore = create<GameState>((set) => ({
  fps: null,
  health: 100,
  depth: 0,
  paused: false,
  digRadius: 3,
  inventory: [],
  loadedChunks: 0,
  activeChunks: 0,
  renderer: null,
  showInventory: false,

  setFPS: (fps) => set({ fps }),
  setHealth: (health) => set({ health }),
  setDepth: (depth) => set({ depth }),
  setPaused: (paused) => set({ paused }),
  setDigRadius: (digRadius) => set({ digRadius }),
  setInventory: (inventory) => set({ inventory }),
  addToInventory: (mat, count) =>
    set((s) => {
      const existing = s.inventory.find((e) => e.mat === mat);
      if (existing) {
        return {
          inventory: s.inventory.map((e) =>
            e.mat === mat ? { ...e, count: e.count + count } : e,
          ),
        };
      }
      return { inventory: [...s.inventory, { mat, count }] };
    }),
  setLoadedChunks: (loadedChunks) => set({ loadedChunks }),
  setActiveChunks: (activeChunks) => set({ activeChunks }),
  setRenderer: (renderer) => set({ renderer }),
  setShowInventory: (showInventory) => set({ showInventory }),
}));
