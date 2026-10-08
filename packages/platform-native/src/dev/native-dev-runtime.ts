// ============================================================================
// native-dev-runtime.ts — the in-runner half of the native dev shell
//
// This module is evaluated by the Vite ModuleRunner inside the dev-shell
// process (see dev-shell.mjs). It runs once per supervisor boot — and once
// per session restart — and owns:
//
//   - the __ddSession tracker (timers/listeners/workers/devices bookkeeping)
//   - the __ddHmr control surface (game/engine code calls these to escalate)
//   - import.meta.hot listeners that map vite HMR payloads onto the tiered
//     reload pipeline (beforeFullReload → session teardown → re-import)
//
// Reload tiers handled here:
//   Tier 1  — directed module update: vite applies it internally; we only
//             observe afterUpdate/vite:error for status + escalation.
//   Tier 2  — "sim:hot-reload" custom event: swap registered sim workers.
//   Tier 3  — vite "full-reload": saveState → session teardown → supervisor
//             re-imports runtime + entry (window/device/bridge survive).
//   Tier 4  — "dd:host-restart" custom event: teardown + host.destroy() +
//             global reset → supervisor clearCache + re-import.
//   Tier 5  — supervisor-side process exit (DD_RESTART_EXIT); not handled here.
// ============================================================================

import { createGlob } from "@downdraft/engine/platform/glob-polyfill";
import {
    CONFIG_KEY,
    EV,
    HMR_KEY,
    HOST_GLOBALS,
    LISTENERS_FLAG,
    SUPERVISOR_KEY,
} from "./dev-constants.mjs";
import { installSessionTracker, type SessionTracker } from "./session-tracker";

const g = globalThis as any;
const cfg = g[CONFIG_KEY] ?? {};
const sup = g[SUPERVISOR_KEY];
const hot = (import.meta as any).hot;

const session: SessionTracker = installSessionTracker();
session.beginSession();

// ── Early host boot ─────────────────────────────────────────────────────────
// The dev shell's biggest perceived-boot win: downdraft.config.json's
// "native" block declares the window/appId the entry will ask for, so we
// kick the slim early boot NOW — window + GPU device land while the
// (multi-second) entry-graph transform/eval is still running. The promise
// resolves with EarlyHostParts; the entry's own createNativeHost() call
// awaits + adopts them (see native-host.ts) — there is exactly ONE
// createNativeHost call, so no adoption race exists. Games without a
// "native" block — bespoke entries like gpu-bench — keep the old boot shape.
if (!g.__ddEarlyHostPromise && !g.__nativeHost && cfg.gameConfig?.native) {
  g.__ddEarlyHostPromise = startEarlyHost(cfg.gameConfig).catch((e: any) => {
    logError(`early host boot failed (entry will create its own): ${e?.message ?? e}`);
    return null;
  });
}

