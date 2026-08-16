// ============================================================================
// Sim Bridge — provides a unified API for UI components to communicate with
// the simulation Web Worker and the Electron main process.
// Replaces the old ocean.* IPC API for sim-related calls.
//
// Created via createSimBridge(deps) and stored in the game-store. Consumers
// read it from the store: useGameStore((s) => s.simBridge).
// ============================================================================

import type { DowndraftBridge } from "@downdraft/app/renderer";
import type { ISaveStore, SaveOptions, SaveState } from "@downdraft/core";
import type { ISimWorker } from "./engine/sim-web-worker";

/**
 * Renderer methods used by the bridge for save/load meta serialization.
 * Subset of WebGPURenderer — extracted so the bridge depends on an interface.
 */
export interface IRendererMeta {
  serializeRendererMeta(): Record<string, unknown>;
  restoreRendererMeta(meta: Record<string, unknown>): void;
}

export interface SimBridgeDeps {
  worker: ISimWorker;
  renderer: IRendererMeta;
  downdraft: DowndraftBridge;
  /** Optional save store (OPFS or dedicated worker). When provided, saves bypass IPC. */
  saveStore?: ISaveStore | null;
  /** Save mode: "inline" (worker has OPFS store), "worker" (dedicated save store), "ipc" (Electron bridge). Default: "ipc". */
  saveMode?: "inline" | "worker" | "ipc";
}

export interface SimBridge {
  // --- Save/Load ---
  saveGame(slotName: string, opts?: SaveOptions): Promise<boolean>;
  loadGame(slotName: string): Promise<boolean>;

  // --- Player ---
  respawnPlayer(playerId: number): void;

  // --- Pause/Resume ---
  pauseGame(): void;
  resumeGame(): void;

  // --- Commands ---
  sendCommand(cmd: any): void;
  sendWorldCommand(cmd: any): void;

  // --- Settings ---
  setSetting(key: string, value: number | boolean): void;
  setGamemode(mode: number): void;

  // --- Weather/Time ---
  setWeather(weatherType: number): void;
  setTimeOfDay(time: number): void;
  setSimSpeed(speed: number): void;

  setPhysicsProfiler(enabled: boolean): void;
  setGCConfig(config: any): void;

  getWorkerGCStats(): Promise<any>;
  forceWorkerMajorGC(): void;
  getSimSpeed(): Promise<number>;

  // --- Debug ---
  setDebugMode(enabled: boolean): void;

  // --- App (still via IPC) ---
  quit(): void;
  toggleDevtools(): void;
  toggleFullscreen(): void;

  // --- Reset (reload the page to restart sim) ---
  resetGame(): void;
}

/**
 * Creates a SimBridge bound to the given dependencies.
 * Called once in main.tsx after the worker and renderer are initialized.
 */
