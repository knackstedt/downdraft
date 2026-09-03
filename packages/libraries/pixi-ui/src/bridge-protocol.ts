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
  /** Additional SharedArrayBuffers shared into the worker (e.g. ProfilingSAB).
   *  These are shared (not transferred) — the key names let the scene identify them. */
  extraSharedBuffers?: Record<string, SharedArrayBuffer>;
  /** Library config (backend, stats layout, scene factory id, etc.). */
  config: SerializedPixiUiConfig;
  /** Initial canvas CSS width/height in pixels. */
  width: number;
  height: number;
  /**
   * Render resolution (backing-store pixels per CSS pixel). Typically
   * `window.devicePixelRatio` so text renders crisply on HiDPI displays.
   * The host sets the canvas backing store to `width * resolution`; the
   * worker passes this to PixiJS as `resolution` so glyphs are rasterized
   * at full physical resolution. Default 1 (no upscaling).
   */
  resolution?: number;
  /**
   * Font scale multiplier (>= 1.0). The worker exposes this via
   * PixiUiSceneContext.fontScale so scenes can scale their text. Default:
   * the system-detected font scale (accessibility).
   */
  fontScale?: number;
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
  /**
   * New resolution if `devicePixelRatio` changed (e.g. window dragged to a
   * different-DPR monitor). Omitted when only the CSS size changed — the
   * worker reuses its existing resolution. When present, the worker updates
   * the renderer's resolution before resizing the backing store.
   */
  resolution?: number;
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

export interface SetFontScaleMessage {
  kind: "setFontScale";
  /** New font scale multiplier (>= 1.0). */
  fontScale: number;
}

/**
 * SAB polyfill fallback: when real SharedArrayBuffer is unavailable (Android
 * WebView), the UiStatsSAB is a polyfilled ArrayBuffer that gets structured-
 * cloned (not shared) when passed to the worker. The worker's copy never
 * receives the host's writes, so the host posts the raw SAB bytes each frame
 * via this message. The worker copies them into its local SAB so
 * `readUiStats()` returns current values. Only sent when SAB is polyfilled.
 */
export interface StatsSyncMessage {
  kind: "statsSync";
  /** Raw SAB bytes (header + float32 slots) — copied into the worker's local SAB. */
  data: ArrayBuffer;
}

export type MainToWorkerMessage =
  | InitMessage
  | EventMessage
  | PointerMessage
  | ResizeMessage
  | QuerySceneMessage
  | CaptureOverlayMessage
  | DisposeMessage
  | SetFontScaleMessage
  | StatsSyncMessage;

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

/**
 * The worker reports the bounding boxes of interactive UI regions to the host.
 * Used by the host's pass-through mode: pointer events inside these regions
 * are forwarded to the worker for PixiJS hit-testing; events outside are
 * dispatched on the game canvas so the game keeps receiving input.
 *
 * Coordinates are in canvas pixels (top-left origin), matching the pointer
 * event coordinate space. The host caches the latest regions and uses them
 * for synchronous hit-testing on every pointer event.
 */
export interface InteractiveRegionsMessage {
  kind: "interactiveRegions";
  regions: Rect[];
}

/**
 * The worker reports the bounding boxes of opaque UI panels (alpha ≈ 1.0
 * backgrounds) to the host. The host forwards these to the game via
 * `onOpaqueChange`, and the game uses them to skip rendering the 3D scene +
 * postfx under these rects (the overlay composites on top, so the game canvas
 * under an opaque panel is never seen).
 *
 * Only report panels where the game canvas is NOT visible through the panel
 * (alpha < 1.0 scrims/dims are NOT opaque). Coordinates are in canvas pixels
 * (top-left origin), matching the interactive-regions coordinate space.
 */
export interface OpaqueRegionsMessage {
  kind: "opaqueRegions";
  regions: Rect[];
}

/**
 * Worker → main: a forwarded pointer event did NOT hit any interactive
 * PixiJS element (the hit-test returned null). The host should dispatch a
 * synthetic PointerEvent on the element beneath the overlay so the game
 * canvas receives the input. Used in pass-through mode when the scene
 * reports a full-screen interactive region (e.g. @pixi/react scenes) —
 * the host can't distinguish UI hits from empty space, so the worker
 * does the hit-test and reports misses.
 */
export interface PointerMissedMessage {
  kind: "pointerMissed";
  /** The pointer event type that missed. */
  type: "pointerdown" | "pointermove" | "pointerup" | "pointerleave";
  /** Canvas pixel coordinates (top-left origin). */
  x: number;
  y: number;
  button: number;
  modifiers: number;
}

export type WorkerToMainMessage =
  | ReadyMessage
  | SetInteractiveMessage
  | ActionMessage
  | SceneStateMessage
  | CaptureResultMessage
  | ErrorMessage
  | InteractiveRegionsMessage
  | OpaqueRegionsMessage
  | PointerMissedMessage;

// --- Shared types ---

/** A rectangle in canvas pixel coordinates (top-left origin). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /** Whether the host is in pass-through mode (interactive UI + game-canvas input). */
  passThrough?: boolean;
  /** Names of extra SharedArrayBuffers shared into the worker (keys of extraSharedBuffers).
   *  The scene can access them via ctx.extraSharedBuffers[name]. */
  extraSharedBufferKeys?: string[];
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
    passThrough: config.passThrough ?? false,
    extraSharedBufferKeys: config.extraSharedBuffers ? Object.keys(config.extraSharedBuffers) : undefined,
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
