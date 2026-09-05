// ============================================================================
// Game Store — zustand store for sandbox UI state
// ============================================================================

import { create } from "zustand";
import { FunMode, ToolType } from "@sandbox/shared/types";

interface GameStoreState {
  simReady: boolean;
  rendererReady: boolean;
  isDev: boolean;
  activeTool: ToolType;
  activeFunMode: FunMode;
  showContentBrowser: boolean;
  showToolWheel: boolean;
  showPaintPalette: boolean;
  paintColor: string;
  paintSize: number;
  paintHardness: number;
  fps: number;
  propCount: number;

  setSimReady: (v: boolean) => void;
  setRendererReady: (v: boolean) => void;
  setIsDev: (v: boolean) => void;
  setActiveTool: (tool: ToolType) => void;
  setActiveFunMode: (mode: FunMode) => void;
  toggleContentBrowser: () => void;
  toggleToolWheel: () => void;
  togglePaintPalette: () => void;
  setPaintColor: (c: string) => void;
  setPaintSize: (s: number) => void;
  setPaintHardness: (h: number) => void;
  setFps: (fps: number) => void;
  setPropCount: (count: number) => void;
}

export const useGameStore = create<GameStoreState>((set) => ({
  simReady: false,
  rendererReady: false,
  isDev: false,
  activeTool: ToolType.Physgun,
  activeFunMode: FunMode.Normal,
  showContentBrowser: true,
  showToolWheel: false,
  showPaintPalette: false,
  paintColor: "#ff0000",
  paintSize: 20,
  paintHardness: 0.8,
  fps: 0,
  propCount: 0,

  setSimReady: (v) => set({ simReady: v }),
  setRendererReady: (v) => set({ rendererReady: v }),
  setIsDev: (v) => set({ isDev: v }),
  setActiveTool: (tool) => set({ activeTool: tool, showPaintPalette: tool === ToolType.Paintgun, showToolWheel: false }),
  setActiveFunMode: (mode) => set({ activeFunMode: mode }),
  toggleContentBrowser: () => set((s) => ({ showContentBrowser: !s.showContentBrowser })),
  toggleToolWheel: () => set((s) => ({ showToolWheel: !s.showToolWheel })),
  togglePaintPalette: () => set((s) => ({ showPaintPalette: !s.showPaintPalette })),
  setPaintColor: (c) => set({ paintColor: c }),
  setPaintSize: (s) => set({ paintSize: s }),
  setPaintHardness: (h) => set({ paintHardness: h }),
  setFps: (fps) => set({ fps }),
  setPropCount: (count) => set({ propCount: count }),
}));
