// ============================================================================
// Game Store — zustand store for sandbox UI state
// ============================================================================

import { createBaseGameStoreState, type BaseGameStoreState } from "@downdraft/core";
import { CameraMode, FunMode, ToolType } from "@sandbox/shared/types";
import { create } from "zustand";

interface GameStoreState extends BaseGameStoreState<unknown> {
  activeTool: ToolType;
  activeFunMode: FunMode;
  cameraMode: CameraMode;
  showContentBrowser: boolean;
  showToolWheel: boolean;
  showPaintPalette: boolean;
  paintColor: string;
  paintSize: number;
  paintHardness: number;
  propCount: number;

  // Player health (sim is authoritative; mirrored here for the HUD)
  playerHealth: number;
  playerMaxHealth: number;
  playerDead: boolean;

  // ESC menu
  showEscMenu: boolean;
  escMenuTab: "main" | "graphics" | "content" | "controls" | "mods" | "character";

  // Graphics settings state
  showGraphicsPanel: boolean;
  bloomEnabled: boolean;
  bloomStrength: number;
  bloomThreshold: number;
  fxaaEnabled: boolean;
  tonemapEnabled: boolean;
  exposure: number;
  vignetteEnabled: boolean;
  vignetteStrength: number;
  shadowsEnabled: boolean;
  mipmapsEnabled: boolean;
  pointLightsEnabled: boolean;
  sunColorR: number;
  sunColorG: number;
  sunColorB: number;
  ambientIntensity: number;

  setActiveTool: (tool: ToolType) => void;
  setActiveFunMode: (mode: FunMode) => void;
  setCameraMode: (mode: CameraMode) => void;
  toggleContentBrowser: () => void;
  toggleToolWheel: () => void;
  togglePaintPalette: () => void;
  setPaintColor: (c: string) => void;
  setPaintSize: (s: number) => void;
  setPaintHardness: (h: number) => void;
  setPropCount: (count: number) => void;
  setPlayerHealth: (hp: number, maxHp: number) => void;
  setPlayerDead: (v: boolean) => void;

  // ESC menu setters
  setShowEscMenu: (v: boolean) => void;
  setEscMenuTab: (tab: "main" | "graphics" | "content" | "controls" | "mods" | "character") => void;
  toggleEscMenu: () => void;

  // Graphics settings setters
  toggleGraphicsPanel: () => void;
  setBloomEnabled: (v: boolean) => void;
  setBloomStrength: (v: number) => void;
  setBloomThreshold: (v: number) => void;
  setFXAAEnabled: (v: boolean) => void;
  setTonemapEnabled: (v: boolean) => void;
  setExposure: (v: number) => void;
  setVignetteEnabled: (v: boolean) => void;
  setVignetteStrength: (v: number) => void;
  setShadowsEnabled: (v: boolean) => void;
  setMipmapsEnabled: (v: boolean) => void;
  setPointLightsEnabled: (v: boolean) => void;
  setSunColor: (r: number, g: number, b: number) => void;
  setAmbientIntensity: (v: number) => void;
}

export const useGameStore = create<GameStoreState>((set, get) => ({
  ...createBaseGameStoreState<unknown>(set, get),
  activeTool: ToolType.Physgun,
  activeFunMode: FunMode.Normal,
  cameraMode: CameraMode.FirstPerson,
  showContentBrowser: false,
  showToolWheel: false,
  showPaintPalette: false,
  paintColor: "#ff0000",
  paintSize: 20,
  paintHardness: 0.8,
  propCount: 0,
  playerHealth: 100,
  playerMaxHealth: 100,
  playerDead: false,

  // ESC menu
  showEscMenu: false,
  escMenuTab: "main",

  // Graphics settings defaults (match the renderer's defaults)
  showGraphicsPanel: false,
  bloomEnabled: true,
  bloomStrength: 0.6,
  bloomThreshold: 0.85,
  fxaaEnabled: true,
  tonemapEnabled: true,
  exposure: 1.1,
  vignetteEnabled: true,
  vignetteStrength: 0.25,
  shadowsEnabled: true,
  mipmapsEnabled: true,
  pointLightsEnabled: true,
  sunColorR: 1.0,
  sunColorG: 0.95,
  sunColorB: 0.85,
  ambientIntensity: 0.4,

  setActiveTool: (tool) => set({ activeTool: tool, showPaintPalette: tool === ToolType.Paintgun, showToolWheel: false }),
  setActiveFunMode: (mode) => set({ activeFunMode: mode }),
  setCameraMode: (mode) => set({ cameraMode: mode }),
  toggleContentBrowser: () => set((s) => ({ showContentBrowser: !s.showContentBrowser })),
  toggleToolWheel: () => set((s) => ({ showToolWheel: !s.showToolWheel })),
  togglePaintPalette: () => set((s) => ({ showPaintPalette: !s.showPaintPalette })),
  setPaintColor: (c) => set({ paintColor: c }),
  setPaintSize: (s) => set({ paintSize: s }),
  setPaintHardness: (h) => set({ paintHardness: h }),
  setPropCount: (count) => set({ propCount: count }),
  setPlayerHealth: (hp, maxHp) => set({ playerHealth: hp, playerMaxHealth: maxHp }),
  setPlayerDead: (v) => set({ playerDead: v }),

  // ESC menu setters
  setShowEscMenu: (v) => set({ showEscMenu: v }),
  setEscMenuTab: (tab) => set({ escMenuTab: tab }),
  toggleEscMenu: () => set((s) => ({ showEscMenu: !s.showEscMenu })),

  // Graphics settings setters
  toggleGraphicsPanel: () => set((s) => ({ showGraphicsPanel: !s.showGraphicsPanel })),
  setBloomEnabled: (v) => set({ bloomEnabled: v }),
  setBloomStrength: (v) => set({ bloomStrength: v }),
  setBloomThreshold: (v) => set({ bloomThreshold: v }),
  setFXAAEnabled: (v) => set({ fxaaEnabled: v }),
  setTonemapEnabled: (v) => set({ tonemapEnabled: v }),
  setExposure: (v) => set({ exposure: v }),
  setVignetteEnabled: (v) => set({ vignetteEnabled: v }),
  setVignetteStrength: (v) => set({ vignetteStrength: v }),
  setShadowsEnabled: (v) => set({ shadowsEnabled: v }),
  setMipmapsEnabled: (v) => set({ mipmapsEnabled: v }),
  setPointLightsEnabled: (v) => set({ pointLightsEnabled: v }),
  setSunColor: (r, g, b) => set({ sunColorR: r, sunColorG: g, sunColorB: b }),
  setAmbientIntensity: (v) => set({ ambientIntensity: v }),
}));
