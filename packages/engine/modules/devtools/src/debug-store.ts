import type { GCControllerConfig, GCControllerStats, GCStats } from "@downdraft/engine";
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

  gcControllerStats: Record<string, GCControllerStats>;
  updateGCControllerStats: (label: string, stats: GCControllerStats) => void;
  gcConfig: GCControllerConfig | null;
  setGCConfig: (config: Partial<GCControllerConfig>) => void;

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
    extra: Record<string, any>;
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

  gcControllerStats: {},
  updateGCControllerStats: (label, stats) =>
    set((s) => ({ gcControllerStats: { ...s.gcControllerStats, [label]: stats } })),
  gcConfig: null,
  setGCConfig: (config) =>
    set((s) => ({ gcConfig: s.gcConfig ? { ...s.gcConfig, ...config } : { ...config } as GCControllerConfig })),

  collisionLog: [],
  setCollisionLog: (log) => set({ collisionLog: log }),

  rendererStats: null,
  setRendererStats: (stats) => set({ rendererStats: stats }),
  })),
);
