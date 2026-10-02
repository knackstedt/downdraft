// ============================================================================
// native-game.ts — Generic native game bootstrap
//
// The batteries-included counterpart to startGame() (renderer/browser): spins
// up a native host (SDL window + wgpu-native device + DOM polyfills), creates
// and initializes the game renderer, wires the FreeType text renderer into
// the IMUI text atlas, and drives the render loop via the native window's
// vsync-aligned requestAnimationFrame until the window closes.
//
// Game-specific wiring (sim worker spawn, SAB plumbing, store setup, keybinds)
// lives in the `onReady` hook. Most GameRenderer-based games only need:
//
//   await startNativeGame({
//     title: "My Game",
//     renderer: (surface) => new MyRenderer(surface),
//     onReady: async ({ renderer }) => { /* start sim, wire buffers */ },
//   });
// ============================================================================

import { createLogger } from "@downdraft/engine";
import { createNativeHost, type NativeHostConfig, type NativeHostContext } from "./native-host";

export interface NativeGameContext {
  host: NativeHostContext;
  surface: NativeHostContext["surface"];
  renderer: any;
}

export interface NativeGameOptions {
  /** Window title (also used for the default screenshot filename). */
  title: string;
  /** Window size (default 1280x720). */
  width?: number;
  height?: number;
  /** Renderer factory — receives the native surface (canvas polyfill). */
  renderer: (surface: any, host: NativeHostContext) => any;
  /** Extra NativeHostConfig overrides (screenshotPath, etc.). */
  host?: Partial<Omit<NativeHostConfig, "window">>;
  /**
   * Called after the renderer initializes, before the loop starts.
   * Wire sim workers, buffers, input, and stores here.
   */
  onReady?: (ctx: NativeGameContext) => void | Promise<void>;
  /** Called once per rendered frame (after renderer frame dispatch). */
  onFrame?: (ctx: NativeGameContext) => void;
  /** Called after the window closes, before host destruction. */
  onDispose?: (ctx: NativeGameContext) => void;
}

const log = createLogger();

export async function startNativeGame(options: NativeGameOptions): Promise<void> {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;

  const host = await createNativeHost({
    window: { title: options.title, width, height },
    ...options.host,
  });
  const { surface, window } = host;
  const ctx: NativeGameContext = { host, surface, renderer: null };

  try {
    ctx.renderer = options.renderer(surface, host);
    const ok = await ctx.renderer.init?.();
    if (ok === false) throw new Error("renderer.init() returned false");
    log.info("native-game", "Renderer initialized");

    await options.onReady?.(ctx);

    // The native host installed a vsync-driven requestAnimationFrame on
    // globalThis — the renderer's own RAF loop just works.
    ctx.renderer.start?.();

    // Resize delivery: NativeSurface pushes "resize" events and
    // GameRenderer's CanvasResizeWatcher subscribes at init() (its
    // synchronous initial call covers early WM resizes). Don't call
    // renderer.onResize here — that double-fires every resize.
    const pumpFrame = () => {
      try { options.onFrame?.(ctx); } catch (e) { log.error("native-game", `onFrame: ${e}`); }
      requestAnimationFrame(pumpFrame);
    };
    requestAnimationFrame(pumpFrame);

    // Wait for the window to close.
    await new Promise<void>((resolve) => {
      window.addEventListener("close", () => resolve());
    });
    log.info("native-game", "Window closed");
  } finally {
    try { await options.onDispose?.(ctx); } catch {}
    try { ctx.renderer?.stop?.(); } catch {}
    try { host.destroy(); } catch {}
  }
}
