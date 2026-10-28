// ============================================================================
// native-app-module.ts — run a shared AppModule on the native host
//
// The convergence entry point: the SAME AppModule an app passes to
// `startApp()` runs unchanged on the native host — winit window + wgpu
// device + the in-process `downdraft` bridge.
//
//   // native-entry.ts:
//   await runNativeAppModule(appModule, {
//     title: "My App",
//     appId: "downdraft-my-app",
//   });
//
// This is what eliminates the bespoke native-entry.ts per app: saves
// (FileSaveStore), MCP (in-process server), display info, screenshots,
// deterministic mode, and the standard automation tools all light up
// through the bridge — no IPC, no second process.
// ============================================================================

import type { AppContext, AppModule, AppRendererLike, SimWorker, SimWorkerSeed } from "@downdraft/engine/app/main";
import { createLogger } from "@downdraft/engine/util/logger";
import { setSecondInstanceFocus } from "./bridge/singleton-lock";
import { retireAllSharedDevices } from "./gpu/shared-device";
import { addCrashFeatureLog } from "./host-lifecycle";
import { startNativeMcpServer, type NativeMcpOptions } from "./mcp/native-mcp";
import { createNativeHost, HostBootSupersededError, type NativeHostConfig, type NativeHostContext } from "./native-host";
import { isPackaged } from "./packaged";
import { AppWindow } from "./window/app-window";

const log = createLogger();

/** Race a promise against dev-session teardown. Under the dev shell a
 *  dynamic import can be orphaned mid-flight by a module-cache clear and
 *  never settle — the suspended async frame then pins the session's module
 *  graph. Resolving to null lets the caller unwind cleanly. Outside the dev
 *  shell (no session tracker) this is a transparent passthrough. */
function raceSessionTeardown<T>(p: Promise<T>, expectedSession?: any): Promise<T | null> {
  const tracker = (globalThis as any).__ddSession;
  if (!tracker || typeof tracker.onDispose !== "function") return p;
  const s = tracker.session;
  // A different live session than the caller's generation means this frame
  // is dead-generation residue — bail rather than registering into it.
  if (!s || s.dead || (expectedSession !== undefined && s !== expectedSession)) {
    return Promise.resolve(null);
  }
  return Promise.race([
    p,
    new Promise<null>((resolve) => {
      tracker.onDispose(() => resolve(null));
      // Re-check: a registration landing on a dying session is dropped, and
      // without the resolve this race would park forever.
      if (s.dead || tracker.session !== s) resolve(null);
    }),
  ]);
}

export interface RunNativeAppModuleOptions {
  /** Window title. */
  title: string;
  /** Per-app application identifier — REQUIRED: scopes the userData dir
   *  (saves, import cache, localStorage) and enables the bridge. */
  appId: string;
  /** Window size (default 1280x720). */
  width?: number;
  height?: number;
  /** Request window activation on launch. Default: true for packaged apps
   *  (a launched app wants focus), false under `draft dev` — dev-shell
   *  restarts must not steal focus while the user is typing elsewhere. */
  focused?: boolean;
  /** Primary-window close policy. `"lastWindow"` (default): an accepted
   *  close request quits the process (the window-close = exit contract).
   *  `"explicit"`: a close request only hides the window — the process
   *  stays alive until the app calls `downdraft.quit()` (tray/background
   *  apps). App listeners may veto either way via `closerequest`'s
   *  preventDefault. */
  closePolicy?: "lastWindow" | "explicit";
  /** Convenience close veto — resolve false to keep the window mapped.
   *  Arms the native close intercept; the window stays mapped until the
   *  callback settles, then follows `closePolicy` (close under lastWindow,
   *  hide under explicit). Runs before the policy default; an app-side
   *  `closerequest` listener with its own preventDefault still wins. */
  onCloseRequest?: (win: AppWindow) => boolean | Promise<boolean>;
  /** Raise + focus the primary window when a second instance forwards its
   *  launch context (default true). Set false for apps that handle
   *  `downdraft.onSecondInstance` differently (e.g. only show a
   *  notification). */
  focusOnSecondInstance?: boolean;
  /** Engine/app version stamped into saves + the feature log. */
  engineVersion?: string;
  /** Path to an image decoded as the window icon (_NET_WM_ICON on X11,
   *  taskbar icon on Windows; Wayland resolves icons via appId instead). */
  iconPath?: string;
  /** MCP server options, or `false` to disable (default: ephemeral port). */
  mcp?: boolean | NativeMcpOptions;
  /** Extra host overrides (screenshotPath, screenshotAfterFrames, ...). */
  host?: Partial<Omit<NativeHostConfig, "window" | "appId" | "engineVersion" | "mcp">>;
}

/**
 * Boot a shared `AppModule` on the native host and block until the window
 * closes. Equivalent to `startApp(module)` once the window exists — but
 * with the native bridge installed in-process.
 */
