// ============================================================================
// BaseGameStore — generic Zustand state shared across all games
// Games extend this with game-specific state via the spread pattern.
// ============================================================================

import type { SaveListEntry } from "../save/grid-save-system";

export interface BaseGameStoreState<R = unknown> {
  ready: boolean;
  simReady: boolean;
  lutReady: boolean;
  isDev: boolean;
  renderer: R | null;
  fps: number;
  playerCount: number;
  splitScreenLayout: string;
  pointerLocked: boolean;
  notifications: { id: number; text: string; type: string }[];
  showPauseMenu: boolean;
  hudHidden: boolean;
  /** Simulation paused flag (games sync this to the worker host). */
  paused: boolean;
  /** Player health (0..maxHealth). */
  health: number;
  maxHealth: number;
  /** Title screen visible (game start / mode select). */
  showTitleScreen: boolean;
  /** Settings panel visible. */
  showSettings: boolean;
  /** Saves panel visible. */
  showSaves: boolean;
  /** Save-slot metadata list (for the saves panel UI). */
  saves: SaveListEntry[];
  /**
   * Suppress the pause menu on pointer-lock loss. Games set this when the
   * lock was released intentionally (e.g. opening a UI panel) so the
   * pointerlockchange handler doesn't pop the pause menu.
   */
  suppressPauseMenu: boolean;
  /**
   * Generic named-panel visibility — covers game-specific panels
   * (inventory, map, build menu, ...) without extending the base state.
   * Prefer setPanel("inventory", true) over adding showXxx fields.
   */
  panels: Record<string, boolean>;

  setReady: (r: boolean) => void;
  setSimReady: (r: boolean) => void;
  setLutReady: (r: boolean) => void;
  setIsDev: (v: boolean) => void;
  setRenderer: (r: R) => void;
  setFPS: (fps: number) => void;
  setPlayerCount: (n: number) => void;
  setSplitScreenLayout: (l: string) => void;
  setPointerLocked: (v: boolean) => void;
  addNotification: (text: string, type?: string) => void;
  /** addNotification + auto-remove after ttlMs (default 4000). */
  notify: (text: string, type?: string, ttlMs?: number) => void;
  removeNotification: (id: number) => void;
  setShowPauseMenu: (v: boolean) => void;
  setHudHidden: (v: boolean) => void;
  toggleHud: () => void;
  setPaused: (p: boolean) => void;
  togglePaused: () => void;
  setHealth: (health: number) => void;
  setMaxHealth: (max: number) => void;
  setShowTitleScreen: (v: boolean) => void;
  setShowSettings: (v: boolean) => void;
  toggleSettings: () => void;
  setShowSaves: (v: boolean) => void;
  setSaves: (saves: SaveListEntry[]) => void;
  setSuppressPauseMenu: (v: boolean) => void;
  setPanel: (name: string, open: boolean) => void;
  togglePanel: (name: string) => void;
}

let notifId = 0;

/**
 * Creates the base game store state + actions for spreading into a game's
 * Zustand store creator. Usage:
 *
 * ```ts
 * export const useGameStore = create<GameStoreState>((set, get) => ({
 *   ...createBaseGameStoreState<WebGPURenderer>(set, get),
 *   // game-specific state + actions here
 * }));
 * ```
 */
export function createBaseGameStoreState<R>(
  // Accept any zustand set/get — the game's concrete store type is a superset
  // (or deliberately divergent, e.g. `fps: number | null`), so the narrow
  // BaseGameStoreState signature would reject them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: (partial: any) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _get: () => any,
): BaseGameStoreState<R> {
  return {
    ready: false,
    simReady: false,
    lutReady: false,
    isDev: false,
    renderer: null,
    fps: 0,
    playerCount: 1,
    splitScreenLayout: "1p",
    pointerLocked: false,
    notifications: [],
    showPauseMenu: false,
    hudHidden: false,
    paused: false,
    health: 100,
    maxHealth: 100,
    showTitleScreen: false,
    showSettings: false,
    showSaves: false,
    saves: [],
    suppressPauseMenu: false,
    panels: {},

    setReady: (r) => set({ ready: r }),
    setSimReady: (r) => set({ simReady: r }),
    setLutReady: (r) => set({ lutReady: r }),
    setIsDev: (v) => set({ isDev: v }),
    setRenderer: (r) => set({ renderer: r }),
    setFPS: (fps) => set({ fps }),
    setPlayerCount: (n) => set({ playerCount: n }),
    setSplitScreenLayout: (l) => set({ splitScreenLayout: l }),
    setPointerLocked: (v) => set({ pointerLocked: v }),
    addNotification: (text, type = "info") =>
      set((s: BaseGameStoreState<R>) => ({ notifications: [...s.notifications, { id: ++notifId, text, type }] })),
    notify: (text, type = "info", ttlMs = 4000) => {
      const id = ++notifId;
      set((s: BaseGameStoreState<R>) => ({ notifications: [...s.notifications, { id, text, type }] }));
      setTimeout(() => {
        set((s: BaseGameStoreState<R>) => ({ notifications: s.notifications.filter((n) => n.id !== id) }));
      }, ttlMs);
    },
    removeNotification: (id) =>
      set((s: BaseGameStoreState<R>) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
    setShowPauseMenu: (v) => set({ showPauseMenu: v }),
    setHudHidden: (v) => set({ hudHidden: v }),
    toggleHud: () => set((s: BaseGameStoreState<R>) => ({ hudHidden: !s.hudHidden })),
    setPaused: (p) => set({ paused: p }),
    togglePaused: () => set((s: BaseGameStoreState<R>) => ({ paused: !s.paused })),
    setHealth: (health) => set({ health }),
    setMaxHealth: (maxHealth) => set({ maxHealth }),
    setShowTitleScreen: (v) => set({ showTitleScreen: v }),
    setShowSettings: (v) => set({ showSettings: v }),
    toggleSettings: () => set((s: BaseGameStoreState<R>) => ({ showSettings: !s.showSettings })),
    setShowSaves: (v) => set({ showSaves: v }),
    setSaves: (saves) => set({ saves }),
    setSuppressPauseMenu: (v) => set({ suppressPauseMenu: v }),
    setPanel: (name, open) => set((s: BaseGameStoreState<R>) => ({ panels: { ...s.panels, [name]: open } })),
    togglePanel: (name) => set((s: BaseGameStoreState<R>) => ({ panels: { ...s.panels, [name]: !s.panels[name] } })),
  };
}
