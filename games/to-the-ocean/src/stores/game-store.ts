// ============================================================================
// Game Store — Zustand state management for UI
// Generic state comes from createBaseGameStoreState (core); game-specific
// state and actions are defined below.
// ============================================================================

import { createBaseGameStoreState, type BaseGameStoreState } from "@downdraft/core";
import { WeatherType } from "@shared/types";
import { create } from "zustand";
import type { WebGPURenderer } from "../engine/webgpu-renderer";
import type { SimBridge } from "../sim-bridge";

interface Bookmark {
  id: number;
  x: number;
  z: number;
  label: string;
}

export interface ShipHoldData {
  isOnboard: boolean;
  shipEntityId: number;
  shipName: string;
  holdItems: { x: number; y: number; itemId: string; quantity: number; spoilProgress: number; width: number; height: number }[];
  playerItems: { x: number; y: number; itemId: string; quantity: number; spoilProgress: number; width: number; height: number }[];
}

interface GameStoreState extends BaseGameStoreState<WebGPURenderer> {
  weather: { type: WeatherType; intensity: number } | null;
  playerDied: { playerId: number; cause: string } | null;
  showInventory: boolean;
  shipHoldData: ShipHoldData | null;
  showMap: boolean;
  showBuildMenu: boolean;
  showCraftMenu: boolean;
  showFishingMinigame: boolean;
  showTradeMenu: boolean;
  showSettings: boolean;
  showCharacterCustomization: boolean;
  showCredits: boolean;
  equipment: Record<string, string | null>;
  suppressPauseMenu: boolean;
  /** True when the user clicked "Resume" and we're waiting for pointer lock
   *  to be acquired before closing the pause menu. Prevents the click-to-resume
   *  overlay from appearing when lockPointer() fails during the browser's ESC
   *  cooldown (~1.5s). The pointerlockchange handler clears this and closes
   *  the menu when lock is acquired. */
  pendingResume: boolean;
  reticleSize: number;
  builderCellType: number;
  builderRotation: number;
  showBuilderWheel: boolean;
  bookmarks: Bookmark[];
  waypoint: { x: number; z: number } | null;
  simBridge: SimBridge | null;
  currentSimSpeed: number;
  /** HUD state derived from the sim buffer by the main thread. Synced to the
   *  worker via the store bridge so the HUD can render without direct sim access. */
  hudState: HudState;

  setWeather: (w: any) => void;
  setPlayerDied: (d: any) => void;
  toggleInventory: () => void;
  toggleMap: () => void;
  toggleBuildMenu: () => void;
  toggleCraftMenu: () => void;
  toggleFishingMinigame: () => void;
  toggleTradeMenu: () => void;
  toggleSettings: () => void;
  togglePauseMenu: () => void;
  /** Resume from the pause menu — calls lockPointer() and waits for pointer
   *  lock to be confirmed before closing the menu. Unlike togglePauseMenu(),
   *  this does NOT close the menu immediately if pointer lock can't be
   *  acquired (e.g. during the browser's ESC cooldown). */
  resumeFromPause: () => void;
  toggleCharacterCustomization: () => void;
  toggleCredits: () => void;
  equipItem: (slot: string, itemId: string | null) => void;
  setSuppressPauseMenu: (v: boolean) => void;
  setReticleSize: (v: number) => void;
  setBuilderCellType: (idx: number) => void;
  setBuilderRotation: (r: number) => void;
  setShowBuilderWheel: (v: boolean) => void;
  addBookmark: (x: number, z: number, label: string) => void;
  removeBookmark: (id: number) => void;
  setWaypoint: (wp: { x: number; z: number } | null) => void;
  setShipHoldData: (data: ShipHoldData | null) => void;
  setSimBridge: (b: SimBridge) => void;
  setCurrentSimSpeed: (v: number) => void;
  setHudState: (s: Partial<HudState>) => void;
}

