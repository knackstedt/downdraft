// ============================================================================
// Sim Bridge — provides a unified API for UI components to communicate with
// the simulation Web Worker and the Electron main process.
// Replaces the old ocean.* IPC API for sim-related calls.
// ============================================================================

import type { SimWebWorker } from "./engine/SimWebWorker";

function getSimWorker(): SimWebWorker | null {
  return (window as any).__simWorker ?? null;
}

function getOcean(): any {
  return (window as any).ocean;
}

export const simBridge = {
  // --- Save/Load ---
  async saveGame(slotName: string): Promise<boolean> {
    const worker = getSimWorker();
    if (!worker) return false;
    const result = await worker.save(slotName);
    if (result?.stateJson) {
      const ocean = getOcean();
      if (ocean?.saveGameState) {
        return ocean.saveGameState(slotName, result.stateJson);
      }
    }
    return false;
  },

  async loadGame(slotName: string): Promise<boolean> {
    const ocean = getOcean();
    if (!ocean?.loadGameState) return false;
    const stateJson = await ocean.loadGameState(slotName);
    if (!stateJson) return false;
    const worker = getSimWorker();
    if (!worker) return false;
    return worker.load(slotName, stateJson);
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

  async getSimSpeed(): Promise<number> {
    const worker = getSimWorker();
    if (!worker) return 1.0;
    return worker.getSimSpeed();
  },

  // --- Debug ---
  setDebugMode(enabled: boolean): void {
    getSimWorker()?.setDebugMode(enabled);
    getOcean()?.setDebugMode(enabled);
  },

  // --- App (still via IPC) ---
  quit(): void {
    getOcean()?.quit();
  },

  toggleDevtools(): void {
    getOcean()?.toggleDevtools();
  },

  toggleFullscreen(): void {
    getOcean()?.toggleFullscreen();
  },

  // --- Reset (reload the page to restart sim) ---
  resetGame(): void {
    window.location.reload();
  },
};
