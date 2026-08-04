import { create } from "zustand";

export interface ReloadEntry {
  file: string;
  elapsed: number;
  timestamp: number;
  success: boolean;
}

interface HotReloadState {
  enabled: boolean;
  preserveState: boolean;
  status: "ready" | "reloading" | "error";
  errorMessage: string | null;
  lastReload: { file: string; elapsed: number; timestamp: number } | null;
  reloadHistory: ReloadEntry[];

  setEnabled: (v: boolean) => void;
  setPreserveState: (v: boolean) => void;
  setStatus: (s: "ready" | "reloading" | "error", msg?: string) => void;
  setLastReload: (r: { file: string; elapsed: number; timestamp: number }) => void;
}

export const useHotReloadStore = create<HotReloadState>((set) => ({
  enabled: true,
  preserveState: true,
  status: "ready",
  errorMessage: null,
  lastReload: null,
  reloadHistory: [],

  setEnabled: (v) => set({ enabled: v }),
  setPreserveState: (v) => set({ preserveState: v }),
  setStatus: (s, msg) =>
    set({ status: s, errorMessage: msg ?? null }),
  setLastReload: (r) =>
    set((state) => ({
      lastReload: r,
      reloadHistory: [
        { ...r, success: state.status !== "error" },
        ...state.reloadHistory,
      ].slice(0, 5),
    })),
}));
