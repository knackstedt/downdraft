// ============================================================================
// bridge-protocol — typed postMessage messages between the main-thread
// PixiUiHost and the pixi-ui Web Worker.
//
// Main → worker: init (transfer OffscreenCanvas + SABs + config), event
//   (game-specific structured data), pointer (forwarded pointer events when
//   interactive), resize (canvas size change), queryScene (MCP scene-state
//   request), dispose.
// Worker → main: ready, setInteractive (toggle pointer-events), action
//   (worker requests a game action), sceneState (query response), error,
//   captureResult (overlay screenshot response).
// ============================================================================

import type { PixiUiLibConfig, UiStatsLayout } from "./library";

// --- Main → worker ---

export interface InitMessage {
  kind: "init";
  /** The OffscreenCanvas transferred via transferControlToOffscreen(). */
  offscreenCanvas: OffscreenCanvas;
  /** SharedArrayBuffer for high-frequency per-frame scalars. */
  uiStatsSab: SharedArrayBuffer;
  /** Library config (backend, stats layout, scene factory id, etc.). */
  config: SerializedPixiUiConfig;
  /** Initial canvas CSS width/height in pixels. */
  width: number;
  height: number;
}

export interface EventMessage {
  kind: "event";
  /** Game-specific event payload (inventory, menu toggle, notification, ...). */
  event: PixiUiEvent;
}

export interface PointerMessage {
  kind: "pointer";
  type: "pointerdown" | "pointermove" | "pointerup" | "pointerleave";
  x: number;
  y: number;
  button: number;
  /** Modifiers: shift, ctrl, alt, meta flags. */
  modifiers: number;
}

export interface ResizeMessage {
  kind: "resize";
  width: number;
  height: number;
}

export interface QuerySceneMessage {
  kind: "queryScene";
  /** Unique request id — echoed back in the SceneStateMessage response. */
  requestId: number;
}

export interface CaptureOverlayMessage {
  kind: "captureOverlay";
  /** Unique request id — echoed back in the CaptureResultMessage response. */
  requestId: number;
}

export interface DisposeMessage {
  kind: "dispose";
}

export type MainToWorkerMessage =
  | InitMessage
  | EventMessage
  | PointerMessage
  | ResizeMessage
  | QuerySceneMessage
  | CaptureOverlayMessage
  | DisposeMessage;

// --- Worker → main ---

export interface ReadyMessage {
  kind: "ready";
  /** The backend the worker actually selected (e.g. "webgl2" or "webgpu"). */
  backend: string;
}

export interface SetInteractiveMessage {
  kind: "setInteractive";
  /** When true, the host enables pointer-events on the overlay canvas. */
  interactive: boolean;
}

export interface ActionMessage {
  kind: "action";
  /** Game-specific action request (pause, resume, save, ...). */
  action: PixiUiAction;
}

export interface SceneStateMessage {
  kind: "sceneState";
  requestId: number;
  /** JSON-serializable scene-graph summary (named nodes, visibility, bounds). */
  state: SceneStateSummary;
}

export interface CaptureResultMessage {
  kind: "captureResult";
  requestId: number;
  /** PNG-encoded overlay frame as an ArrayBuffer, or null on failure. */
  png: ArrayBuffer | null;
  width: number;
  height: number;
}

export interface ErrorMessage {
  kind: "error";
  message: string;
  stack?: string;
}

export type WorkerToMainMessage =
  | ReadyMessage
  | SetInteractiveMessage
  | ActionMessage
  | SceneStateMessage
  | CaptureResultMessage
  | ErrorMessage;

// --- Shared types ---

/**
 * A game-specific event sent from the main thread to the worker via
 * postMessage. The `kind` string is how the worker's scene dispatches it.
 * Games define their own event kinds (e.g. "setInventory", "notification").
 */
export interface PixiUiEvent {
  kind: string;
  [key: string]: unknown;
}

/**
 * A game-specific action request from the worker back to the main thread.
 * The host forwards it to the game via `onAction`. Games define their own
 * action kinds (e.g. "pause", "resume", "save").
 */
export interface PixiUiAction {
  kind: string;
  [key: string]: unknown;
}

/**
 * A summary of the PixiJS scene graph, produced by the worker in response to
 * a `queryScene` request. Used by MCP automation tools to assert UI state.
 */
export interface SceneStateSummary {
  /** Named top-level containers/sprites in the scene. */
  nodes: SceneNodeSummary[];
  /** Whether the scene is currently in interactive mode. */
  interactive: boolean;
  /** The renderer backend in use. */
  backend: string;
}

export interface SceneNodeSummary {
  /** The `name` property of the PixiJS display object. */
  name: string;
  /** The constructor name (Container, Sprite, Text, Graphics, ...). */
  type: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** For Text nodes, the rendered string. */
  text?: string;
  /** Child nodes (one level deep — enough for HUD assertions). */
  children?: SceneNodeSummary[];
}

// --- Config serialization ---

/**
 * The config as sent to the worker (postMessage-serializable — no functions).
 * The scene factory is referenced by `sceneModuleUrl` + `sceneExportName`,
 * which the worker dynamically imports.
 */
export interface SerializedPixiUiConfig {
  backend: "webgl2" | "webgpu" | "auto";
  statsLayout: UiStatsLayout;
  /** URL of the game's scene module (imported dynamically inside the worker). */
  sceneModuleUrl?: string;
  /** Named export of the scene factory in the scene module. Default: "default". */
  sceneExportName?: string;
  /** Optional opaque config passed to the scene factory. */
  sceneConfig?: unknown;
  /** Whether to enable PixiJS debug logging in the worker. */
  debug?: boolean;
}

/** Serialize a PixiUiLibConfig for postMessage (strips the scene factory fn). */
export function serializeConfig(config: PixiUiLibConfig): SerializedPixiUiConfig {
  return {
    backend: config.backend ?? "webgl2",
    statsLayout: config.statsLayout ?? DEFAULT_STATS_LAYOUT,
    sceneModuleUrl: config.sceneModuleUrl,
    sceneExportName: config.sceneExportName,
    sceneConfig: config.sceneConfig,
    debug: config.debug ?? false,
  };
}

// --- Type guards ---

export function isInitMessage(msg: unknown): msg is InitMessage {
  return typeof msg === "object" && msg !== null && (msg as any).kind === "init";
}

// --- Default stats layout ---

/**
 * Default per-frame scalar slots in the UiStatsSAB. Games can override via
 * `PixiUiLibConfig.statsLayout`. Slot names map to float32 offsets in the
 * SAB (after the 16-byte header).
 */
export const DEFAULT_STATS_LAYOUT: UiStatsLayout = {
  slots: [
    "fps",
    "health",
    "maxHealth",
    "hunger",
    "thirst",
    "oxygen",
    "maxOxygen",
    "temperature",
    "timeOfDay",
    "weatherType",
    "playerX",
    "playerY",
    "playerZ",
    "zoom",
    "cameraMode",
    "simReady",
    "tick",
  ],
};

export type StatsValues = Partial<Record<string, number>>;

// Re-export for convenience
export type { PixiUiLibConfig, UiStatsLayout } from "./library";
