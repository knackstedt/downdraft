// ============================================================================
// app-window.ts — AppWindow: the app-facing window abstraction
//
// A uniform handle over NativeWindow for the primary window (handle 0) and
// secondary windows (1+) — runtime controls, vetoable close, and window
// creation. App code gets instances via AppWindow.primary()/list()/create();
// the underlying NativeWindow stays reachable as `.native` for the event
// surface, rAF source, and wgpu surface it already exposes.
//
//   const win = AppWindow.primary();
//   win.setMinSize(480, 320);
//   win.onCloseRequest(async () => {
//     if (await confirmDiscard()) return true;   // close proceeds
//     return false;                              // veto — stays mapped
//   });
//
//   const aux = AppWindow.create({ title: "Inspector", width: 640, height: 480 });
// ============================================================================

import type { NativeSurface } from "./native-surface";
import { NativeWindow, type NativeWindowConfig } from "./native-window";

export interface AppWindowOptions {
  title: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  resizable?: boolean;
  decorations?: boolean;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  clickThrough?: boolean;
  hidden?: boolean;
}

/**
 * Callback deciding a close request. Return/resolve true to close, false to
 * veto. The window stays mapped until the callback settles — async prompts
 * ("unsaved changes?") are the intended use.
 */
export type CloseRequestHandler = (win: AppWindow) => boolean | Promise<boolean>;

export class AppWindow {
  private static wrapped = new Map<number, AppWindow>();

  /** Wrap (or return the existing wrap of) a live NativeWindow. */
  static of(native: NativeWindow): AppWindow {
    let w = AppWindow.wrapped.get(native.windowHandle);
    if (!w || w.native !== native) {
      // A window destroyed and recreated under the same handle gets a fresh
      // wrapper (the stale one would delegate to a dead NativeWindow).
      w = new AppWindow(native);
      AppWindow.wrapped.set(native.windowHandle, w);
      native.addEventListener("close", () => {
        if (AppWindow.wrapped.get(native.windowHandle) === w) {
          AppWindow.wrapped.delete(native.windowHandle);
        }
      });
    }
    return w;
  }

  /** The primary window, or undefined before the host creates it. */
  static primary(): AppWindow | undefined {
    const n = NativeWindow.forHandle(0);
    return n ? AppWindow.of(n) : undefined;
  }

  /** Every live window — primary first when present. */
  static list(): AppWindow[] {
    return NativeWindow.allWindows().map((n) => AppWindow.of(n));
  }

  /**
   * Open a secondary window. Requires a live primary + GPU instance (the
   * surface binds at construction — call after createNativeHost resolves).
   * The window's event loop starts immediately; drive its surface with the
   * same rendering path the primary uses.
   */
  static create(opts: AppWindowOptions): AppWindow {
    const config: NativeWindowConfig = {
      secondary: true,
      title: opts.title,
      width: opts.width,
      height: opts.height,
      x: opts.x,
      y: opts.y,
      resizable: opts.resizable,
      decorations: opts.decorations,
      transparent: opts.transparent,
      alwaysOnTop: opts.alwaysOnTop,
      skipTaskbar: opts.skipTaskbar,
      clickThrough: opts.clickThrough,
      hidden: opts.hidden,
    };
    const native = new NativeWindow(config);
    native.start();
    return AppWindow.of(native);
  }

  private constructor(readonly native: NativeWindow) {}

  /** Shim handle — 0 is the primary window, 1+ secondaries. */
  get id(): number { return this.native.windowHandle; }
  get isPrimary(): boolean { return this.native.windowHandle === 0; }
  /** True after the window's close dispatched (vetoed closes don't set it). */
  get closed(): boolean { return this.native.closed; }
  /** The window's wgpu surface (HTMLCanvasElement-compatible). */
  get surface(): NativeSurface { return this.native.getSurface(); }

  // ── Controls ──

  setTitle(title: string): void { this.native.setTitle(title); }
  setSize(width: number, height: number): void { this.native.setWindowSize(width, height); }
  getSize(): { width: number; height: number } { return this.native.getWindowSize(); }
  setPos(x: number, y: number): void { this.native.setWindowPos(x, y); }
  getPos(): { x: number; y: number } { return this.native.getWindowPos(); }

  minimize(): void { this.native.setMinimized(true); }
  maximize(): void { this.native.setMaximized(true); }
  /** Un-minimize + un-maximize back to normal placement. */
  restore(): void {
    this.native.setMinimized(false);
    this.native.setMaximized(false);
  }
  isMaximized(): boolean { return this.native.isMaximized(); }

  setVisible(visible: boolean): void { this.native.setWindowVisible(visible); }
  /** Request activation — best-effort; the WM may refuse. */
  focus(): void { this.native.requestFocus(); }
  /** Taskbar/dock attention request (urgent = critical level). */
  requestAttention(urgent = false): void { this.native.requestAttention(urgent); }

  setDecorations(on: boolean): void { this.native.setDecorations(on); }
  setAlwaysOnTop(on: boolean): void { this.native.setAlwaysOnTop(on); }
  setResizable(on: boolean): void { this.native.setResizable(on); }
  setFullscreen(on: boolean): void { this.native.setFullscreen(on); }

  /** Min/max inner size in physical px; pass 0,0 to clear. */
  setMinSize(w: number, h: number): void { this.native.setMinSize(w, h); }
  setMaxSize(w: number, h: number): void { this.native.setMaxSize(w, h); }

  /** Effective theme of this window — "light" | "dark" | "unknown". */
  getTheme(): "light" | "dark" | "unknown" { return this.native.getTheme(); }

  /** OS occlusion reports (Wayland/macOS/Android only) — unsubscribe fn. */
  onOccluded(cb: (occluded: boolean) => void): () => void {
    const fn = (e: { occluded: boolean }) => cb(e.occluded);
    this.native.addEventListener("occluded", fn);
    return () => this.native.removeEventListener("occluded", fn);
  }

  /** Theme-change reports (from the OS dark-mode toggle) — unsubscribe fn. */
  onThemeChanged(cb: (theme: "light" | "dark" | "unknown") => void): () => void {
    const fn = (e: { theme: "light" | "dark" | "unknown" }) => cb(e.theme);
    this.native.addEventListener("themechanged", fn);
    return () => this.native.removeEventListener("themechanged", fn);
  }

  // ── Close ──

  /**
   * Install a close-request veto. Arms the native intercept once: OS close
   * requests stop auto-closing and route through `cb`. The callback settles
   * the decision — resolve true → the close-policy action runs (hide under
   * "explicit", close under "lastWindow"); false/throw → the window stays
   * mapped. Returns an unsubscribe fn (the intercept stays armed — later
   * closes fall through to other handlers or the default action).
   */
  onCloseRequest(cb: CloseRequestHandler): () => void {
    this.native.setCloseIntercept(true);
    const fn = (e: { preventDefault(): void }) => {
      // Always veto at dispatch time — the async callback resolves later and
      // runs the policy's close action itself when the verdict is "accept".
      e.preventDefault();
      void Promise.resolve(cb(this)).then(
        (ok) => {
          if (!ok) return;
          if (this.native.closePolicy === "explicit") this.native.setWindowVisible(false);
          else this.close();
        },
        () => { /* a throwing handler vetoes — window stays */ },
      );
    };
    this.native.addEventListener("closerequest", fn);
    return () => this.native.removeEventListener("closerequest", fn);
  }

  /**
   * Close the window — the same path an unvetoed close takes. Primary: the
   * process quit path (close event + host teardown). Secondary: close event
   * + destroy, process keeps running.
   */
  close(): void {
    this.native.close();
  }
}
