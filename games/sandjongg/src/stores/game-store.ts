// ============================================================================
// Game store — Zustand state for the Sandjongg UI overlay.
// ============================================================================

import { createBaseGameStoreState, type BaseGameStoreState } from "@downdraft/core";
import { create } from "zustand";
import type { SandjonggRenderer } from "../renderer/sandjongg-renderer";
import type { TilesetId, TileTheme } from "../shared/tilesets";
import type { DebugTileInfo, GameMode } from "../shared/types";

export interface GameStoreState extends BaseGameStoreState<SandjonggRenderer> {
  // --- Display state ---
  score: number;
  combo: number;
  level: number;
  tilesLeft: number;
  highScore: number;
  showHelp: boolean;
  /** Settings modal is shown. */
  showSettings: boolean;
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

  // --- Tileset + theme ---
  /** Active tileset — determines the visual tile face (procedural elements vs
   *  SVG riichi tiles) and the sand-material mapping for crumbled tiles.
   *  Changing it regenerates the current level (the tile count differs, so
   *  old board ids are invalid) but keeps the score. */
  tileset: TilesetId;
  /** Active theme (light/dark) — only affects asset-based tilesets (riichi).
   *  Purely visual; changing it reloads the SVG atlas without regenerating
   *  the board. */
  tileTheme: TileTheme;

  // --- Menu state ---
  /** Main menu (mode select) is shown. While true, gameplay is hidden. */
  showMainMenu: boolean;
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
  /** Set when the tileset changes and the worker should be reconfigured + the
   *  current level regenerated (tile count differs → old ids invalid). The
   *  theme is purely visual and does NOT set this flag. */
  _pendingTilesetChange: boolean;

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
  toggleHelp: () => void;
  toggleSettings: () => void;
  setShowSettings: (v: boolean) => void;
  setLastStatsUpdate: (t: number) => void;
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
  // --- Tileset + theme actions ---
  /** Set the active tileset. Sets _pendingTilesetChange so the renderer
   *  regenerates the current level in the new tileset (keeps score). */
  setTileset: (id: TilesetId) => void;
  /** Set the active theme (light/dark). Purely visual — no regenerate. */
  setTileTheme: (theme: TileTheme) => void;
  setShowMainMenu: (show: boolean) => void;
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
  _setPendingTilesetChange: (v: boolean) => void;
}

export const useGameStore = create<GameStoreState>((set, get) => ({
  ...createBaseGameStoreState<SandjonggRenderer>(set, get),
  score: 0,
  combo: 0,
  level: 1,
  tilesLeft: 0,
  highScore: 0,
  showHelp: false,
  showSettings: false,
  lastStatsUpdate: 0,
  lastMatchTime: 0,

  mode: "sandjongg",
  sandEnabled: true,
  showMainMenu: false,
  hasSave: { sandjongg: false, mahjongg: false },

  tileset: "elements",
  tileTheme: "light",

  debugMode: false,
  debugTile: null,

  noAdjacentSame: false,
  noAdjacentUserSet: false,
  customCols: 0,
  customRows: 0,

  toast: null,

  _pendingHint: false,
  _pendingShuffle: false,
  _pendingNewGame: false,
  _pendingNewGameLevel: 0,
  _pendingAdvance: false,
  _pendingAdvanceLevel: 0,
  _pendingClearSand: false,
  _pendingApplyDims: false,
  _pendingModeChange: false,
  _pendingTilesetChange: false,

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
  toggleHelp: () => set((s) => ({ showHelp: !s.showHelp })),
  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),
  setShowSettings: (v) => set({ showSettings: v }),
  setLastStatsUpdate: (t) => set({ lastStatsUpdate: t }),
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
  setTileset: (id) => set((s) => (s.tileset === id ? {} : { tileset: id, _pendingTilesetChange: true })),
  setTileTheme: (theme) => set((s) => (s.tileTheme === theme ? {} : { tileTheme: theme })),
  setShowMainMenu: (show) => set({ showMainMenu: show }),
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
  _setPendingTilesetChange: (v) => set({ _pendingTilesetChange: v }),
}));
