// ============================================================================
// Raw Input Module — Shared Types
// ============================================================================
// Type-only definitions shared across main / preload / renderer processes.
// No runtime code — safe to import from any process.

/** Raw mouse delta (accumulated since the last flush). */
export interface RawInputDelta {
  dx: number;
  dy: number;
}

/** Platform detected by the native addon. */
export type RawInputPlatform = "x11" | "wayland" | "win32" | "macos" | "unsupported";

/** Status returned by the native addon. */
export interface RawInputStatus {
  platform: RawInputPlatform;
  capturing: boolean;
  /** Human-readable detail (e.g. "XInput2 raw motion + XWarpPointer confinement"). */
  detail: string;
}

/**
 * Configuration for startCapture.
 * `windowHandle` is the Buffer from `BrowserWindow.getNativeWindowHandle()`.
 * On X11 this is the X11 Window ID; on Windows the HWND; on macOS the NSView pointer.
 */
export interface RawInputCaptureConfig {
  /** Native window handle from BrowserWindow.getNativeWindowHandle(). */
  windowHandle: Buffer;
  /** Hide the OS cursor while capturing. Default true. */
  hideCursor?: boolean;
  /** Confine the cursor to the window bounds. Default true. */
  confineCursor?: boolean;
}
