// ============================================================================
// Sim Bridge — provides a unified API for UI components to communicate with
// the simulation Web Worker and the Electron main process.
// Replaces the old ocean.* IPC API for sim-related calls.
// ============================================================================

import type { SimWebWorker } from "./engine/sim-web-worker";

function getSimWorker(): SimWebWorker | null {
  return (window as any).__simWorker ?? null;
}

function getDowndraft(): any {
  return (window as any).downdraft;
}

function getRenderer(): any {
  return (window as any).__renderer ?? null;
}

export const simBridge = {
  // --- Save/Load ---
  async saveGame(slotName: string): Promise<boolean> {
    const worker = getSimWorker();
    if (!worker) return false;
    const result = await worker.save(slotName);
    if (result?.stateJson) {
      const dd = getDowndraft();
      if (dd?.saveGameState) {
        // Merge renderer meta into the component-section state
        let components = JSON.parse(result.stateJson);
        const renderer = getRenderer();
        if (renderer?.serializeRendererMeta) {
          components.renderer = { v: 1, data: renderer.serializeRendererMeta() };
        }
        return dd.saveGameState(slotName, JSON.stringify(components));
      }
    }
    return false;
  },

  async loadGame(slotName: string): Promise<boolean> {
    const dd = getDowndraft();
    if (!dd?.loadGameState) return false;
    const stateJson = await dd.loadGameState(slotName);
    if (!stateJson) return false;
    const worker = getSimWorker();
    if (!worker) return false;
    const ok = await worker.load(slotName, stateJson);
    // Restore renderer meta if present
    if (ok) {
      try {
        const components = JSON.parse(stateJson);
        if (components.renderer?.data) {
          const renderer = getRenderer();
          if (renderer?.restoreRendererMeta) {
            renderer.restoreRendererMeta(components.renderer.data);
          }
        }
      } catch {
        // ignore parse errors
      }
    }
    return ok;
  },

  // --- Player ---
  respawnPlayer(playerId: number): void {
    getSimWorker()?.respawnPlayer(playerId);
  },

  // --- Pause/Resume ---
  pauseGame(): void {
    getSimWorker()?.pause();
  },

  resumeGame(): void {
    getSimWorker()?.resume();
  },

  // --- Commands ---
  sendCommand(cmd: any): void {
    getSimWorker()?.sendCommand(cmd);
  },

  sendWorldCommand(cmd: any): void {
    getSimWorker()?.sendWorldCommand(cmd);
  },

  // --- Settings ---
  setSetting(key: string, value: number | boolean): void {
    getSimWorker()?.setSetting(key, value);
  },

  setGamemode(mode: number): void {
    getSimWorker()?.setGamemode(mode);
  },

  // --- Weather/Time ---
  setWeather(weatherType: number): void {
    getSimWorker()?.setWeather(weatherType);
  },

  setTimeOfDay(time: number): void {
    getSimWorker()?.setTimeOfDay(time);
  },

  setSimSpeed(speed: number): void {
    getSimWorker()?.setSimSpeed(speed);
  },

  setPhysicsProfiler(enabled: boolean): void {
    getSimWorker()?.setPhysicsProfiler(enabled);
  },

  async getSimSpeed(): Promise<number> {
    const worker = getSimWorker();
    if (!worker) return 1.0;
    return worker.getSimSpeed();
  },

  // --- Debug ---
  setDebugMode(enabled: boolean): void {
    getSimWorker()?.setDebugMode(enabled);
    getDowndraft()?.setDebugMode(enabled);
  },

  // --- App (still via IPC) ---
  quit(): void {
    getDowndraft()?.quit();
  },

  toggleDevtools(): void {
    getDowndraft()?.toggleDevtools();
  },

  toggleFullscreen(): void {
    getDowndraft()?.toggleFullscreen();
  },

  // --- Reset (reload the page to restart sim) ---
  resetGame(): void {
    window.location.reload();
  },
};
