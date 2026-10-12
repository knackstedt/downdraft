// ============================================================================
// webui types — shared contract for the heavyweight browser-backed UI tier
//
// One ABI (`dd_webui_*`), two backend cdylibs: libdowndraft_webui_cef
// (Chromium — desktop) and libdowndraft_webui_wpe (embedded WebKit — linux
// dev/testing + android). Blitz remains the canonical lightweight UI; this
// tier exists for pages that need a real web engine.
// ============================================================================

export type WebUiBackend = "cef" | "wpe";

export interface WebUiViewConfig {
  /** Unique view id — host-keyed, like OSR renderer ids. */
  id: string;
  /** Logical (CSS-px) size. Physical raster = size × scale. */
  width: number;
  height: number;
  /** Raster scale — physical px per CSS px. Default: surface scaleFactor. */
  scale?: number;
  /** Initial URL to load (mutually exclusive with `html`). */
  url?: string;
  /** Inline HTML to load instead of a URL. */
  html?: string;
  /** Forward input to the page. Default true. */
  interactive?: boolean;
  /** Transparent background (no opaque page color). Default true — game UI
   *  panels composite over the scene, so pages see-through by default. */
  transparent?: boolean;
  /** Repaint-rate hint in Hz. Default 60. */
  frameRate?: number;
  /** Override the engine's user agent for this view. */
  userAgent?: string;
  /** Max auto-recreate attempts after a render-process crash before the
   *  view reports "failed". Default 3; -1 retries forever. */
  maxCrashRetries?: number;
}

export type WebUiViewStatus = "running" | "crashed" | "recovering" | "failed";

/** Events drained from a view's native event queue (dd_webui_poll_events). */
export type WebUiEvent =
  /** Page → host message (window.downdraft.postMessage → CefProcessMessage
   *  or WebKit script-message). `v` is the JSON-decoded payload. */
  | { t: "message"; v: unknown }
  /** Result of an eval() request — id matches the request token. `ok`=1 and
   *  `v` = JSON-serialized result; `ok`=0 and `v` = error message. */
  | { t: "eval"; id: number; ok: 0 | 1; v: string }
  /** console.* output from the page. lvl: 0=log 1=warn 2=error 3=debug. */
  | { t: "console"; lvl: number; v: string }
  /** CSS cursor-name request for the view ("" → default). */
  | { t: "cursor"; v: string }
  /** Renderer-process status transition. */
  | { t: "status"; v: WebUiViewStatus }
  /** Navigation state changed. */
  | { t: "nav"; url: string; canBack: boolean; canFwd: boolean };

/**
 * Pointer/keyboard input — same semantic contract as OSRInputEvent but
 * view-keyed. The host routes engine pointer/wheel/key events into
 * dd_webui_input_* calls; coordinates are view-local logical px.
 */
export interface WebUiInputEvent {
  type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseWheel"
      | "keyDown" | "keyUp" | "touchDown" | "touchMove" | "touchUp" | "touchCancel"
      | "imePreedit" | "imeCommit" | "imeCancel";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  deltaX?: number;
  deltaY?: number;
  /** W3C UI-Events key/code ("Enter"/"a", "KeyF"/"Escape"). */
  key?: string;
  code?: string;
  text?: string;
  repeat?: boolean;
  modifiers?: string[];
  /** Touch point id for multi-touch events. */
  touchId?: number;
}

export type WebUiNavOp = "back" | "forward" | "reload" | "stop";

export type WebUiPixelFormat = "rgba" | "bgra";

/**
 * Host surface consumed by the webui module — mirrors OSRHostBridge's
 * role but for real-browser views. Implemented by
 * platform-native/src/webui/webui-host.ts over the dd_webui_* cdylibs.
 */
export interface WebUiHostBridge {
  /** Which engine backs this host ("cef" | "wpe"). */
  readonly backend: WebUiBackend;
  createView(config: WebUiViewConfig): Promise<boolean>;
  destroyView(id: string): Promise<void>;
  loadURL(id: string, url: string): Promise<void>;
  setContent(id: string, html: string): Promise<void>;
  resize(id: string, width: number, height: number, scale?: number): void;
  navigate(id: string, op: WebUiNavOp): void;
  setZoom(id: string, factor: number): void;
  setFocus(id: string, focused: boolean): void;
  setInteractive(id: string, interactive: boolean): void;
  /** Evaluate JS in the page's main world; resolves with the JSON-decoded
   *  result (rejects with the engine's error message). */
  eval(id: string, js: string): Promise<unknown>;
  /** Deliver a JSON-serializable payload to the page's window.downdraft
   *  message handler. */
  postMessage(id: string, payload: unknown): void;
  onMessage(id: string, cb: (payload: unknown) => void): () => void;
  onConsole(id: string, cb: (level: number, text: string) => void): () => void;
  onCursor(id: string, cb: (cursor: string) => void): () => void;
  onStatus(id: string, cb: (status: WebUiViewStatus) => void): () => void;
  sendInputEvent(id: string, event: WebUiInputEvent): void;
  /** Pull a dirty frame — returns the full pixel buffer when anything
   *  changed since the last pull, else null. Pixels are `pixelFormat`. */
  pullFrame(id: string): Uint8Array | null;
  /** Dirty union of the next pulled frame, or null when clean/full-frame. */
  frameRect(id: string): { x: number; y: number; w: number; h: number } | null;
  getDimensions(id: string): { w: number; h: number } | null;
  pixelFormat(id: string): WebUiPixelFormat;
  hitTest(id: string, x: number, y: number): boolean;
  /** View status (running/crashed/recovering/failed). */
  status(id: string): WebUiViewStatus;
  crashCount(id: string): number;
  recover(id: string): void;
  setCrashPolicy(id: string, maxRetries: number): void;
  /** A bridge bound to a different backend — for createWebUi({ backend })
   *  overrides when both cdylibs are staged (linux dev runs CEF and WPE
   *  side by side). Null when the backend's lib is absent. */
  forBackend?(backend: WebUiBackend): WebUiHostBridge | null;
}