/** HUD values read from the sim buffer by the main thread and synced to the
 *  worker. The HUD component reads these from the store instead of polling
 *  the sim buffer directly (which is only available on the main thread). */
export interface HudState {
  health: number;
  maxHealth: number;
  hunger: number;
  thirst: number;
  oxygen: number;
  maxOxygen: number;
  temperature: number;
  timeOfDay: number;
  weatherType: number;
  biome: number;
  security: number;
  cameraMode: number;
  isFishing: boolean;
  fishingTension: number;
  fishingProgress: number;
  activeSlot: number;
  isPiloting: boolean;
  isOnboard: boolean;
  gold: number;
  playerX: number;
  playerZ: number;
  heading: number;
}

export const DEFAULT_HUD_STATE: HudState = {
  health: 100, maxHealth: 100,
  hunger: 100, thirst: 100,
  oxygen: 100, maxOxygen: 100,
  temperature: 50,
  timeOfDay: 0.3,
  weatherType: 0,
  biome: 7,
  security: 0,
  cameraMode: 2,
  isFishing: false,
  fishingTension: 50,
  fishingProgress: 0,
  activeSlot: 0,
  isPiloting: false,
  isOnboard: false,
  gold: 0,
  playerX: 0,
  playerZ: 0,
  heading: 0,
};

let bookmarkId = 0;

/**
 * Safety net: after closing a menu and calling lockPointer(), the browser may
 * reject the pointer lock request (e.g. if it's within the cooldown period
 * after a recent unlock, ~1.5s in Chromium). If lockPointer() fails, the
 * pointerlockchange event never fires with locked=true, so suppressPauseMenu
 * would never be reset — permanently blocking the pause menu from opening on
 * subsequent ESC presses. This timeout checks after 200ms whether pointer lock
 * was actually acquired; if not, it resets suppressPauseMenu so the user can
 * still open the pause menu via ESC or the click-to-resume overlay.
 */
function scheduleSuppressReset(get: () => GameStoreState): void {
  setTimeout(() => {
    if (!document.pointerLockElement && get().suppressPauseMenu) {
      get().setSuppressPauseMenu(false);
    }
  }, 200);
}

