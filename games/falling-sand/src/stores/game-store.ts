import { create } from "zustand";

export interface GameSettings {
  /** Probability per tick that a falling particle gets a horizontal nudge. 0 = off, 1 = always. */
  horizontalImpulseChance: number;
  /** Magnitude of horizontal impulse (cells per nudge). */
  horizontalImpulseStrength: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  horizontalImpulseChance: 0.02,
  horizontalImpulseStrength: 1,
};

export interface GameState {
  fps: number | null;
  health: number;
  selectedMaterial: number;
  paused: boolean;
  fpsHistory: number[];
  settings: GameSettings;
  showSettings: boolean;

  setFPS: (fps: number) => void;
  setHealth: (health: number) => void;
  setSelectedMaterial: (m: number) => void;
  setPaused: (p: boolean) => void;
  setSettings: (s: Partial<GameSettings>) => void;
  setShowSettings: (show: boolean) => void;
}

export const useGameStore = create<GameState>((set) => ({
  fps: null,
  health: 100,
  selectedMaterial: 1,
  paused: false,
  fpsHistory: [],
  settings: { ...DEFAULT_SETTINGS },
  showSettings: false,

  setFPS: (fps) => set((s) => {
    const history = [...s.fpsHistory, fps].slice(-30);
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    return { fps: Math.round(avg), fpsHistory: history };
  }),

  setHealth: (health) => set({ health }),
  setSelectedMaterial: (selectedMaterial) => set({ selectedMaterial }),
  setPaused: (paused) => set({ paused }),
  setSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
  setShowSettings: (showSettings) => set({ showSettings }),
}));
