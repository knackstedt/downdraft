// ============================================================================
// Game store — Zustand state for the Sandjongg UI overlay.
// ============================================================================

import { create } from "zustand";
import type { SandjonggRenderer } from "../renderer/sandjongg-renderer";
import type { DebugTileInfo, GameMode } from "../shared/types";

export interface GameStoreState {
  // --- Display state ---
  score: number;
  combo: number;
  level: number;
  tilesLeft: number;
  highScore: number;
  paused: boolean;
  showHelp: boolean;
  showSettings: boolean;
  fps: number;
  lastStatsUpdate: number;
  /** Timestamp (ms, performance.now()) of the last successful match — drives
   *  the combo countdown timer in the HUD. 0 = no active combo window. */
  lastMatchTime: number;

  // --- Game mode + sand physics ---
  /** Active game mode (selected from the main menu). Drives generation,
   *  selectability, and matching rules. */
  mode: GameMode;
  /** When false, the renderer skips spawning crumbled-tile sand — the falling
   *  sand pit is disabled entirely. Board play is unaffected. */
  sandEnabled: boolean;

  // --- Menu state ---
  /** Main menu (mode select) is shown. While true, gameplay is hidden. */
  showMainMenu: boolean;
  /** Pause menu overlay is shown. While true, the sim is paused. */
  showPauseMenu: boolean;
  /** Per-mode save availability, populated when the main menu opens so the
   *  "Continue" buttons can be shown only when a save exists. */
  hasSave: Record<GameMode, boolean>;

  // --- Debug mode ---
  /** When true, clicking a tile shows its full info (element, material, position,
   *  layer, neighbors) in a debug panel instead of selecting/matching. */
  debugMode: boolean;
  /** Last tile inspected in debug mode (null = none / cleared). */
  debugTile: DebugTileInfo | null;

  // --- Generation options ---
  /** Effective no-adjacent-same-element flag (auto-set from level, user can override). */
  noAdjacentSame: boolean;
  /** Whether the user has manually toggled noAdjacentSame (disables auto rule). */
  noAdjacentUserSet: boolean;
  /** Custom board columns (0 = auto-scale with level). */
  customCols: number;
  /** Custom board rows (0 = auto-scale with level). */
  customRows: number;

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
  /** Set when custom dims change and the player wants a fresh board. */
  _pendingApplyDims: boolean;
  /** Set when the mode changes and the worker should be reconfigured + a new
   *  game started in the new mode. */
  _pendingModeChange: boolean;

  // --- Actions ---
  setScore: (score: number) => void;
  addScore: (delta: number) => void;
  setCombo: (combo: number) => void;
  /** Set combo + record the match timestamp for the countdown timer.
   *  Pass 0 to clear the combo (e.g. on new game / level change). */
  setComboWithTime: (combo: number, now?: number) => void;
  setLevel: (level: number) => void;
  setTilesLeft: (tilesLeft: number) => void;
  setHighScore: (highScore: number) => void;
  setPaused: (paused: boolean) => void;
  toggleHelp: () => void;
  toggleSettings: () => void;
  setFPS: (fps: number) => void;
  setLastStatsUpdate: (t: number) => void;
  setRenderer: (r: SandjonggRenderer) => void;
  loadFullState: (state: { score: number; level: number; combo: number }) => void;
  showToast: (message: string, durationMs?: number) => void;
  toggleNoAdjacentSame: () => void;
  setCustomDims: (cols: number, rows: number) => void;
  toggleDebugMode: () => void;
  setDebugTile: (info: DebugTileInfo | null) => void;

  // --- Mode + sand + menu actions ---
  setMode: (mode: GameMode) => void;
  setSandEnabled: (enabled: boolean) => void;
  toggleSandEnabled: () => void;
  setShowMainMenu: (show: boolean) => void;
  setShowPauseMenu: (show: boolean) => void;
  togglePauseMenu: () => void;
  setHasSave: (mode: GameMode, has: boolean) => void;

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
  _setPendingApplyDims: (v: boolean) => void;
  _setPendingModeChange: (v: boolean) => void;
}

