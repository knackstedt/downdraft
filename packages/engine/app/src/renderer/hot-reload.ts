// ============================================================================
// installSimHotReload / restoreHotReloadState — shared dev-mode HMR wiring.
//
// Generalized from to-the-ocean's main.tsx. The vite plugin emits
// "sim:hot-reload" / "renderer:hot-reload" custom events when watched sim or
// renderer files change. These helpers own the standard response:
//
//   sim:hot-reload      → sim.hotReload(config, preserveState) — save/stop/
//                         respawn/restore inside the running page.
//   renderer:hot-reload → save sim state (+ renderer meta) via the app bridge,
//                         set the "hot-reload-pending" session flag, reload.
//
// restoreHotReloadState() is the other half: call it during init to pick up
// the saved state after the page reload.
//
// Status is reported through the shared useHotReloadStore (devtools reads it).
// ============================================================================

import { isDevMode, useHotReloadStore, type IRendererStateProvider, type SaveOptions } from "@downdraft/engine";
import { downdraft, type DowndraftBridge } from "./index";

/** Minimal sim surface needed by the HMR handlers. */
export interface HotReloadableSim {
  hotReload?(config: unknown, preserveState: boolean): Promise<void>;
  save?(slotName: string, opts?: SaveOptions): Promise<{ stateJson?: string } | null>;
  restoreFromState?(stateJson: string): Promise<void>;
}

export interface SimHotReloadDeps {
  sim: HotReloadableSim;
  /** Renderer meta provider — grafted into the hot-reload save. */
  renderer?: IRendererStateProvider | null;
  /** Config passed to sim.hotReload(). May be a getter evaluated per reload. */
  simConfig: unknown | (() => unknown);
  /** App bridge — defaults to the window.downdraft singleton (or its stub). */
  downdraft?: DowndraftBridge | null;
}

const PENDING_KEY = "hot-reload-pending";
const SLOT = "hot-reload";

/**
 * Register the sim:hot-reload / renderer:hot-reload handlers.
 * No-op outside dev mode or when import.meta.hot is absent.
 * Call once from onReady (or equivalent) — safe to call again after HMR
 * re-mount because import.meta.hot.on dedupes per-module.
 */
export function installSimHotReload(deps: SimHotReloadDeps): void {
  if (!isDevMode || !import.meta.hot) return;
  const hot = import.meta.hot;
  const bridge = () => deps.downdraft ?? downdraft;
  const getConfig = () =>
    typeof deps.simConfig === "function" ? (deps.simConfig as () => unknown)() : deps.simConfig;

  hot.on("sim:hot-reload", async (data: { file: string; timestamp: number }) => {
    const store = useHotReloadStore.getState();
    if (!store.enabled) return;
    hot.send("sim:hot-reload:ack", {});
    console.log(`%c[HMR] Sim file changed: ${data.file}`, "color: cyan");
    store.setStatus("reloading");
    const t0 = performance.now();
    try {
      await deps.sim.hotReload?.(getConfig(), store.preserveState);
      const elapsed = (performance.now() - t0).toFixed(0);
      console.log(`%c[HMR] Sim worker swap complete (${elapsed}ms)`, "color: cyan; font-weight: bold");
      store.setStatus("ready");
      store.setLastReload({ file: data.file, elapsed: Number(elapsed), timestamp: data.timestamp });
    } catch (err) {
      console.error(`%c[HMR] Sim hot-reload failed: ${(err as Error).message}`, "color: red; font-weight: bold");
      store.setStatus("error", (err as Error).message);
      console.warn("[HMR] Falling back to full page reload");
      window.location.reload();
    }
  });

  hot.on("renderer:hot-reload", async (data: { file: string; timestamp: number }) => {
    const store = useHotReloadStore.getState();
    if (!store.enabled) return;
    hot.send("renderer:hot-reload:ack", {});
    console.log(`%c[HMR] Renderer file changed: ${data.file}`, "color: yellow");
    store.setStatus("reloading");
    if (store.preserveState) {
      try {
        const result = await deps.sim.save?.(SLOT);
        const dd = bridge();
        if (result?.stateJson && dd?.saveGameState) {
          const components = JSON.parse(result.stateJson);
          if (deps.renderer?.serializeRendererMeta) {
            components.renderer = { v: 1, data: deps.renderer.serializeRendererMeta() };
          }
          dd.saveGameState(SLOT, JSON.stringify(components));
          sessionStorage.setItem(PENDING_KEY, "1");
          console.log("[HMR] State saved, reloading page...");
        }
      } catch (err) {
        console.warn(`[HMR] State save failed, reloading without preservation: ${err}`);
      }
    }
    window.location.reload();
  });
}

/**
 * Restore sim state saved by the renderer:hot-reload handler. Call during
 * init (after the sim worker is started, before rendering). Returns true when
 * a pending state was found and restored.
 */
export async function restoreHotReloadState(
  deps: Pick<SimHotReloadDeps, "sim" | "renderer" | "downdraft">,
): Promise<boolean> {
  if (!sessionStorage.getItem(PENDING_KEY)) return false;
  sessionStorage.removeItem(PENDING_KEY);
  const dd = deps.downdraft ?? downdraft;
  if (!dd?.loadGameState) return false;
  try {
    const stateJson = await dd.loadGameState(SLOT);
    if (!stateJson) return false;
    await deps.sim.restoreFromState?.(stateJson);
    try {
      const components = JSON.parse(stateJson);
      if (components.renderer?.data) {
        deps.renderer?.restoreRendererMeta?.(components.renderer.data);
      }
    } catch { /* ignore */ }
    console.log("[HMR] Restored state after page reload");
    if (dd.deleteGameState) dd.deleteGameState(SLOT);
    return true;
  } catch (err) {
    console.error(`[HMR] Failed to restore hot-reload state: ${err}. Starting fresh.`);
    return false;
  }
}
