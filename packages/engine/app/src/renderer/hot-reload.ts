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
import { createLogger } from "@downdraft/engine/util/logger";
import { downdraft, type Host } from "./index";

const log = createLogger("info");

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
  downdraft?: Host | null;
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
  const bridge = () => deps.downdraft ?? downdraft;
  const getConfig = () =>
    typeof deps.simConfig === "function" ? (deps.simConfig as () => unknown)() : deps.simConfig;

  // Native dev shell: the in-runner runtime (@downdraft/platform-native
  // dev/native-dev-runtime) owns the single sim:hot-reload / renderer:
  // hot-reload handler set, fanning out over the __ddSession registry.
  // Registering hot.on here too would fire the swap twice. Contribute the
  // sim handle + renderer meta provider to the session instead.
  const session = (globalThis as any).__ddSession;
  if (session) {
    if (deps.sim?.hotReload && !session.hasSimFor?.(deps.sim)) {
      session.registerSim?.({
        label: "game-sim",
        host: deps.sim,
        hotReload: (preserve: boolean) => deps.sim.hotReload!(getConfig(), preserve),
        save: async () => (await deps.sim.save?.(SLOT))?.stateJson ?? null,
        restore: (json: string) => deps.sim.restoreFromState?.(json),
      });
    }
    if (deps.renderer?.serializeRendererMeta) {
      const renderer = deps.renderer;
      session.registerMetaProvider?.({
        serialize: () => renderer.serializeRendererMeta!(),
        restore: (meta: unknown) => renderer.restoreRendererMeta?.(meta as Record<string, unknown>),
      });
    }
    return;
  }

  // Cast: bun-types' ImportMeta augmentation can shadow vite/client's HMR
  // typing when both are in the program (node config). This code is
  // Vite-specific, so pin the subset of the vite HMR surface we use.
  const hot = import.meta.hot as unknown as {
    on(event: string, cb: (data: any) => void): void;
    send(event: string, data?: any): void;
  };

  hot.on("sim:hot-reload", async (data: { file: string; timestamp: number }) => {
    const store = useHotReloadStore.getState();
    if (!store.enabled) return;
    hot.send("sim:hot-reload:ack", {});
    log.info("HMR", `Sim file changed: ${data.file}`);
    store.setStatus("reloading");
    const t0 = performance.now();
    try {
      await deps.sim.hotReload?.(getConfig(), store.preserveState);
      const elapsed = (performance.now() - t0).toFixed(0);
      log.info("HMR", `Sim worker swap complete (${elapsed}ms)`);
      store.setStatus("ready");
      store.setLastReload({ file: data.file, elapsed: Number(elapsed), timestamp: data.timestamp });
    } catch (err) {
      log.error("HMR", `Sim hot-reload failed: ${(err as Error).message}`);
      store.setStatus("error", (err as Error).message);
      log.warn("HMR", "Falling back to full page reload");
      window.location.reload();
    }
  });

  hot.on("renderer:hot-reload", async (data: { file: string; timestamp: number }) => {
    const store = useHotReloadStore.getState();
    if (!store.enabled) return;
    hot.send("renderer:hot-reload:ack", {});
    log.info("HMR", `Renderer file changed: ${data.file}`);
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
          log.info("HMR", "State saved, reloading page...");
        }
      } catch (err) {
        log.warn("HMR", `State save failed, reloading without preservation: ${err}`);
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
  // Native dev shell: state restore is pushed by the session tracker
  // (notifySimStarted on sim start + registerMetaProvider for renderer
  // meta). If this sim was already restored, report success without a
  // second restore.
  const session = (globalThis as any).__ddSession;
  if (session?.wasRestored?.(deps.sim)) return true;
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
    log.info("HMR", "Restored state after page reload");
    if (dd.deleteGameState) dd.deleteGameState(SLOT);
    return true;
  } catch (err) {
    log.error("HMR", `Failed to restore hot-reload state: ${err}. Starting fresh.`);
    return false;
  }
}
