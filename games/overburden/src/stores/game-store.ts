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

interface GameState {
  // UI state
  showTitleScreen: boolean;
  paused: boolean;
  fps: number;
  // Blockhead state (updated by polling SAB from the UI)
  blockhead: BlockheadUIState;
  // Selected hotbar slot
  selectedSlot: number;
  // Renderer reference (set by main.tsx after init)
  renderer: BlockheadsRenderer | null;
  // Actions
  setShowTitleScreen: (show: boolean) => void;
  setPaused: (paused: boolean) => void;
  setFps: (fps: number) => void;
  setRenderer: (renderer: BlockheadsRenderer | null) => void;
  setBlockhead: (bh: BlockheadUIState) => void;
  setSelectedSlot: (slot: number) => void;
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
  blockhead: defaultBh,
  selectedSlot: 0,
  renderer: null,
  setShowTitleScreen: (show) => set({ showTitleScreen: show }),
  setPaused: (paused) => set({ paused }),
  setFps: (fps) => set({ fps }),
  setRenderer: (renderer) => set({ renderer }),
  setBlockhead: (bh) => set({ blockhead: bh }),
  setSelectedSlot: (slot) => set({ selectedSlot: slot }),
}));
