// ============================================================================
// native-game-module.ts — run a shared GameModule on the native host
//
// The convergence entry point: the SAME GameModule a game passes to
// `startGame()` runs unchanged on the native host — SDL window + wgpu
// device + the in-process `downdraft` bridge.
//
//   // native-entry.ts:
//   await runNativeGameModule(gameModule, {
//     title: "My Game",
//     appId: "downdraft-my-game",
//   });
//
// This is what eliminates the bespoke native-entry.ts per game: saves
// (FileSaveStore), MCP (in-process server), display info, screenshots,
// deterministic mode, and the standard automation tools all light up
// through the bridge — no IPC, no second process.
// ============================================================================

import type { GameContext, GameModule, GameRendererLike, GameSimWorker } from "@downdraft/engine/app/renderer";
import { createLogger } from "@downdraft/engine/util/logger";
import { addCrashFeatureLog } from "./host-lifecycle";
import { startNativeMcpServer, type NativeMcpOptions } from "./mcp/native-mcp";
import { createNativeHost, type NativeHostConfig } from "./native-host";

const log = createLogger();

export interface RunNativeGameModuleOptions {
  /** Window title. */
  title: string;
  /** Per-game application identifier — REQUIRED: scopes the userData dir
   *  (saves, import cache, localStorage) and enables the bridge. */
  appId: string;
  /** Window size (default 1280x720). */
  width?: number;
  height?: number;
  /** Request window activation on launch. Default false — the window maps
   *  inactive so starting the game never steals focus. WMs may still focus
   *  the window per their own policy. */
  focused?: boolean;
  /** Engine/game version stamped into saves + the feature log. */
  engineVersion?: string;
  /** MCP server options, or `false` to disable (default: ephemeral port). */
  mcp?: boolean | NativeMcpOptions;
  /** Extra host overrides (screenshotPath, screenshotAfterFrames, ...). */
  host?: Partial<Omit<NativeHostConfig, "window" | "appId" | "engineVersion" | "mcp">>;
}

/**
 * Boot a shared `GameModule` on the native host and block until the window
 * closes. Equivalent to `startGame(module)` once the window exists — but
 * with the native bridge installed in-process.
 */
export async function runNativeGameModule<Sim extends GameSimWorker, R extends GameRendererLike = GameRendererLike>(
  module: GameModule<Sim, R>,
  opts: RunNativeGameModuleOptions,
): Promise<void> {
  // 1. Native host: window + wgpu device + DOM polyfills + downdraft bridge
  //    + in-process MCP server. Everything startGame() reads from
  //    `window.downdraft` resolves through the bridge from here on.
  const host = await createNativeHost({
    window: {
      title: opts.title,
      width: opts.width ?? 1280,
      height: opts.height ?? 720,
      focused: opts.focused,
    },
    appId: opts.appId,
    engineVersion: opts.engineVersion,
    mcp: opts.mcp,
    ...opts.host,
  });
  const { window } = host;

  try {
    // 2. Run the shared bootstrap. Dynamic import keeps the renderer bundle
    //    out of the module graph for tools that only need the host.
    const { startGame, getRendererFeatureLog } = await import("@downdraft/engine/app/renderer");
    // The render feature line (WebGPU adapter/features/limits) is collected
    // during startGame's bootstrap — register it so a later crash carries it.
    addCrashFeatureLog(getRendererFeatureLog);

    // Wrap the module's onReady to install native hooks post-init (before
    // game wiring) without changing the module's semantics elsewhere.
    const wrapped: GameModule<Sim, R> = {
      ...module,
      onReady: async (ctx: GameContext<Sim, R>) => {
        // Let the bridge's captureFrame force an on-demand frame when the
        // render loop is stopped (deterministic mode).
        (globalThis as any).__ddRequestFrame = () => {
          // renderOnce() is the canonical one-shot — renderers that draw
          // outside the GameRenderer frame graph (e.g. to-the-ocean)
          // override it, so dynamic dispatch reaches the bespoke frame.
          try { ctx.renderer?.renderOnce?.call(ctx.renderer); } catch { /* loop stopped mid-frame */ }
        };

        // Resize delivery: the surface pushes "resize" events and
        // GameRenderer's CanvasResizeWatcher subscribes to them (with a
        // synchronous initial call covering the startup case). Don't
        // forward to onResize here — that's a second subscription onto the
        // same event and double-fires every resize.
        await module.onReady?.(ctx);
      },
      onDispose: (ctx: GameContext<Sim, R>) => {
        try { delete (globalThis as any).__ddRequestFrame; } catch {}
        module.onDispose?.(ctx);
      },
    };

    await startGame(wrapped);
    log.info("native-game-module", `GameModule started (${opts.title})`);

    // 3. Block until the window closes (SDL quit event or bridge.quit()).
    await new Promise<void>((resolve) => {
      window.addEventListener("close", () => resolve());
    });
    log.info("native-game-module", "Window closed");
  } finally {
    try { host.destroy(); } catch { /* already torn down */ }
  }
}

// Re-export for convenience — bespoke native entries that still need the
// low-level path keep using startNativeGame/createNativeHost directly.
export { startNativeMcpServer };
