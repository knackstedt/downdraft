// ============================================================================
// native-game.ts — Generic native game bootstrap
//
// The batteries-included counterpart to startGame() (renderer/browser): spins
// up a native host (SDL window + wgpu-native device + DOM polyfills), creates
// and initializes the game renderer, and drives the render loop via the
// native window's vsync-aligned requestAnimationFrame until the window
// closes.
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

import { createLogger, type GameRendererLike } from "@downdraft/engine";
import { createNativeHost, type NativeHostConfig, type NativeHostContext } from "./native-host";

export interface NativeGameContext<R extends GameRendererLike = GameRendererLike> {
  host: NativeHostContext;
  surface: NativeHostContext["surface"];
  /** Typed as `R` — inferred from the `renderer` factory return type. */
  renderer: R;
}

export interface NativeGameOptions<R extends GameRendererLike = GameRendererLike> {
  /** Window title (also used for the default screenshot filename). */
  title: string;
  /** Window size (default 1280x720). */
  width?: number;
  height?: number;
  /** Request window activation on launch. Default false — the window maps
   *  inactive so starting the game never steals focus. */
  focused?: boolean;
  /** Renderer factory — receives the native surface (canvas polyfill). */
  renderer: (surface: any, host: NativeHostContext) => R;
  /** Extra NativeHostConfig overrides (screenshotPath, etc.). */
  host?: Partial<Omit<NativeHostConfig, "window">>;
  /**
   * Called after the renderer initializes, before the loop starts.
   * Wire sim workers, buffers, input, and stores here.
   */
  onReady?: (ctx: NativeGameContext<R>) => void | Promise<void>;
  /** Called once per rendered frame (after renderer frame dispatch). */
  onFrame?: (ctx: NativeGameContext<R>) => void;
  /** Called after the window closes, before host destruction. */
  onDispose?: (ctx: NativeGameContext<R>) => void;
}

const log = createLogger();

/**
 * @deprecated Use `runNativeGameModule(module, opts)` — it runs the shared
 * `GameModule`/`startGame()` bootstrap (saves, devtools, MCP, deterministic
 * mode, hot-reload) instead of a bare onReady callback. This mid-level API
 * remains only as an escape hatch for harnesses that need a raw loop.
 */
export async function startNativeGame<R extends GameRendererLike = GameRendererLike>(options: NativeGameOptions<R>): Promise<void> {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;

  const host = await createNativeHost({
    window: { title: options.title, width, height, focused: options.focused },
    ...options.host,
  });
  const { surface, window } = host;
  let ctx: NativeGameContext<R> | null = null;

  try {
    const renderer = options.renderer(surface, host);
    ctx = { host, surface, renderer };
    const ok = await renderer.init();
    if (ok === false) throw new Error("renderer.init() returned false");
    log.info("native-game", "Renderer initialized");

    await options.onReady?.(ctx);

    // The native host installed a vsync-driven requestAnimationFrame on
    // globalThis — the renderer's own RAF loop just works.
    renderer.start();

    // Resize delivery: NativeSurface pushes "resize" events and
    // GameRenderer's CanvasResizeWatcher subscribes at init() (its
    // synchronous initial call covers early WM resizes). Don't call
    // renderer.onResize here — that double-fires every resize.
    const pumpFrame = () => {
      try { if (ctx) options.onFrame?.(ctx); } catch (e) { log.error("native-game", `onFrame: ${e}`); }
      requestAnimationFrame(pumpFrame);
    };
    requestAnimationFrame(pumpFrame);

    // Wait for the window to close.
    await new Promise<void>((resolve) => {
      window.addEventListener("close", () => resolve());
    });
    log.info("native-game", "Window closed");
  } finally {
    try { if (ctx) await options.onDispose?.(ctx); } catch {}
    try { ctx?.renderer.stop(); } catch {}
    try { host.destroy(); } catch {}
  }
}
