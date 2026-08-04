// ============================================================================
// BaseGameStore — generic Zustand state shared across all games
// Games extend this with game-specific state via the spread pattern.
// ============================================================================


export interface BaseGameStoreState<R = unknown> {
  ready: boolean;
  simReady: boolean;
  lutReady: boolean;
  isDev: boolean;
  renderer: R | null;
  fps: number;
  playerCount: number;
  splitScreenLayout: string;
  notifications: { id: number; text: string; type: string }[];
  showPauseMenu: boolean;
  hudHidden: boolean;

  setReady: (r: boolean) => void;
  setSimReady: (r: boolean) => void;
  setLutReady: (r: boolean) => void;
  setIsDev: (v: boolean) => void;
  setRenderer: (r: R) => void;
  setFPS: (fps: number) => void;
  setPlayerCount: (n: number) => void;
  setSplitScreenLayout: (l: string) => void;
  addNotification: (text: string, type?: string) => void;
  removeNotification: (id: number) => void;
  setShowPauseMenu: (v: boolean) => void;
  setHudHidden: (v: boolean) => void;
  toggleHud: () => void;
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
  set: (partial: Partial<BaseGameStoreState<R>> | ((s: BaseGameStoreState<R>) => Partial<BaseGameStoreState<R>>)) => void,
  get: () => BaseGameStoreState<R>,
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
    notifications: [],
    showPauseMenu: false,
    hudHidden: false,

    setReady: (r) => set({ ready: r }),
    setSimReady: (r) => set({ simReady: r }),
    setLutReady: (r) => set({ lutReady: r }),
    setIsDev: (v) => set({ isDev: v }),
    setRenderer: (r) => set({ renderer: r }),
    setFPS: (fps) => set({ fps }),
    setPlayerCount: (n) => set({ playerCount: n }),
    setSplitScreenLayout: (l) => set({ splitScreenLayout: l }),
    addNotification: (text, type = "info") =>
      set((s) => ({ notifications: [...s.notifications, { id: ++notifId, text, type }] })),
    removeNotification: (id) =>
      set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
    setShowPauseMenu: (v) => set({ showPauseMenu: v }),
    setHudHidden: (v) => set({ hudHidden: v }),
    toggleHud: () => set((s) => ({ hudHidden: !s.hudHidden })),
  };
}

