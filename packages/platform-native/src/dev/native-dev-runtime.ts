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
        timer = (setTimeout as any)(() => rej(new Error(`${label} timed out`)), ms);
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
    await withTimeout(session.teardown({ destroyDevices: false }), 5000, "session teardown");
  } catch (e) {
    logError(`teardown failed (continuing): ${e}`);
  }
}

/** Globals installed by createNativeHost + friends — cleared on host restart
 *  so the next createNativeHost call rebuilds a clean persistent layer. */
const HOST_GLOBALS = [
  "__nativeHost", "__nativeWindow", "__nativeGpu", "__wgpuInstancePtr",
  "__nativeGlob", "downdraft", "__ddMcpHandler", "__ddRequestRestart",
  "__ddRequestFrame",
  "window", "document", "localStorage", "sessionStorage", "indexedDB",
  "requestAnimationFrame", "cancelAnimationFrame",
  "addEventListener", "removeEventListener", "dispatchEvent",
  "HTMLCanvasElement", "HTMLImageElement", "CanvasRenderingContext2D",
  "WebGLRenderingContext", "DOMParser", "FontFace", "FileReader",
  "DOMRect", "DOMRectReadOnly", "ResizeObserver", "IntersectionObserver",
  "KeyboardEvent", "MouseEvent", "PointerEvent", "WheelEvent",
  "InputEvent", "FocusEvent",
  "createImageBitmap", "ImageBitmap", "OffscreenCanvas", "ImageData", "Image",
];

function destroyHostLayer(): void {
  try { g.__nativeHost?.destroy?.(); } catch { /* already down */ }
  for (const key of HOST_GLOBALS) {
    try { delete g[key]; } catch { g[key] = undefined; }
  }
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
  hot.on("vite:beforeFullReload", async () => {
    logInfo("session restart (unhandled module change)");
    await saveAndTeardown();
    sup?.sessionRestartReady?.();
  });

  // Tier 2: sim-classified file → worker swap on all registered sims.
  hot.on(EV.simHotReload, async (data: any) => {
    const updateId = data?.updateId;
    let preserve = true;
    let store: any = null;
    try {
      // Read the shared hot-reload store when the engine is in the graph.
      const eng = await import("@downdraft/engine");
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
  });

  // Legacy renderer classification → session restart (save included).
  hot.on(EV.rendererHotReload, async (data: any) => {
    sup?.requestSessionRestart?.(`renderer file changed: ${data?.file ?? "?"}`);
  });

  // Tier 4: persistent-layer change → teardown + destroy host + reset globals.
  hot.on(EV.hostRestart, async () => {
    logInfo("host restart (platform-native change)");
    await saveAndTeardown();
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
