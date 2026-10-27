// ============================================================================
// createSimBridge — shared renderer-side facade over the sim worker + app bridge.
//
// Generalized from an app's sim-bridge. The reusable kernel is the
// three-mode save/load orchestration:
//   - "worker": the sim worker owns its save store — just RPC.
//   - "worker": worker serializes to stateJson, renderer writes it to a
//     dedicated ISaveStore, grafting in renderer metadata.
//   - "host": worker serializes to stateJson, renderer writes it to the
//     host's typed save store (downdraft.saveStore — HostSaveStore on
//     native). The JSON-string bridge methods are only a fallback when the
//     host exposes no typed store.
//
// App-specific command verbs (respawnPlayer, setWeather, sendCommand, ...)
// stay in the app's own bridge — extend this object:
//   return { ...createSimBridge(deps), respawnPlayer: (id) => worker.respawnPlayer(id) };
// ============================================================================

import type { IRendererStateProvider, ISaveStore, LoadOptions, SaveMeta, SaveOptions, SaveState } from "@downdraft/engine";
import { downdraft, type Host } from "./index";

/** Minimal worker surface needed by the bridge (pause/resume/save/load). */
export interface SimBridgeWorker {
  save(
    slotName: string,
    opts?: SaveOptions,
  ): Promise<{ slotName?: string; stateJson?: string; success?: boolean; gen?: number; meta?: SaveMeta } | null | undefined>;
  load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean>;
  pause(): void;
  resume(): void;
}

export interface SimBridgeDeps {
  worker: SimBridgeWorker;
  /** Optional renderer meta provider — grafted into saves as components.renderer. */
  renderer?: IRendererStateProvider | null;
  /** App bridge — defaults to the globalThis.downdraft singleton (or its stub). */
  downdraft?: Host | null;
  /** Optional save store (the host's typed store). When provided, saves bypass the JSON bridge methods. */
  saveStore?: ISaveStore | null;
  /** Save mode: "host" (caller owns the store — typed saveStore when present,
   *  else the bridge's JSON methods), "worker" (the sim worker owns
   *  persistence itself — e.g. a DirectorySaveStore inside the worker; its
   *  save()/load() persist directly). Default: "host". */
  saveMode?: "host" | "worker";
}

/** Generic sim bridge — save/load + pause/resume + app window controls. */
export interface SimBridge {
  saveApp(slotName: string, opts?: SaveOptions): Promise<boolean>;
  loadApp(slotName: string): Promise<boolean>;
  pauseSim(): void;
  resumeSim(): void;
  quit(): void;
  toggleDevtools(): void;
  toggleFullscreen(): void;
  /** Reload the page to restart the sim. */
  resetSim(): void;
}

export function createSimBridge(deps: SimBridgeDeps): SimBridge {
  const { worker, renderer, saveStore, saveMode = "host" } = deps;
  // Resolve the app bridge lazily — callers may omit it (defaults to the
  // globalThis.downdraft singleton / stub from this package's index).
  const bridge = () => deps.downdraft ?? downdraft;

  return {
    async saveApp(slotName: string, opts?: SaveOptions): Promise<boolean> {
      const mergedOpts: SaveOptions = { ...opts };

      // Typed save store path (the host's HostSaveStore): serialize in the
      // sim worker, then write to the store.
      if (saveMode === "host" && saveStore) {
        const result = await worker.save(slotName, mergedOpts);
        if (!result?.stateJson) return false;
        const components = JSON.parse(result.stateJson);
        if (renderer?.serializeRendererMeta) {
          components.renderer = { v: 1, data: renderer.serializeRendererMeta() };
        }
        const state: SaveState = {
          components,
          meta: {
            engineVersion: (mergedOpts.properties?.engineVersion as string) ?? "0.1.0",
            timestamp: Date.now() / 1000,
            entityCount: 0,
            playerCount: 0,
            // Real SaveMeta computed by the worker's save.meta() hook wins.
            ...result.meta,
          },
        };
        const saveResult = await saveStore.save(slotName, state, mergedOpts);
        return saveResult.success;
      }

      // Worker-owned store: the sim worker's save() persists via its own
      // DirectorySaveStore — nothing crosses the bridge.
      if (saveMode === "worker") {
        const result = await worker.save(slotName, mergedOpts);
        return result?.success ?? false;
      }

      // Host fallback when no typed store is installed: worker returns
      // stateJson, send via the bridge's legacy JSON methods.
      const result = await worker.save(slotName, mergedOpts);
      if (result?.stateJson) {
        const dd = bridge();
        if (dd.saveAppState) {
          const components = JSON.parse(result.stateJson);
          if (renderer?.serializeRendererMeta) {
            components.renderer = { v: 1, data: renderer.serializeRendererMeta() };
          }
          return dd.saveAppState(slotName, JSON.stringify(components), mergedOpts);
        }
      }
      return false;
    },

    async loadApp(slotName: string): Promise<boolean> {
      // Typed save store: load from it directly.
      if (saveMode === "host" && saveStore) {
        const loadResult = await saveStore.load(slotName);
        if (!loadResult.state) return false;
        const stateJson = JSON.stringify(loadResult.state.components);
        const ok = await worker.load(slotName, stateJson);
        if (ok && renderer?.restoreRendererMeta) {
          try {
            const components = JSON.parse(stateJson);
            if (components.renderer?.data) {
              renderer.restoreRendererMeta(components.renderer.data);
            }
          } catch { /* ignore */ }
        }
        return ok;
      }

      // Worker-owned store: the sim worker loads from its own store.
      if (saveMode === "worker") {
        return worker.load(slotName);
      }

      // Host fallback: load through the bridge's legacy JSON methods.
      const dd = bridge();
      if (!dd.loadAppState) return false;
      const stateJson = await dd.loadAppState(slotName);
      if (!stateJson) return false;
      const loaded = await worker.load(slotName, stateJson);
      if (loaded) {
        try {
          const components = JSON.parse(stateJson);
          if (components.renderer?.data) {
            renderer?.restoreRendererMeta?.(components.renderer.data);
          }
        } catch {
          // ignore parse errors
        }
      }
      return loaded;
    },

    pauseSim(): void {
      worker.pause();
    },

    resumeSim(): void {
      worker.resume();
    },

    quit(): void {
      void bridge().quit();
    },

    toggleDevtools(): void {
      bridge().toggleDevtools();
    },

    toggleFullscreen(): void {
      bridge().toggleFullscreen();
    },

    resetSim(): void {
      // Host-owned restart on native (detached self-respawn); DOM hosts
      // reload the page.
      if (bridge().requestRestart?.("app reset")) return;
      window.location.reload();
    },
  };
}
