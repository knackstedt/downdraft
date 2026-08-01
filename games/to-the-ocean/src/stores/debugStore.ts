import type { GCStats } from "@downdraft/core";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export interface CollisionLogEntry {
  label: string;
  count: number;
  lastCollisionTime: number;
}

interface DebugState {
  showDebugPage: boolean;
  toggleDebugPage: () => void;
  setDebugPage: (show: boolean) => void;

  showHitboxes: boolean;
  toggleHitboxes: () => void;
  setShowHitboxes: (show: boolean) => void;
  hitboxLineWidth: number;
  setHitboxLineWidth: (width: number) => void;

  showLightGizmos: boolean;
  toggleLightGizmos: () => void;
  setShowLightGizmos: (show: boolean) => void;

  showRaycast: boolean;
  toggleRaycast: () => void;
  setShowRaycast: (show: boolean) => void;

  gcStats: Record<string, GCStats>;
  updateGCStats: (stats: GCStats) => void;

  collisionLog: CollisionLogEntry[];
  setCollisionLog: (log: CollisionLogEntry[]) => void;

  rendererStats: {
    fps: number;
    entityCount: number;
    playerCount: number;
    tick: number;
    canvasW: number;
    canvasH: number;
    viewportW: number;
    viewportH: number;
    waterValid: boolean;
    waterGrid: number;
    cameraPos: [number, number, number];
    cameraTarget: [number, number, number];
    playerPos: [number, number, number];
    heading: number;
    pitch: number;
    cameraMode: number;
    keys: string;
  } | null;
  setRendererStats: (stats: DebugState["rendererStats"]) => void;
}

export const useDebugStore = create<DebugState>()(
  subscribeWithSelector((set) => ({
  showDebugPage: false,
  toggleDebugPage: () => set((s) => ({ showDebugPage: !s.showDebugPage })),
  setDebugPage: (show) => set({ showDebugPage: show }),

  showHitboxes: false,
  toggleHitboxes: () => set((s) => ({ showHitboxes: !s.showHitboxes })),
  setShowHitboxes: (show) => set({ showHitboxes: show }),
  hitboxLineWidth: 3,
  setHitboxLineWidth: (width) => set({ hitboxLineWidth: Math.max(1, width) }),

  showLightGizmos: false,
  toggleLightGizmos: () => set((s) => ({ showLightGizmos: !s.showLightGizmos })),
  setShowLightGizmos: (show) => set({ showLightGizmos: show }),

  showRaycast: false,
  toggleRaycast: () => set((s) => ({ showRaycast: !s.showRaycast })),
  setShowRaycast: (show) => set({ showRaycast: show }),

  gcStats: {},
  updateGCStats: (stats) =>
    set((s) => ({ gcStats: { ...s.gcStats, [stats.label]: stats } })),

  collisionLog: [],
  setCollisionLog: (log) => set({ collisionLog: log }),

  rendererStats: null,
  setRendererStats: (stats) => set({ rendererStats: stats }),
  })),
);
