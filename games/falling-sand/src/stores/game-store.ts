import { create } from "zustand";
import type { FallingSandRenderer } from "../renderer/falling-sand-renderer";
import type { SaveMetadata } from "./save-system";

export type BrushMode = "material" | "field";
export type FieldType = "gravity" | "temperature" | "windX" | "windY";

export interface GameSettings {
  horizontalImpulseChance: number;
  horizontalImpulseStrength: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  horizontalImpulseChance: 0.02,
  horizontalImpulseStrength: 1,
};

/** Live cell inspector data — updated each frame from the renderer. */
export interface CellInspector {
  /** Grid coordinates under cursor (-1 = off-grid) */
  gx: number;
  gy: number;
  /** Active layer being inspected */
  layer: number;
  /** Material ID (0-53) */
  mat: number;
  /** Material name (looked up by renderer) */
  matName: string;
  /** Cell lifetime (0-255) */
  lifetime: number;
  /** Shade index (0-3) */
  shade: number;
  /** Raw gravity byte (0-255, 128 = 1.0×) */
  gravity: number;
  /** Gravity multiplier (gravity / 128) */
  gravityMult: number;
  /** Raw temperature byte (0-255, 128 = 1.0) */
  temperature: number;
  /** Temperature multiplier (temperature / 128) */
  temperatureMult: number;
  /** Raw wind X (i8, -128 to 127) */
  windX: number;
  /** Raw wind Y (i8, -128 to 127) */
  windY: number;
  /** Wind magnitude (sqrt(wx² + wy²)) */
  windMag: number;
  /** Wind direction in degrees (0 = right, 90 = down) */
  windDir: number;
  /** Whether the cursor is over the grid */
  valid: boolean;
}

export interface GameState {
  fps: number | null;
  health: number;
  selectedMaterial: number;
  paused: boolean;
  fpsHistory: number[];
  settings: GameSettings;
  showSettings: boolean;
  brushMode: BrushMode;
  fieldType: FieldType;
  // Field paint values: 0-255 for gravity/temp (128=default), -128 to 127 for wind
  fieldGravity: number;   // 0-255, 128 = 1×
  fieldTemperature: number; // 0-255, 128 = normal
  fieldWindX: number;     // -128 to 127
  fieldWindY: number;     // -128 to 127
  showFieldOverlay: boolean;
  activeLayer: number;    // 0 = back, 1 = front
  renderer: FallingSandRenderer | null;
  saves: SaveMetadata[];
  showSaves: boolean;
  /** Live cell inspector data under the cursor */
  inspector: CellInspector;
  /** Brush radius in grid cells */
  brushRadius: number;

  setFPS: (fps: number) => void;
  setHealth: (health: number) => void;
  setSelectedMaterial: (m: number) => void;
  setPaused: (p: boolean) => void;
  setSettings: (s: Partial<GameSettings>) => void;
  setShowSettings: (show: boolean) => void;
  setBrushMode: (m: BrushMode) => void;
  setFieldType: (f: FieldType) => void;
  setFieldGravity: (v: number) => void;
  setFieldTemperature: (v: number) => void;
  setFieldWindX: (v: number) => void;
  setFieldWindY: (v: number) => void;
  setShowFieldOverlay: (show: boolean) => void;
  setActiveLayer: (layer: number) => void;
  setRenderer: (r: FallingSandRenderer | null) => void;
  setSaves: (saves: SaveMetadata[]) => void;
  setShowSaves: (show: boolean) => void;
  setInspector: (inspector: CellInspector) => void;
  setBrushRadius: (r: number) => void;
}

export const useGameStore = create<GameState>((set) => ({
  fps: null,
  health: 100,
  selectedMaterial: 1,
  paused: false,
  fpsHistory: [],
  settings: { ...DEFAULT_SETTINGS },
  showSettings: false,
  brushMode: "material",
  fieldType: "gravity",
  fieldGravity: 128,
  fieldTemperature: 128,
  fieldWindX: 0,
  fieldWindY: 0,
  showFieldOverlay: false,
  activeLayer: 0,
  renderer: null,
  saves: [],
  showSaves: false,
  inspector: {
    gx: -1, gy: -1, layer: 0,
    mat: 0, matName: "Empty", lifetime: 0, shade: 0,
    gravity: 128, gravityMult: 1.0,
    temperature: 128, temperatureMult: 1.0,
    windX: 0, windY: 0, windMag: 0, windDir: 0,
    valid: false,
  },
  brushRadius: 3,

  setFPS: (fps) => set((s) => {
    const history = [...s.fpsHistory, fps].slice(-30);
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    return { fps: Math.round(avg), fpsHistory: history };
  }),
  setHealth: (health) => set({ health }),
  setSelectedMaterial: (selectedMaterial) => set({ selectedMaterial }),
  setPaused: (paused) => set({ paused }),
  setSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
  setShowSettings: (showSettings) => set({ showSettings }),
  setBrushMode: (brushMode) => set({ brushMode }),
  setFieldType: (fieldType) => set({ fieldType }),
  setFieldGravity: (fieldGravity) => set({ fieldGravity }),
  setFieldTemperature: (fieldTemperature) => set({ fieldTemperature }),
  setFieldWindX: (fieldWindX) => set({ fieldWindX }),
  setFieldWindY: (fieldWindY) => set({ fieldWindY }),
  setShowFieldOverlay: (showFieldOverlay) => set({ showFieldOverlay }),
  setActiveLayer: (activeLayer) => set({ activeLayer }),
  setRenderer: (renderer) => set({ renderer }),
  setSaves: (saves) => set({ saves }),
  setShowSaves: (showSaves) => set({ showSaves }),
  setInspector: (inspector) => set({ inspector }),
  setBrushRadius: (brushRadius) => set({ brushRadius }),
}));
