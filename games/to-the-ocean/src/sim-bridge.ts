// ============================================================================
// Sim Bridge — provides a unified API for UI components to communicate with
// the simulation Web Worker and the Electron main process.
// Replaces the old ocean.* IPC API for sim-related calls.
//
// The generic save/load + pause/resume + window-control surface comes from
// createSimBridge() in @downdraft/app/renderer. This file adds the
// tto-specific command verbs and keeps the historical SimBridgeDeps shape.
//
// Created via createSimBridge(deps) and stored in the game-store. Consumers
// read it from the store: useGameStore((s) => s.simBridge).
// ============================================================================

import type { DowndraftBridge } from "@downdraft/app/renderer";
import { createSimBridge as createEngineSimBridge, type SimBridge as EngineSimBridge } from "@downdraft/app/renderer";
import type { ISaveStore } from "@downdraft/core";
import type { ISimWorker } from "./engine/sim-web-worker";

export type { ISimWorker } from "./engine/sim-web-worker";

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

export interface SimBridge extends EngineSimBridge {
  // --- Player ---
  respawnPlayer(playerId: number): void;

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
}

/**
 * Creates a SimBridge bound to the given dependencies.
 * Called once in main.tsx after the worker and renderer are initialized.
 */
export function createSimBridge(deps: SimBridgeDeps): SimBridge {
  const { worker, downdraft } = deps;
  const base = createEngineSimBridge(deps);

  return {
    ...base,

    // --- Player ---
    respawnPlayer(playerId: number): void {
      worker.respawnPlayer(playerId);
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
  };
}