export const useGameStore = create<GameStoreState>((set) => ({
  score: 0,
  combo: 0,
  level: 1,
  tilesLeft: 0,
  highScore: 0,
  paused: false,
  showHelp: false,
  showSettings: false,
  fps: 0,
  lastStatsUpdate: 0,
  lastMatchTime: 0,

  mode: "sandjongg",
  sandEnabled: true,
  showMainMenu: false,
  showPauseMenu: false,
  hasSave: { sandjongg: false, mahjongg: false },

  debugMode: false,
  debugTile: null,

  noAdjacentSame: false,
  noAdjacentUserSet: false,
  customCols: 0,
  customRows: 0,

  toast: null,

  renderer: null,

  _pendingHint: false,
  _pendingShuffle: false,
  _pendingNewGame: false,
  _pendingNewGameLevel: 0,
  _pendingAdvance: false,
  _pendingAdvanceLevel: 0,
  _pendingClearSand: false,
  _pendingApplyDims: false,
  _pendingModeChange: false,

  setScore: (score) => set((s) => {
    const highScore = Math.max(s.highScore, score);
    return { score, highScore };
  }),
  addScore: (delta) => set((s) => {
    const score = s.score + delta;
    const highScore = Math.max(s.highScore, score);
    return { score, highScore };
  }),
  setCombo: (combo) => set((s) => (combo === 0 ? { combo, lastMatchTime: 0 } : { combo })),
  setComboWithTime: (combo, now) => set({
    combo,
    lastMatchTime: combo > 0 ? (now ?? performance.now()) : 0,
  }),
  setLevel: (level) => set((s) => {
    // Auto-enable no-adjacent-same after level 10 unless the user has
    // manually toggled the option (in which case their choice sticks).
    if (s.noAdjacentUserSet) return { level };
    return { level, noAdjacentSame: level > 10 };
  }),
  setTilesLeft: (tilesLeft) => set({ tilesLeft }),
  setHighScore: (highScore) => set({ highScore }),
  setPaused: (paused) => set({ paused }),
  toggleHelp: () => set((s) => ({ showHelp: !s.showHelp })),
  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),
  setFPS: (fps) => set({ fps }),
  setLastStatsUpdate: (t) => set({ lastStatsUpdate: t }),
  setRenderer: (r) => set({ renderer: r }),
  loadFullState: (state) => set((s) => {
    if (s.noAdjacentUserSet) return { score: state.score, level: state.level, combo: state.combo };
    return { score: state.score, level: state.level, combo: state.combo, noAdjacentSame: state.level > 10 };
  }),
  showToast: (message, durationMs = 2000) => {
    const id = Date.now() + Math.random();
    set({ toast: { message, id } });
    setTimeout(() => {
      set((s) => (s.toast?.id === id ? { toast: null } : {}));
    }, durationMs);
  },
  toggleNoAdjacentSame: () => set((s) => ({
    noAdjacentSame: !s.noAdjacentSame,
    noAdjacentUserSet: true,
  })),
  setCustomDims: (cols, rows) => set({
    customCols: cols,
    customRows: rows,
    _pendingApplyDims: true,
  }),
  toggleDebugMode: () => set((s) => ({ debugMode: !s.debugMode, debugTile: s.debugMode ? null : s.debugTile })),
  setDebugTile: (info) => set({ debugTile: info }),

  setMode: (mode) => set({ mode, _pendingModeChange: true }),
  setSandEnabled: (enabled) => set({ sandEnabled: enabled }),
  toggleSandEnabled: () => set((s) => ({ sandEnabled: !s.sandEnabled })),
  setShowMainMenu: (show) => set({ showMainMenu: show }),
  setShowPauseMenu: (show) => set({ showPauseMenu: show }),
  togglePauseMenu: () => set((s) => ({ showPauseMenu: !s.showPauseMenu })),
  setHasSave: (mode, has) => set((s) => ({ hasSave: { ...s.hasSave, [mode]: has } })),

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
  _setPendingApplyDims: (v) => set({ _pendingApplyDims: v }),
  _setPendingModeChange: (v) => set({ _pendingModeChange: v }),
}));