async function startEarlyHost(gameConfig: any): Promise<any> {
  const n = gameConfig.native ?? {};
  try {
    const { bootEarlyHost } = await import("./early-host");
    const parts = await bootEarlyHost({
      window: {
        title: n.title ?? gameConfig.name ?? "Downdraft",
        width: n.width ?? 1280,
        height: n.height ?? 720,
        focused: n.focused,
      },
      appId: n.appId,
      splash: n.splash,
    });
    return parts;
  } catch (e) {
    logError(`early slim boot failed: ${(e as any)?.message ?? e}`);
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function logInfo(msg: string): void {
  sup?.log?.("hmr", msg);
}

function logError(msg: string): void {
  sup?.log?.("hmr", `ERROR ${msg}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  let timer: any;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((_, rej) => {
        // Untracked scheduling — saveAndTeardown's bounds wrap the session
        // teardown itself; a tracked setTimeout would be cancelled BY that
        // teardown, silently removing the bound it exists to enforce.
        if (typeof session.untrackedTimeout === "function") {
          timer = session.untrackedTimeout(() => rej(new Error(`${label} timed out`)), ms);
        } else {
          timer = (setTimeout as any)(() => rej(new Error(`${label} timed out`)), ms);
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Save state + tear down the session. GPU devices are NEVER destroyed here:
 *  the shared host device is created lazily (first requestDevice), i.e.
 *  after the tracker's baseline snapshot — destroying it while the native
 *  poll loop iterates live devices is a use-after-destroy that aborts the
 *  process inside wgpu-core. Devices only die with the host (Tier 4/5). */
async function saveAndTeardown(): Promise<void> {
  try {
    await withTimeout(session.saveState(), 3000, "saveState");
  } catch (e) {
    logError(`saveState failed (continuing without state): ${e}`);
  }
  try {
    // Generous outer bound — teardownInner already bounds each dispose
    // callback and sim stop, so this only guards a truly wedged teardown.
    // It must not be SHORT: reimporting while teardown still runs makes
    // the new session register into the dying snapshot (now guarded by
    // session.dead, but overlapping render loops are still wasteful).
    await withTimeout(session.teardown({ destroyDevices: false }), 45_000, "session teardown");
  } catch (e) {
    logError(`teardown failed (continuing): ${e}`);
  }
}

function destroyHostLayer(): void {
  try { g.__nativeHost?.destroy?.(); } catch { /* already down */ }
  HOST_GLOBALS.forEach((key) => {
    try { delete g[key]; } catch { g[key] = undefined; }
  });
  try { if (g.navigator) g.navigator.gpu = undefined; } catch { /* getter-only */ }
  session.resetTrackedTargets();
}

// ── import.meta.glob shim ──────────────────────────────────────────────────
// The meta-glob-shim transform rewrites non-literal `import.meta.glob`
// references into `__ddImportMetaGlob(import.meta)`. Resolve the caller's
// directory from its file:// URL and hand back a filesystem glob matching
// the bun-native createGlob contract.
if (typeof g.__ddImportMetaGlob !== "function") {
  g.__ddImportMetaGlob = (meta: { url?: string }) => {
    let dir = ".";
    try {
      dir = decodeURIComponent(new URL(".", meta.url ?? "").pathname);
    } catch { /* non-file url — cwd fallback */ }
    return createGlob(dir);
  };
}

// ── __ddHmr — the game/engine-facing control surface ────────────────────────
// Installed once; closures only touch globals so they stay valid across
// session re-evals.

g[HMR_KEY] ??= {
  /** Restart the game session in-process (state-preserving). */
  restartSession(reason?: string): void {
    sup?.requestSessionRestart?.(reason ?? "explicit restartSession()");
  },
  /** Destroy + recreate the native host (window/device/bridge/MCP). */
  restartHost(reason?: string): void {
    sup?.requestHostRestart?.(reason ?? "explicit restartHost()");
  },
  /** Full process restart via the CLI respawn loop. */
  restartProcess(reason?: string): void {
    sup?.requestProcessRestart?.(reason ?? "explicit restartProcess()");
  },
  /** Direct session teardown (diagnostics/tests). */
  teardownSession(): Promise<void> {
    return saveAndTeardown();
  },
};

// ── import.meta.hot listeners (registered once — vite's customListeners
//    survive the evaluatedModules.clear() that full-reload performs; the
//    supervisor resets the flag when it uses runner.clearCache()) ─────────────

if (hot && !g[LISTENERS_FLAG]) {
  g[LISTENERS_FLAG] = true;

  // Tier 3 entry point: vite decided the change graph dead-ends (no accept
  // boundary) → save state, tear the session down, let the supervisor
  // re-import after the module cache clears.
  //
  // This listens on a custom event — NOT vite's "full-reload" payload. The
  // dev shell remaps full-reload → EV.sessionRestart at the env.hot.send
  // seam because vite's runner-side full-reload handler awaits
  // runner.import(entrypoint), which stays pending for the session's whole
  // lifetime (blocking entries top-level-await the run loop) — and the
  // runner serializes ALL hot-channel messages behind it, dead-lettering
  // every later sim-swap/full-reload.
  //
  // Reentrancy guard: the listener returns immediately (the custom-event
  // notify is awaited inside vite's message queue — a pending teardown
  // would re-block the channel) and overlaps are coalesced.
  let restartInFlight: Promise<void> | null = null;
  const beginSessionRestart = (label: string) => {
    if (restartInFlight) return;
    logInfo(label);
    // Arm the supervisor's fallback watchdog — vite-internal full-reloads
    // never pass through its sendFullReload, so the runtime must announce
    // the restart itself.
    sup?.sessionRestartStarted?.();
    restartInFlight = (async () => {
      try {
        // A sim swap already in flight must settle before teardown walks
        // the sims — otherwise both paths interleave stop/respawn on the
        // same host. Bounded: a wedged worker can't stall teardown.
        if (swapInFlight) {
          await Promise.race([
            swapInFlight,
            new Promise<void>((r) => setTimeout(r, 10_000)),
          ]);
        }
        await saveAndTeardown();
      } finally {
        sup?.sessionRestartReady?.();
      }
    })().finally(() => { restartInFlight = null; });
  };
  hot.on(EV.sessionRestart, (data: any) => {
    beginSessionRestart(`session restart (unhandled module change${data?.triggeredBy ? `: ${data.triggeredBy}` : ""})`);
  });
  // Compatibility: if a full-reload payload ever bypasses the channel
  // remap (alternate transport), handle it the same way.
  hot.on("vite:beforeFullReload", () => {
    beginSessionRestart("session restart (vite:beforeFullReload)");
  });

  // Tier 2: sim-classified file → worker swap on all registered sims.
  // Swaps are heavyweight (save → terminate → respawn → restore) and MUST
  // NOT overlap — two racing pipelines interleave stop/start on the same
  // host and orphan workers. Events arriving mid-swap are coalesced into a
  // single trailing swap (the first respawn may have fetched modules before
  // a later write landed); intermediate updateIds are acked immediately so
  // the supervisor doesn't escalate them to session restarts.
  async function performSimSwap(updateId: any): Promise<void> {
    let preserve = true;
    let store: any = null;
    try {
      // Read the shared hot-reload store when the engine is in the graph.
      const eng = await import("@downdraft/engine/stores/hot-reload-store");
      store = (eng as any).useHotReloadStore?.getState?.() ?? null;
      preserve = store?.preserveState ?? true;
    } catch { /* engine not loaded — default preserve */ }
    try {
      store?.setStatus?.("reloading");
      const swapped = await session.hotReloadSims(preserve);
      hot.send(EV.simHotReloadAck, { updateId, swapped });
      logInfo(`sim worker swap complete (${swapped} worker${swapped === 1 ? "" : "s"})`);
      store?.setStatus?.("ready");
      if (swapped === 0) {
        sup?.requestSessionRestart?.("sim file changed but no sim worker registered");
      }
    } catch (e) {
      hot.send(EV.simHotReloadAck, { updateId, swapped: 0, error: String(e) });
      store?.setStatus?.("error", (e as Error)?.message ?? String(e));
      sup?.requestSessionRestart?.(`sim hot reload failed: ${(e as Error)?.message ?? e}`);
    }
  }

  let swapRunning = false;
  let swapInFlight: Promise<void> | null = null;
  const swapQueue: any[] = [];
  const onSimHotReload = (data: any) => {
    // A session teardown owns the sims — a swap racing it would interleave
    // stop/respawn on dying workers ("sim restore failed: Worker
    // terminated"). Ack and drop; the session restart re-imports fresh.
    if (restartInFlight) {
      hot.send(EV.simHotReloadAck, { updateId: data?.updateId, swapped: 0, superseded: true });
      return;
    }
    if (swapRunning) {
      swapQueue.push(data?.updateId);
      return;
    }
    swapRunning = true;
    swapInFlight = performSimSwap(data?.updateId).finally(() => {
      swapInFlight = null;
      swapRunning = false;
      while (swapQueue.length > 1) {
        hot.send(EV.simHotReloadAck, { updateId: swapQueue.shift(), swapped: 0, coalesced: true });
      }
      if (swapQueue.length) onSimHotReload({ updateId: swapQueue.shift() });
    });
  };
  hot.on(EV.simHotReload, onSimHotReload);

  // Legacy renderer classification → session restart (save included).
  hot.on(EV.rendererHotReload, async (data: any) => {
    sup?.requestSessionRestart?.(`renderer file changed: ${data?.file ?? "?"}`);
  });

  // Tier 4: persistent-layer change → teardown + destroy host + reset globals.
  hot.on(EV.hostRestart, async () => {
    logInfo("host restart (platform-native change)");
    await saveAndTeardown();
    // Workers are stopped — wait (bounded) for shared-device views to detach
    // before host.destroy() frees the handles they call into.
    try { await g.__ddRetireSharedDevices?.(1_500); } catch { /* bounded + best-effort */ }
    destroyHostLayer();
    sup?.hostRestartReady?.();
  });

  // Update/transform failure → report only. Vite already rejected the
  // update; restarting the session on a transient syntax error would
  // crash-loop the game while the developer is mid-typing.
  hot.on("vite:error", (payload: any) => {
    const msg = payload?.err?.message ?? payload?.message ?? String(payload);
    logError(`vite update error: ${msg}`);
  });

  hot.on("vite:afterUpdate", () => {
    logInfo("module update applied");
  });
}

export { session };
