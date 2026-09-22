// ============================================================================
// native-game-module.ts — run a shared GameModule on the native host
//
// The convergence entry point: the SAME GameModule a game passes to
// `startGame()` under Electron/browser/mobile runs unchanged on the native
// host — SDL window + wgpu device + the in-process `downdraft` bridge.
//
//   // Electron (main.tsx):              startGame(gameModule)
//   // Native (native-entry.ts):
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

import type { GameModule, GameContext, GameSimWorker } from "@downdraft/engine/app/renderer";
import { createLogger } from "@downdraft/engine/util/logger";
import { getFreeTypeTextRenderer } from "./image/native-image";
import { startNativeMcpServer, type NativeMcpOptions } from "./mcp/native-mcp";
import { createNativeHost, type NativeHostConfig } from "./native-host";
import { wireFreeTypeText } from "./native-game";

const log = createLogger();

export interface RunNativeGameModuleOptions {
  /** Window title. */
  title: string;
  /** Per-game application identifier — REQUIRED: scopes the userData dir
   *  (saves, import cache, localStorage) and enables the bridge. Use the
   *  same appId the Electron config declares so saves are shared. */
  appId: string;
  /** Window size (default 1280x720). */
  width?: number;
  height?: number;
  /** Engine/game version stamped into saves + the feature log. */
  engineVersion?: string;
  /** MCP server options, or `false` to disable (default: ephemeral port). */
  mcp?: boolean | NativeMcpOptions;
  /** Extra host overrides (screenshotPath, screenshotAfterFrames, ...). */
  host?: Partial<Omit<NativeHostConfig, "window" | "appId" | "engineVersion" | "mcp">>;
}

/**
 * Boot a shared `GameModule` on the native host and block until the window
 * closes. Equivalent to `startGame(module)` after Electron main has created
 * the BrowserWindow — but with the native bridge installed instead of the
 * preload IPC bridge.
 */
export async function runNativeGameModule<Sim extends GameSimWorker>(
  module: GameModule<Sim>,
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
    },
    appId: opts.appId,
    engineVersion: opts.engineVersion,
    mcp: opts.mcp,
    ...(opts.host ?? {}),
  });
  const { window } = host;

  try {
    // 2. Run the shared bootstrap. Dynamic import keeps the renderer bundle
    //    out of the module graph for tools that only need the host.
    const { startGame } = await import("@downdraft/engine/app/renderer");

    // Native needs FreeType wired into the renderer's IMUI text atlas after
    // init — chain it into the module's onReady (runs post-init, before
    // game wiring) without changing the module's semantics elsewhere.
    const wrapped: GameModule<Sim> = {
      ...module,
      onReady: async (ctx: GameContext<Sim>) => {
        wireFreeTypeText(ctx.renderer);
        await module.onReady?.(ctx);
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
