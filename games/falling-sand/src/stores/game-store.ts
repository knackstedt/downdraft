import { create } from "zustand";

export interface GameState {
  fps: number | null;
  health: number;
  selectedMaterial: number;
  paused: boolean;
  fpsHistory: number[];

  setFPS: (fps: number) => void;
  setHealth: (health: number) => void;
  setSelectedMaterial: (m: number) => void;
  setPaused: (p: boolean) => void;
}

export const useGameStore = create<GameState>((set) => ({
  fps: null,
  health: 100,
  selectedMaterial: 1,
  paused: false,
  fpsHistory: [],

  setFPS: (fps) => set((s) => {
    const history = [...s.fpsHistory, fps].slice(-30);
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    return { fps: Math.round(avg), fpsHistory: history };
  }),

  setHealth: (health) => set({ health }),
  setSelectedMaterial: (selectedMaterial) => set({ selectedMaterial }),
  setPaused: (paused) => set({ paused }),
}));
