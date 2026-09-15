import { createBaseGameStoreState, type BaseGameStoreState } from "@downdraft/core";
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

export interface GameState extends Omit<BaseGameStoreState<FallingSandRenderer>, "fps"> {
  fps: number | null;
  selectedMaterial: number;
  fpsHistory: number[];
  settings: GameSettings;
  brushMode: BrushMode;
  fieldType: FieldType;
  // Field paint values: 0-255 for gravity/temp (128=default), -128 to 127 for wind
  fieldGravity: number;   // 0-255, 128 = 1×
  fieldTemperature: number; // 0-255, 128 = normal
  fieldWindX: number;     // -128 to 127
  fieldWindY: number;     // -128 to 127
  showFieldOverlay: boolean;
  saves: SaveMetadata[];
  /** Live cell inspector data under the cursor */
  inspector: CellInspector;
  /** Brush radius in grid cells */
  brushRadius: number;

  setFPS: (fps: number) => void;
  setSelectedMaterial: (m: number) => void;
  setSettings: (s: Partial<GameSettings>) => void;
  setBrushMode: (m: BrushMode) => void;
  setFieldType: (f: FieldType) => void;
  setFieldGravity: (v: number) => void;
  setFieldTemperature: (v: number) => void;
  setFieldWindX: (v: number) => void;
  setFieldWindY: (v: number) => void;
  setShowFieldOverlay: (show: boolean) => void;
  setRenderer: (r: FallingSandRenderer | null) => void;
  setSaves: (saves: SaveMetadata[]) => void;
  setInspector: (inspector: CellInspector) => void;
  setBrushRadius: (r: number) => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  ...createBaseGameStoreState<FallingSandRenderer>(set, get),

  fps: null,
  selectedMaterial: 1,
  fpsHistory: [],
  settings: { ...DEFAULT_SETTINGS },
  brushMode: "material",
  fieldType: "gravity",
  fieldGravity: 128,
  fieldTemperature: 128,
  fieldWindX: 0,
  fieldWindY: 0,
  showFieldOverlay: false,
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
  setSelectedMaterial: (selectedMaterial) => set({ selectedMaterial }),
  setSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
  setBrushMode: (brushMode) => set({ brushMode }),
  setFieldType: (fieldType) => set({ fieldType }),
  setFieldGravity: (fieldGravity) => set({ fieldGravity }),
  setFieldTemperature: (fieldTemperature) => set({ fieldTemperature }),
  setFieldWindX: (fieldWindX) => set({ fieldWindX }),
  setFieldWindY: (fieldWindY) => set({ fieldWindY }),
  setShowFieldOverlay: (showFieldOverlay) => set({ showFieldOverlay }),
  setRenderer: (renderer) => set({ renderer }),
  setSaves: (saves) => set({ saves }),
  setInspector: (inspector) => set({ inspector }),
  setBrushRadius: (brushRadius) => set({ brushRadius }),
}));
