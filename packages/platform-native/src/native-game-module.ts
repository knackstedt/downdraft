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

import type { GameContext, GameModule, GameRendererLike, GameSimWorker, SimWorkerSeed } from "@downdraft/engine/app/renderer";
import { createLogger } from "@downdraft/engine/util/logger";
import { retireAllSharedDevices } from "./gpu/shared-device";
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

  // Capture ctx + the factory-built sim so the shutdown path can stop the
  // worker even when a game's hooks never hand it back (startGame threw
  // mid-boot, onInit overrode sim start, etc.). ctx.sim also covers the
  // simFromRenderer topology once onReady runs.
  let gameCtx: GameContext<Sim, R> | undefined;
  let createdSim: Sim | undefined;

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
      sim: module.sim
        ? ((seed?: SimWorkerSeed): Sim => (createdSim = module.sim!(seed)))
        : undefined,
      simFromRenderer: module.simFromRenderer
        ? async (renderer: R, ctx: GameContext<Sim, R>) => {
            const owned = await module.simFromRenderer!(renderer, ctx);
            if (owned) createdSim = owned;
            return owned;
          }
        : undefined,
      onReady: async (ctx: GameContext<Sim, R>) => {
        gameCtx = ctx;
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
    //    window.closed covers a close that already fired during boot —
    //    registering a listener for it now would hang the entry forever.
    if (!(window as { closed?: boolean }).closed) {
      await new Promise<void>((resolve) => {
        window.addEventListener("close", () => resolve());
      });
    }
    log.info("native-game-module", "Window closed");
  } finally {
    // Shutdown order matters — free GPU handles only after workers are dead:
    // a worker inside a wgpu FFI call when release_device runs can wedge
    // teardown (and with it, the dev shell's force-exit timer).
    //
    // Raise the shared-device detach flag FIRST so workers stop issuing new
    // FFI calls immediately; the bounded detach wait overlaps the graceful
    // stops below.
    const retire = retireAllSharedDevices(1_500);
    try {
      // Dev shell: joins the supervisor's in-flight session teardown
      // (reentrant) — registered sims + tracked workers stop first.
      await (globalThis as any).__ddSession?.teardown?.({ destroyDevices: false });
    } catch { /* dev shell absent or already down */ }
    // Packaged/direct-run mode has no session tracker — hooks.dispose()
    // callbacks (ui.dispose → html-ui worker, pluginHost, module.onDispose)
    // land on __ddDisposeQueue instead. Drain LIFO like the session tracker.
    const g = globalThis as any;
    const queue: Array<() => Promise<void> | void> = g.__ddDisposeQueue ?? [];
    g.__ddDisposeQueue = [];
    for (let i = queue.length - 1; i >= 0; i--) {
      try { await queue[i](); } catch { /* best-effort */ }
    }
    // Outside the dev shell nothing stops the sim — an unstopped worker's
    // tick loop pins the runtime after the window closes and the process
    // never exits. No-op when the session teardown already stopped it.
    // Bounded: a worker wedged inside a synchronous call must not stall the
    // close path — force it down after 2s via terminate if available.
    const sim: any = gameCtx?.sim ?? createdSim;
    try {
      const graceful: Promise<void> | undefined =
        sim?.stop ? sim.stop() : sim?.shutdown?.();
      if (graceful) {
        let timedOut = false;
        // Untracked where possible — under the dev shell a session-tracked
        // setTimeout could be cancelled by a concurrent teardown, removing
        // the bound and letting a wedged worker stall the close path.
        const untracked = (globalThis as any).__ddSession?.untrackedTimeout;
        const bound = new Promise<void>((resolve) => {
          const fire = () => { timedOut = true; resolve(); };
          if (typeof untracked === "function") untracked(fire, 2_000);
          else setTimeout(fire, 2_000);
        });
        await Promise.race([graceful, bound]);
        if (timedOut) {
          log.warn("native-game-module", "sim stop timed out (2s) — terminating");
          try { sim?.terminate?.(); } catch { /* already dead */ }
        }
      }
    } catch { /* worker already gone */ }
    try { await retire; } catch { /* bounded best-effort */ }
    try { host.destroy(); } catch { /* already torn down */ }
  }
}

// Re-export for convenience — bespoke native entries that still need the
// low-level path keep using startNativeGame/createNativeHost directly.
export { startNativeMcpServer };
