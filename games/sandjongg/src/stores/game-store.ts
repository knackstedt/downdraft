// ============================================================================
// Game store — Zustand state for the Sandjongg UI overlay.
// ============================================================================

import { create } from "zustand";
import type { SandjonggRenderer } from "../renderer/sandjongg-renderer";

export interface GameStoreState {
  // --- Display state ---
  score: number;
  combo: number;
  level: number;
  tilesLeft: number;
  highScore: number;
  paused: boolean;
  showHelp: boolean;
  fps: number;
  lastStatsUpdate: number;

  // --- Toast notification ---
  toast: { message: string; id: number } | null;

  // --- Renderer reference ---
  renderer: SandjonggRenderer | null;

  // --- Internal pending actions (set by UI, consumed by renderer) ---
  _pendingHint: boolean;
  _pendingShuffle: boolean;
  _pendingNewGame: boolean;
  _pendingNewGameLevel: number;
  _pendingAdvance: boolean;
  _pendingAdvanceLevel: number;
  _pendingClearSand: boolean;

  // --- Actions ---
  setScore: (score: number) => void;
  addScore: (delta: number) => void;
  setCombo: (combo: number) => void;
  setLevel: (level: number) => void;
  setTilesLeft: (tilesLeft: number) => void;
  setHighScore: (highScore: number) => void;
  setPaused: (paused: boolean) => void;
  toggleHelp: () => void;
  setFPS: (fps: number) => void;
  setLastStatsUpdate: (t: number) => void;
  setRenderer: (r: SandjonggRenderer) => void;
  loadFullState: (state: { score: number; level: number; combo: number }) => void;
  showToast: (message: string, durationMs?: number) => void;

  // --- Pending action setters ---
  requestHint: () => void;
  requestShuffle: () => void;
  requestNewGame: (level: number) => void;
  requestAdvance: (level: number) => void;
  requestClearSand: () => void;
  _setPendingHint: (v: boolean) => void;
  _setPendingShuffle: (v: boolean) => void;
  _setPendingNewGame: (level: number) => void;
  _setPendingAdvance: (level: number) => void;
  _setPendingClearSand: (v: boolean) => void;
}

export const useGameStore = create<GameStoreState>((set) => ({
  score: 0,
  combo: 0,
  level: 1,
  tilesLeft: 0,
  highScore: 0,
  paused: false,
  showHelp: false,
  fps: 0,
  lastStatsUpdate: 0,

  toast: null,

  renderer: null,

  _pendingHint: false,
  _pendingShuffle: false,
  _pendingNewGame: false,
  _pendingNewGameLevel: 0,
  _pendingAdvance: false,
  _pendingAdvanceLevel: 0,
  _pendingClearSand: false,

  setScore: (score) => set((s) => {
    const highScore = Math.max(s.highScore, score);
    return { score, highScore };
  }),
  addScore: (delta) => set((s) => {
    const score = s.score + delta;
    const highScore = Math.max(s.highScore, score);
    return { score, highScore };
  }),
  setCombo: (combo) => set({ combo }),
  setLevel: (level) => set({ level }),
  setTilesLeft: (tilesLeft) => set({ tilesLeft }),
  setHighScore: (highScore) => set({ highScore }),
  setPaused: (paused) => set({ paused }),
  toggleHelp: () => set((s) => ({ showHelp: !s.showHelp })),
  setFPS: (fps) => set({ fps }),
  setLastStatsUpdate: (t) => set({ lastStatsUpdate: t }),
  setRenderer: (r) => set({ renderer: r }),
  loadFullState: (state) => set({ score: state.score, level: state.level, combo: state.combo }),
  showToast: (message, durationMs = 2000) => {
    const id = Date.now() + Math.random();
    set({ toast: { message, id } });
    setTimeout(() => {
      set((s) => (s.toast?.id === id ? { toast: null } : {}));
    }, durationMs);
  },

  requestHint: () => set({ _pendingHint: true }),
  requestShuffle: () => set({ _pendingShuffle: true }),
  requestNewGame: (level) => set({ _pendingNewGame: true, _pendingNewGameLevel: level }),
  requestAdvance: (level) => set({ _pendingAdvance: true, _pendingAdvanceLevel: level }),
  requestClearSand: () => set({ _pendingClearSand: true }),

  _setPendingHint: (v) => set({ _pendingHint: v }),
  _setPendingShuffle: (v) => set({ _pendingShuffle: v }),
  _setPendingNewGame: (level) => set({ _pendingNewGame: level > 0, _pendingNewGameLevel: level }),
  _setPendingAdvance: (level) => set({ _pendingAdvance: level > 0, _pendingAdvanceLevel: level }),
  _setPendingClearSand: (v) => set({ _pendingClearSand: v }),
}));
