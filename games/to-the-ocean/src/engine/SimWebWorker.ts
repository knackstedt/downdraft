// ============================================================================
// SimWebWorker — manages the simulation Web Worker from the renderer process
// Allocates SharedArrayBuffers, spawns the worker, and routes events.
// Replaces the main-process SimManager + IPC buffer copy loop.
// ============================================================================

import { allocateSimBuffer, allocateInputBuffer, allocateWaterBuffer } from "@shared/sim-buffer";
import { allocateBoatBuffer } from "@shared/boat-buffer";
import { SimToMainMessage, MainToSimMessage } from "@shared/types";
import { DEFAULT_GAME_RULES } from "@shared/constants";

export type SimEventCallback = (msg: SimToMainMessage) => void;

export interface SimWebWorkerConfig {
  seed: number;
  gamemode: number;
  rules: Record<string, number | boolean>;
  isDev?: boolean;
}

export class SimWebWorker {
  private worker: Worker | null = null;
  private simBuffer: SharedArrayBuffer;
  private inputBuffer: SharedArrayBuffer;
  private waterBuffer: SharedArrayBuffer;
  private boatBuffer: SharedArrayBuffer;
  private eventCallbacks: Set<SimEventCallback> = new Set();
  private ready: boolean = false;
  private readyResolvers: Array<() => void> = [];

  constructor() {
    this.simBuffer = allocateSimBuffer();
    this.inputBuffer = allocateInputBuffer();
    this.waterBuffer = allocateWaterBuffer();
    this.boatBuffer = allocateBoatBuffer();
  }

  getSimBuffer(): SharedArrayBuffer { return this.simBuffer; }
  getInputBuffer(): SharedArrayBuffer { return this.inputBuffer; }
  getWaterBuffer(): SharedArrayBuffer { return this.waterBuffer; }
  getBoatBuffer(): SharedArrayBuffer { return this.boatBuffer; }

  isReady(): boolean { return this.ready; }

  onEvent(cb: SimEventCallback): void {
    this.eventCallbacks.add(cb);
  }

  offEvent(cb: SimEventCallback): void {
    this.eventCallbacks.delete(cb);
  }

  async start(config: SimWebWorkerConfig): Promise<void> {
    this.worker = new Worker(
      new URL("./sim-worker-web.ts", import.meta.url),
      { type: "module" },
    );

    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as SimToMainMessage;
      if (msg.kind === "ready") {
        this.ready = true;
        this.readyResolvers.forEach(fn => fn());
        this.readyResolvers = [];
      }
      for (const cb of this.eventCallbacks) {
        try { cb(msg); } catch (err) {
          console.error("[SimWebWorker] Event callback error:", err);
        }
      }
    };

    this.worker.onerror = (e: ErrorEvent) => {
      console.error("[SimWebWorker] Worker error:", e.message);
      for (const cb of this.eventCallbacks) {
        try { cb({ kind: "error", data: { message: e.message } }); } catch {}
      }
    };

    // Wait for ready signal
    const readyPromise = new Promise<void>((resolve) => {
      if (this.ready) { resolve(); return; }
      this.readyResolvers.push(resolve);
    });

    // Send init message with SharedArrayBuffers
    this.worker.postMessage({
      kind: "init",
      simBuffer: this.simBuffer,
      inputBuffer: this.inputBuffer,
      waterBuffer: this.waterBuffer,
      boatBuffer: this.boatBuffer,
      config: {
        seed: config.seed,
        gamemode: config.gamemode,
        rules: config.rules ?? DEFAULT_GAME_RULES,
        isDev: config.isDev,
      },
    });

    await readyPromise;
  }

  send(msg: MainToSimMessage): void {
    this.worker?.postMessage(msg);
  }

  addPlayer(playerId: number, name: string): void {
    this.send({ kind: "add_player", data: { playerId, name } });
  }

  removePlayer(playerId: number): void {
    this.send({ kind: "remove_player", data: { playerId } });
  }

  pause(): void {
    this.send({ kind: "pause", data: {} });
  }

  resume(): void {
    this.send({ kind: "resume", data: {} });
  }

  async save(slotName: string): Promise<{ slotName: string; stateJson: string } | null> {
    return new Promise((resolve) => {
      if (!this.worker) { resolve(null); return; }

      const handler = (e: MessageEvent) => {
        const msg = e.data as SimToMainMessage;
        if (msg.kind === "saved" && msg.data?.slotName === slotName) {
          this.worker?.removeEventListener("message", handler);
          resolve(msg.data);
        }
      };
      this.worker.addEventListener("message", handler);

      this.send({ kind: "save", data: { slotName } });

      // Timeout after 10s
      setTimeout(() => {
        this.worker?.removeEventListener("message", handler);
        resolve(null);
      }, 10000);
    });
  }

  async load(slotName: string, stateJson?: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.worker) { resolve(false); return; }

      const handler = (e: MessageEvent) => {
        const msg = e.data as SimToMainMessage;
        if (msg.kind === "loaded" && msg.data?.slotName === slotName) {
          this.worker?.removeEventListener("message", handler);
          resolve(true);
        }
      };
      this.worker.addEventListener("message", handler);

      this.send({ kind: "load", data: { slotName, stateJson } });

      setTimeout(() => {
        this.worker?.removeEventListener("message", handler);
        resolve(false);
      }, 10000);
    });
  }

  setGamemode(mode: number): void {
    this.send({ kind: "set_gamemode", data: { mode } });
  }

  setSetting(key: string, value: number | boolean): void {
    this.send({ kind: "set_setting", data: { key, value } });
  }

  respawnPlayer(playerId: number): void {
    this.send({ kind: "respawn", data: { playerId } });
  }

  setDebugMode(enabled: boolean): void {
    this.send({ kind: "debug_mode", data: { enabled } });
  }

  sendCommand(cmd: any): void {
    this.send({ kind: "command", data: cmd });
  }

  sendWorldCommand(cmd: any): void {
    this.send({ kind: "world_command", data: cmd });
  }

  setWeather(weatherType: number): void {
    this.send({ kind: "set_weather", data: { weatherType } });
  }

  setTimeOfDay(time: number): void {
    this.send({ kind: "set_time_of_day", data: { time } });
  }

  async stop(): Promise<void> {
    if (!this.worker) return;
    this.send({ kind: "shutdown", data: {} });
    this.worker.terminate();
    this.worker = null;
    this.ready = false;
  }
}