export async function runNativeAppModule<Sim extends SimWorker, R extends AppRendererLike = AppRendererLike>(
  module: AppModule<Sim, R>,
  opts: RunNativeAppModuleOptions,
): Promise<void> {
  // Kick the renderer-bundle fetch first so it overlaps host creation — the
  // dynamic import keeps it out of the module graph for tools that only need
  // the host, but awaiting it cold would suspend this frame on an in-flight
  // fetch (an orphaned fetch — dropped by a mid-eval module-cache clear —
  // never settles, and the suspended frame pins the session's module graph).
  const appRendererP = import("@downdraft/engine/app/main");
  appRendererP.catch(() => {});
  // The session snapshot this boot belongs to — a restart mid-boot swaps it,
  // and dead-generation continuations must not run under the new session.
  const bootSession = (globalThis as any).__ddSession?.session ?? null;
  // Same for the ModuleRunner generation this module was evaluated by: a
  // Tier-3/4 reimport closes+replaces it, and every dynamic import this
  // generation issues afterwards rejects with "Vite module runner has been
  // closed". An error thrown while superseded is expected teardown — the
  // next generation's boot owns the window — not an entry failure.
  const bootRunner = (globalThis as any).__ddRunner;
  const bootSuperseded = (): boolean => {
    const g = globalThis as any;
    if (bootRunner && (bootRunner.closed === true || g.__ddRunner !== bootRunner)) return true;
    const s = g.__ddSession?.session;
    return !!(bootSession && (bootSession.dead || s !== bootSession));
  };

  // 1. Native host: window + wgpu device + DOM polyfills + downdraft bridge
  //    + in-process MCP server. Everything startApp() reads from
  //    `globalThis.downdraft` resolves through the bridge from here on.
  let host: NativeHostContext;
  try {
    host = await createNativeHost({
      window: {
        title: opts.title,
        width: opts.width ?? 1280,
        height: opts.height ?? 720,
        // Packaged launches ask for focus; dev runs don't steal it.
        focused: opts.focused ?? isPackaged(),
        // Desktop identity — without it every dev-run window maps with no
        // app_id/WM_CLASS and the WM groups all apps under one taskbar entry.
        appId: opts.appId,
        iconPath: opts.iconPath,
      },
      appId: opts.appId,
      engineVersion: opts.engineVersion,
      mcp: opts.mcp,
      ...opts.host,
    });
  } catch (e) {
    // The restart superseded this boot while the host was being built —
    // createNativeHost already rolled back its partial work. Resolve like a
    // session end; the next generation's entry import owns the window now.
    if (e instanceof HostBootSupersededError || bootSuperseded()) {
      log.info("native-app-module", `host boot superseded: ${(e as Error)?.message ?? e}`);
      return;
    }
    throw e;
  }
  const { window } = host;

  // Close lifecycle — the policy lives on the window (an unvetoed
  // closerequest consults it in the event dispatch, after every
  // synchronous listener ran — so a veto registered at ANY point wins
  // over the default action). Arm the native intercept when the app
  // opted into vetoable closes or the explicit (hide-don't-quit) policy.
  window.closePolicy = opts.closePolicy ?? "lastWindow";
  if (opts.closePolicy === "explicit" || opts.onCloseRequest) {
    window.setCloseIntercept(true);
  }

  // Second-instance default — a forwarded launch raises the window (and
  // unhides it, covering explicit-policy tray apps). Apps opt out with
  // focusOnSecondInstance: false and wire their own onSecondInstance.
  setSecondInstanceFocus(
    opts.focusOnSecondInstance === false
      ? null
      : () => {
          try { window.setWindowVisible(true); } catch { /* window may be gone */ }
          try { window.requestFocus(); } catch { /* no-op */ }
        },
  );

  // Capture ctx + the factory-built sim so the shutdown path can stop the
  // worker even when an app's hooks never hand it back (startApp threw
  // mid-boot, onInit overrode sim start, etc.). ctx.sim also covers the
  // simFromRenderer topology once onReady runs.
  let appCtx: AppContext<Sim, R> | undefined;
  let createdSim: Sim | undefined;
  let windowClosed = (window as { closed?: boolean }).closed === true;

  try {
    // 2. Run the shared bootstrap (fetch kicked before the host wait above).
    //    Race the import against session teardown: if a dev restart clears
    //    the module cache while the fetch is in flight it never settles, and
    //    the suspended frame pins this session's whole entry graph. Bailing
    //    on a dead session also keeps the continuation below from running
    //    startApp() into a host layer that was already stripped.
    let appRenderer;
    try {
      appRenderer = await raceSessionTeardown(appRendererP, bootSession);
    } catch (e) {
      // A runner close mid-fetch rejects the import — expected teardown
      // when this generation was superseded, not an entry failure.
      if (bootSuperseded()) return;
      throw e;
    }
    if (!appRenderer) return;
    const { startApp, getRendererFeatureLog } = appRenderer;
    // The render feature line (WebGPU adapter/features/limits) is collected
    // during startApp's bootstrap — register it so a later crash carries it.
    addCrashFeatureLog(getRendererFeatureLog);

    // Wrap the module's onReady to install native hooks post-init (before
    // app wiring) without changing the module's semantics elsewhere.
    const wrapped: AppModule<Sim, R> = {
      ...module,
      sim: module.sim
        ? ((seed?: SimWorkerSeed): Sim => (createdSim = module.sim!(seed)))
        : undefined,
      simFromRenderer: module.simFromRenderer
        ? async (renderer: R, ctx: AppContext<Sim, R>) => {
            const owned = await module.simFromRenderer!(renderer, ctx);
            if (owned) createdSim = owned;
            return owned;
          }
        : undefined,
      onReady: async (ctx: AppContext<Sim, R>) => {
        appCtx = ctx;
        // Let the bridge's captureFrame force an on-demand frame when the
        // render loop is stopped (deterministic mode).
        (globalThis as any).__ddRequestFrame = () => {
          // renderOnce() is the canonical one-shot — renderers that draw
          // outside the AppRenderer frame graph 
          // override it, so dynamic dispatch reaches the bespoke frame.
          try { ctx.renderer?.renderOnce?.call(ctx.renderer); } catch { /* loop stopped mid-frame */ }
        };

        // Resize delivery: the surface pushes "resize" events and
        // AppRenderer's CanvasResizeWatcher subscribes to them (with a
        // synchronous initial call covering the startup case). Don't
        // forward to onResize here — that's a second subscription onto the
        // same event and double-fires every resize.
        await module.onReady?.(ctx);

        // Convenience close hook — veto-pending while the callback
        // settles (preventDefault up front keeps the window mapped),
        // then follows the policy default: explicit hides, lastWindow
        // proceeds. The policy itself isn't a listener — it runs in the
        // event dispatch after ALL listeners, so a veto registered at
        // any point wins.
        if (opts.onCloseRequest) {
          const appWin = AppWindow.of(window);
          window.addEventListener("closerequest", (e: { preventDefault(): void }) => {
            e.preventDefault();
            void Promise.resolve(opts.onCloseRequest!(appWin)).then((ok) => {
              if (ok === false) return;
              if (opts.closePolicy === "explicit") window.setWindowVisible(false);
              else window.close();
            }).catch(() => { /* a throwing veto keeps the window */ });
          });
        }
      },
      onDispose: (ctx: AppContext<Sim, R>) => {
        try { delete (globalThis as any).__ddRequestFrame; } catch {}
        module.onDispose?.(ctx);
      },
    };

    await startApp(wrapped);
    log.info("native-app-module", `AppModule started (${opts.title})`);
    // The session is booted — any pending hot-reload restore state has been
    // consumed by the boot sims. Under the dev shell this is the real
    // "boot done" moment: the supervisor's finishSessionBoot fires after
    // runner.import(entry), which for this blocking entry only resolves at
    // session END — leaving stale restore data armed all session.
    try { (globalThis as any).__ddSession?.finishSessionBoot?.(); } catch { /* no dev shell */ }

    // 3. Block until the window closes (window close event or bridge.quit()).
    //    window.closed covers a close that already fired during boot —
    //    registering a listener for it now would hang the entry forever.
    //    Under the dev shell, a Tier-3 session restart tears the session down
    //    while the window stays open — the dispose hook releases this wait so
    //    the suspended frame (which pins appCtx and, through its captured
    //    module scopes, the ENTIRE session module graph) can complete and be
    //    collected instead of leaking ~one renderer per restart.
    if (!windowClosed) {
      await new Promise<void>((resolve) => {
        const tracker = (globalThis as any).__ddSession;
        const s = tracker?.session;
        // Our session dead/absent/superseded (restart landed during boot):
        // resolve now — both the close listener and an onDispose registration
        // would be dropped by the tracker, leaving this frame parked forever.
        if (tracker && (!s || s.dead || (bootSession && s !== bootSession))) return resolve();
        window.addEventListener("close", () => { windowClosed = true; resolve(); });
        tracker?.onDispose?.(() => resolve());
      });
    }
    log.info("native-app-module", windowClosed ? "Window closed" : "Session ended");
  } finally {
    if (!windowClosed) {
      // Session teardown (Tier 3/4 restart): the window, host, and shared
      // GPU devices are persistent-layer — the supervisor owns their
      // lifecycle. Just join the in-flight teardown so this frame finishes
      // after workers/sims are down.
      try {
        await (globalThis as any).__ddSession?.teardown?.({ destroyDevices: false });
      } catch { /* dev shell absent or already down */ }
    } else {
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
      const sim: any = appCtx?.sim ?? createdSim;
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
            log.warn("native-app-module", "sim stop timed out (2s) — terminating");
            try { sim?.terminate?.(); } catch { /* already dead */ }
          }
        }
      } catch { /* worker already gone */ }
      try { await retire; } catch { /* bounded best-effort */ }
      try { host.destroy(); } catch { /* already torn down */ }
    }
  }
}

// Re-export for convenience — bespoke native entries that still need the
// low-level path keep using startNativeApp/createNativeHost directly.
export { startNativeMcpServer };