export function createSimBridge(deps: SimBridgeDeps): SimBridge {
  const { worker, renderer, downdraft, saveStore, saveMode = "ipc" } = deps;

  return {
    // --- Save/Load ---
    async saveGame(slotName: string, opts?: SaveOptions): Promise<boolean> {
      const mergedOpts: SaveOptions = { ...opts };

      // If we have a dedicated save store (worker mode), serialize in the
      // sim worker, then write to the SaveWorkerProxy (dedicated save worker).
      if (saveMode === "worker" && saveStore) {
        const result = await worker.save(slotName, mergedOpts);
        if (!result?.stateJson) return false;
        const components = JSON.parse(result.stateJson);
        if (renderer.serializeRendererMeta) {
          components.renderer = { v: 1, data: renderer.serializeRendererMeta() };
        }
        const state: SaveState = {
          components,
          meta: {
            engineVersion: (mergedOpts.properties?.engineVersion as string) ?? "0.1.0",
            timestamp: Date.now() / 1000,
            entityCount: 0,
            playerCount: 0,
          },
        };
        const saveResult = await saveStore.save(slotName, state, mergedOpts);
        return saveResult.success;
      }

      // Inline mode: worker has its own OpfsSaveStore, just pass opts
      if (saveMode === "inline") {
        const result = await worker.save(slotName, mergedOpts);
        return result?.success ?? false;
      }

      // IPC fallback: worker returns stateJson, send via bridge
      const result = await worker.save(slotName, mergedOpts);
      if (result?.stateJson) {
        if (downdraft.saveGameState) {
          const components = JSON.parse(result.stateJson);
          if (renderer.serializeRendererMeta) {
            components.renderer = { v: 1, data: renderer.serializeRendererMeta() };
          }
          return downdraft.saveGameState(slotName, JSON.stringify(components), mergedOpts);
        }
      }
      return false;
    },

    async loadGame(slotName: string): Promise<boolean> {
      // If we have a dedicated save store, load from it
      if (saveMode === "worker" && saveStore) {
        const loadResult = await saveStore.load(slotName);
        if (!loadResult.state) return false;
        const stateJson = JSON.stringify(loadResult.state.components);
        const ok = await worker.load(slotName, stateJson);
        if (ok && renderer.restoreRendererMeta) {
          try {
            const components = JSON.parse(stateJson);
            if (components.renderer?.data) {
              renderer.restoreRendererMeta(components.renderer.data);
            }
          } catch { /* ignore */ }
        }
        return ok;
      }

      // Inline mode: worker loads from its own OPFS store
      if (saveMode === "inline") {
        return worker.load(slotName);
      }

      // IPC fallback: load from downdraft bridge
      if (!downdraft.loadGameState) return false;
      const stateJson = await downdraft.loadGameState(slotName);
      if (!stateJson) return false;
      const loaded = await worker.load(slotName, stateJson);
      if (loaded) {
        try {
          const components = JSON.parse(stateJson);
          if (components.renderer?.data) {
            if (renderer.restoreRendererMeta) {
              renderer.restoreRendererMeta(components.renderer.data);
            }
          }
        } catch {
          // ignore parse errors
        }
      }
      return loaded;
    },

    // --- Player ---
    respawnPlayer(playerId: number): void {
      worker.respawnPlayer(playerId);
    },

    // --- Pause/Resume ---
    pauseGame(): void {
      worker.pause();
    },

    resumeGame(): void {
      worker.resume();
    },

    // --- Commands ---
    sendCommand(cmd: any): void {
      worker.sendCommand(cmd);
    },

    sendWorldCommand(cmd: any): void {
      worker.sendWorldCommand(cmd);
    },

    // --- Settings ---
    setSetting(key: string, value: number | boolean): void {
      worker.setSetting(key, value);
    },

    setGamemode(mode: number): void {
      worker.setGamemode(mode);
    },

    // --- Weather/Time ---
    setWeather(weatherType: number): void {
      worker.setWeather(weatherType);
    },

    setTimeOfDay(time: number): void {
      worker.setTimeOfDay(time);
    },

    setSimSpeed(speed: number): void {
      worker.setSimSpeed(speed);
    },

    setPhysicsProfiler(enabled: boolean): void {
      worker.setPhysicsProfiler(enabled);
    },

    setGCConfig(config: any): void {
      worker.setGCConfig(config);
    },

    async getWorkerGCStats(): Promise<any> {
      return worker.getGCStats();
    },

    forceWorkerMajorGC(): void {
      worker.forceMajorGC();
    },

    async getSimSpeed(): Promise<number> {
      return worker.getSimSpeed();
    },

    // --- Debug ---
    setDebugMode(enabled: boolean): void {
      worker.setDebugMode(enabled);
      downdraft.setDebugMode(enabled);
    },

    // --- App (still via IPC) ---
    quit(): void {
      downdraft.quit();
    },

    toggleDevtools(): void {
      downdraft.toggleDevtools();
    },

    toggleFullscreen(): void {
      downdraft.toggleFullscreen();
    },

    // --- Reset (reload the page to restart sim) ---
    resetGame(): void {
      window.location.reload();
    },
  };
}
