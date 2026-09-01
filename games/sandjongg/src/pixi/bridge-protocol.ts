// ============================================================================
// bridge-protocol — typed events + actions for the sandjongg PixiUI.
//
// The pixi-ui worker cannot read the main-thread zustand store directly.
// State flows through three channels:
//   1. UiStatsSAB — per-frame scalars (see STATS_LAYOUT below)
//   2. postEvent  — structured data (debug tile, toast, save availability)
//   3. onAction   — worker→main side-effect requests (buttons, menu nav)
// ============================================================================

import type { PixiUiAction, PixiUiEvent, UiStatsLayout } from "@downdraft/library-pixi-ui";
import type { TilesetId, TileTheme } from "../shared/tilesets";
import type { DebugTileInfo, GameMode } from "../shared/types";

// ── Per-frame scalar slots (UiStatsSAB) ──
// Booleans encoded as 0/1; enums as their numeric index.
export const SANDJONGG_STATS_LAYOUT: UiStatsLayout = {
  slots: [
    "fps",
    "score",
    "combo",
    "level",
    "tilesLeft",
    "highScore",
    "paused",            // 0/1
    "mode",              // 0=sandjongg, 1=mahjongg
    "sandEnabled",       // 0/1
    "showMainMenu",      // 0/1
    "showPauseMenu",     // 0/1
    "showHelp",          // 0/1
    "showSettings",      // 0/1
    "debugMode",         // 0/1
    "noAdjacentSame",    // 0/1
    "tileset",           // 0=elements, 1=riichi
    "tileTheme",         // 0=light, 1=dark
    "customCols",
    "customRows",
    "lastMatchTime",     // performance.now() ms for combo countdown
    // Canvas dimensions (for layout)
    "canvasW",
    "canvasH",
  ],
};

// ── Main→worker events (structured data) ──

export interface SetDebugTileEvent extends PixiUiEvent {
  kind: "setDebugTile";
  tile: DebugTileInfo | null;
}

export interface ShowToastEvent extends PixiUiEvent {
  kind: "showToast";
  message: string;
  id: number;
}

export interface SetHasSaveEvent extends PixiUiEvent {
  kind: "setHasSave";
  hasSave: Record<GameMode, boolean>;
}

export type SandjonggEvent =
  | SetDebugTileEvent
  | ShowToastEvent
  | SetHasSaveEvent;

// ── Worker→main actions (side-effect requests) ──

export interface StartNewGameAction extends PixiUiAction {
  kind: "startNewGame";
  mode: GameMode;
}

export interface ContinueModeAction extends PixiUiAction {
  kind: "continueMode";
  mode: GameMode;
}

export interface OpenPauseMenuAction extends PixiUiAction {
  kind: "openPauseMenu";
}

export interface ClosePauseMenuAction extends PixiUiAction {
  kind: "closePauseMenu";
}

export interface RestartLevelAction extends PixiUiAction {
  kind: "restartLevel";
}

export interface ClearPitAction extends PixiUiAction {
  kind: "clearPit";
}

export interface ToggleNoAdjacentAction extends PixiUiAction {
  kind: "toggleNoAdjacent";
}

export interface ToggleSandAction extends PixiUiAction {
  kind: "toggleSand";
}

export interface OpenSettingsAction extends PixiUiAction {
  kind: "openSettings";
}

export interface OpenHelpAction extends PixiUiAction {
  kind: "openHelp";
}

export interface ReturnToMainMenuAction extends PixiUiAction {
  kind: "returnToMainMenu";
}

export interface RequestHintAction extends PixiUiAction {
  kind: "requestHint";
}

export interface RequestShuffleAction extends PixiUiAction {
  kind: "requestShuffle";
}

export interface ToggleDebugModeAction extends PixiUiAction {
  kind: "toggleDebugMode";
}

export interface SetTilesetAction extends PixiUiAction {
  kind: "setTileset";
  tileset: TilesetId;
}

export interface SetTileThemeAction extends PixiUiAction {
  kind: "setTileTheme";
  theme: TileTheme;
}

export interface SetCustomDimsAction extends PixiUiAction {
  kind: "setCustomDims";
  cols: number;
  rows: number;
}

export interface ClosePanelAction extends PixiUiAction {
  kind: "closePanel";
  panel: "help" | "settings";
}

export interface SetFontScaleAction extends PixiUiAction {
  kind: "setFontScale";
  scale: number;
}

export type SandjonggAction =
  | StartNewGameAction
  | ContinueModeAction
  | OpenPauseMenuAction
  | ClosePauseMenuAction
  | RestartLevelAction
  | ClearPitAction
  | ToggleNoAdjacentAction
  | ToggleSandAction
  | OpenSettingsAction
  | OpenHelpAction
  | ReturnToMainMenuAction
  | RequestHintAction
  | RequestShuffleAction
  | ToggleDebugModeAction
  | SetTilesetAction
  | SetTileThemeAction
  | SetCustomDimsAction
  | ClosePanelAction
  | SetFontScaleAction;
