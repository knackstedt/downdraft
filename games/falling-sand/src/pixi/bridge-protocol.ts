// ============================================================================
// bridge-protocol — typed events + actions for the falling-sand PixiUI.
//
// The pixi-ui worker cannot read the main-thread zustand store directly.
// State flows through three channels:
//   1. UiStatsSAB — per-frame scalars (see STATS_LAYOUT below)
//   2. postEvent  — structured data (saves list)
//   3. onAction   — worker→main side-effect requests (buttons, sliders)
// ============================================================================

import type { PixiUiEvent, PixiUiAction, UiStatsLayout } from "@downdraft/library-pixi-ui";
import type { SaveMetadata } from "../stores/save-system";

// ── Per-frame scalar slots (UiStatsSAB) ──
// Booleans encoded as 0/1; enums as their numeric index.
export const FALLING_SAND_STATS_LAYOUT: UiStatsLayout = {
  slots: [
    "fps",
    "health",
    "paused",          // 0/1
    "selectedMaterial",
    "brushMode",       // 0=material, 1=field
    "fieldType",       // 0=gravity, 1=temperature, 2=windX, 3=windY
    "fieldGravity",
    "fieldTemperature",
    "fieldWindX",
    "fieldWindY",
    "showFieldOverlay", // 0/1
    "brushRadius",
    "showSettings",    // 0/1
    "showSaves",       // 0/1
    "impulseChance",
    "impulseStrength",
    // Cell inspector (updated ~15fps by renderer)
    "inspectorValid",  // 0/1
    "inspectorGx",
    "inspectorGy",
    "inspectorMat",
    "inspectorLifetime",
    "inspectorShade",
    "inspectorGravity",
    "inspectorTemperature",
    "inspectorWindX",
    "inspectorWindY",
    // Mouse position (for brush circle — written by host on pointermove)
    "mouseX",
    "mouseY",
    // Brush circle visibility (0 when mouse is off-canvas)
    "mouseValid",      // 0/1
    // Grid dimensions (for brush circle sizing)
    "gridW",
    "gridH",
    "canvasW",
    "canvasH",
  ],
};

// ── Main→worker events (structured data) ──

export interface SetSavesEvent extends PixiUiEvent {
  kind: "setSaves";
  saves: SaveMetadata[];
}

export type FallingSandEvent = SetSavesEvent;

// ── Worker→main actions (side-effect requests) ──

export interface SelectMaterialAction extends PixiUiAction {
  kind: "selectMaterial";
  mat: number;
}

export interface SetBrushModeAction extends PixiUiAction {
  kind: "setBrushMode";
  mode: number; // 0=material, 1=field
}

export interface SetFieldTypeAction extends PixiUiAction {
  kind: "setFieldType";
  fieldType: number; // 0=gravity, 1=temperature, 2=windX, 3=windY
}

export interface SetFieldValueAction extends PixiUiAction {
  kind: "setFieldValue";
  field: "gravity" | "temperature" | "windX" | "windY";
  value: number;
}

export interface SetBrushRadiusAction extends PixiUiAction {
  kind: "setBrushRadius";
  radius: number;
}

export interface SetShowFieldOverlayAction extends PixiUiAction {
  kind: "setShowFieldOverlay";
  show: boolean;
}

export interface SetSettingsAction extends PixiUiAction {
  kind: "setSettings";
  impulseChance?: number;
  impulseStrength?: number;
}

export interface TogglePanelAction extends PixiUiAction {
  kind: "togglePanel";
  panel: "settings" | "saves";
}

export interface SaveAction extends PixiUiAction {
  kind: "save";
}

export interface LoadAction extends PixiUiAction {
  kind: "load";
  id: string;
}

export interface DeleteSaveAction extends PixiUiAction {
  kind: "deleteSave";
  id: string;
}

export interface ClearAction extends PixiUiAction {
  kind: "clear";
}

export type FallingSandAction =
  | SelectMaterialAction
  | SetBrushModeAction
  | SetFieldTypeAction
  | SetFieldValueAction
  | SetBrushRadiusAction
  | SetShowFieldOverlayAction
  | SetSettingsAction
  | TogglePanelAction
  | SaveAction
  | LoadAction
  | DeleteSaveAction
  | ClearAction;
