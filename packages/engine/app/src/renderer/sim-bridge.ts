// ============================================================================
// createSimBridge — shared renderer-side facade over the sim worker + app bridge.
//
// Generalized from to-the-ocean's sim-bridge.ts. The reusable kernel is the
// three-mode save/load orchestration:
//   - "inline": the sim worker owns its save store (e.g. OPFS) — just RPC.
//   - "worker": worker serializes to stateJson, renderer writes it to a
//     dedicated ISaveStore, grafting in renderer metadata.
//   - "host": worker serializes to stateJson, renderer writes it to the
//     host's typed save store (downdraft.saveStore — HostSaveStore on
//     native). The JSON-string bridge methods are only a fallback when the
//     host exposes no typed store.
//
// Game-specific command verbs (respawnPlayer, setWeather, sendCommand, ...)
// stay in the game's own bridge — extend this object:
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
  /** App bridge — defaults to the window.downdraft singleton (or its stub). */
  downdraft?: Host | null;
  /** Optional save store (OPFS worker proxy or the host's typed store). When provided, saves bypass the JSON bridge methods. */
  saveStore?: ISaveStore | null;
  /** Save mode: "inline" (worker has OPFS store), "worker" (dedicated save store), "host" (host save store / bridge). Default: "host". */
  saveMode?: "inline" | "worker" | "host";
}

/** Generic sim bridge — save/load + pause/resume + app window controls. */
export interface SimBridge {
  saveGame(slotName: string, opts?: SaveOptions): Promise<boolean>;
  loadGame(slotName: string): Promise<boolean>;
  pauseGame(): void;
  resumeGame(): void;
  quit(): void;
  toggleDevtools(): void;
  toggleFullscreen(): void;
  /** Reload the page to restart the sim. */
  resetGame(): void;
}

export function createSimBridge(deps: SimBridgeDeps): SimBridge {
  const { worker, renderer, saveStore, saveMode = "host" } = deps;
  // Resolve the app bridge lazily — callers may omit it (defaults to the
  // window.downdraft singleton / stub from this package's index).
  const bridge = () => deps.downdraft ?? downdraft;

  return {
    async saveGame(slotName: string, opts?: SaveOptions): Promise<boolean> {
      const mergedOpts: SaveOptions = { ...opts };

      // Typed save store path (dedicated OPFS worker proxy or the host's
      // HostSaveStore): serialize in the sim worker, then write to the store.
      if ((saveMode === "worker" || saveMode === "host") && saveStore) {
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

      // Inline mode: worker has its own OpfsSaveStore, just pass opts.
      if (saveMode === "inline") {
        const result = await worker.save(slotName, mergedOpts);
        return result?.success ?? false;
      }

      // Host fallback when no typed store is installed: worker returns
      // stateJson, send via the bridge's legacy JSON methods.
      const result = await worker.save(slotName, mergedOpts);
      if (result?.stateJson) {
        const dd = bridge();
        if (dd.saveGameState) {
          const components = JSON.parse(result.stateJson);
          if (renderer?.serializeRendererMeta) {
            components.renderer = { v: 1, data: renderer.serializeRendererMeta() };
          }
          return dd.saveGameState(slotName, JSON.stringify(components), mergedOpts);
        }
      }
      return false;
    },

    async loadGame(slotName: string): Promise<boolean> {
      // Typed save store: load from it directly.
      if ((saveMode === "worker" || saveMode === "host") && saveStore) {
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

      // Inline mode: worker loads from its own OPFS store.
      if (saveMode === "inline") {
        return worker.load(slotName);
      }

      // Host fallback: load through the bridge's legacy JSON methods.
      const dd = bridge();
      if (!dd.loadGameState) return false;
      const stateJson = await dd.loadGameState(slotName);
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

    pauseGame(): void {
      worker.pause();
    },

    resumeGame(): void {
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

    resetGame(): void {
      // Host-owned restart on native (detached self-respawn); DOM hosts
      // reload the page.
      if (bridge().requestRestart?.("game reset")) return;
      window.location.reload();
    },
  };
}