export const useGameStore = create<GameStoreState>((set, get) => ({
  ...createBaseGameStoreState<WebGPURenderer>(set as any, get as any),

  weather: null,
  playerDied: null,
  showInventory: false,
  shipHoldData: null,
  showMap: false,
  showBuildMenu: false,
  showCraftMenu: false,
  showFishingMinigame: false,
  showTradeMenu: false,
  showSettings: false,
  showCharacterCustomization: false,
  showCredits: false,
  equipment: { rod: null, weapon: null, armor: null, accessory: null },
  suppressPauseMenu: false,
  pendingResume: false,
  reticleSize: 16,
  builderCellType: 0,
  builderRotation: 0,
  showBuilderWheel: false,
  bookmarks: [],
  waypoint: null,
  simBridge: null,
  currentSimSpeed: 1.0,
  hudState: { ...DEFAULT_HUD_STATE },

  setWeather: (w) => set({ weather: w }),
  setPlayerDied: (d) => set({ playerDied: d }),
  toggleInventory: () => {
    if (get().showInventory) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      scheduleSuppressReset(get);
    } else {
      document.exitPointerLock?.();
    }
    set((s) => ({ showInventory: !s.showInventory }));
  },
  toggleMap: () => {
    if (get().showMap) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      scheduleSuppressReset(get);
    } else {
      document.exitPointerLock?.();
    }
    set((s) => ({ showMap: !s.showMap }));
  },
  toggleBuildMenu: () => {
    if (get().showBuildMenu) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      scheduleSuppressReset(get);
    } else {
      document.exitPointerLock?.();
    }
    set((s) => ({ showBuildMenu: !s.showBuildMenu }));
  },
  toggleCraftMenu: () => {
    if (get().showCraftMenu) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      scheduleSuppressReset(get);
    } else {
      document.exitPointerLock?.();
    }
    set((s) => ({ showCraftMenu: !s.showCraftMenu }));
  },
  toggleFishingMinigame: () => {
    if (get().showFishingMinigame) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      scheduleSuppressReset(get);
    } else {
      document.exitPointerLock?.();
    }
    set((s) => ({ showFishingMinigame: !s.showFishingMinigame }));
  },
  toggleTradeMenu: () => {
    if (get().showTradeMenu) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      scheduleSuppressReset(get);
    } else {
      document.exitPointerLock?.();
    }
    set((s) => ({ showTradeMenu: !s.showTradeMenu }));
  },
  toggleSettings: () => {
    if (get().showSettings) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      scheduleSuppressReset(get);
    } else {
      document.exitPointerLock?.();
    }
    set((s) => ({ showSettings: !s.showSettings }));
  },
  togglePauseMenu: () => {
    const wasOpen = get().showPauseMenu;
    if (wasOpen) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true, pendingResume: false });
      scheduleSuppressReset(get);
      get().simBridge?.resumeGame();
    } else {
      document.exitPointerLock?.();
      get().simBridge?.pauseGame();
    }
    set((s) => ({ showPauseMenu: !s.showPauseMenu }));
  },
  resumeFromPause: () => {
    // Called by the pause menu's "Resume" button. Unlike togglePauseMenu(),
    // this does NOT close the menu immediately if pointer lock can't be
    // acquired (e.g. during the browser's ESC cooldown). Instead it keeps
    // the menu open and sets pendingResume=true; the pointerlockchange
    // handler in app.tsx closes the menu when lock is confirmed.
    if (!get().showPauseMenu) return;
    get().renderer?.lockPointer();
    get().simBridge?.resumeGame();
    if (document.pointerLockElement) {
      // Already locked — close immediately.
      set({ showPauseMenu: false, suppressPauseMenu: true, pendingResume: false });
      scheduleSuppressReset(get);
    } else {
      // Not locked yet — wait for pointerlockchange to close the menu.
      set({ suppressPauseMenu: true, pendingResume: true });
      scheduleSuppressReset(get);
    }
  },
  toggleCharacterCustomization: () => {
    if (get().showCharacterCustomization) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      scheduleSuppressReset(get);
    } else {
      document.exitPointerLock?.();
    }
    set((s) => ({ showCharacterCustomization: !s.showCharacterCustomization }));
  },
  toggleCredits: () => {
    if (get().showCredits) {
      get().renderer?.lockPointer();
      set({ suppressPauseMenu: true });
      scheduleSuppressReset(get);
    } else {
      document.exitPointerLock?.();
    }
    set((s) => ({ showCredits: !s.showCredits }));
  },
  equipItem: (slot, itemId) =>
    set((s) => ({ equipment: { ...s.equipment, [slot]: itemId } })),
  setSuppressPauseMenu: (v) => set({ suppressPauseMenu: v }),
  setReticleSize: (v) => set({ reticleSize: v }),
  setBuilderCellType: (idx) => set({ builderCellType: idx }),
  setBuilderRotation: (r) => set({ builderRotation: ((r % 4) + 4) % 4 }),
  setShowBuilderWheel: (v) => set({ showBuilderWheel: v }),
  addBookmark: (x, z, label) =>
    set((s) => ({ bookmarks: [...s.bookmarks, { id: ++bookmarkId, x, z, label }] })),
  removeBookmark: (id) =>
    set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) })),
  setWaypoint: (wp) => set({ waypoint: wp }),
  setShipHoldData: (data) => set({ shipHoldData: data }),
  setSimBridge: (b) => set({ simBridge: b }),
  setCurrentSimSpeed: (v) => set({ currentSimSpeed: v }),
  setHudState: (s) => set((state) => ({ hudState: { ...state.hudState, ...s } })),
}));

// Expose on window for MCP automation tools (avoids circular import in setup.ts)
if (typeof window !== "undefined") {
  (window as any).__gameStore = useGameStore;
}
