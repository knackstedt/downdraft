// ============================================================================
// MiningWorkerHost — manages the mining sim Web Worker and the shared SAB.
//
// The renderer creates this host, which spawns a single worker running
// ChunkWorld. The host provides methods to write input (keyboard, mouse, dig
// radius) and read the active grid + player state + stats from the SAB.
// ============================================================================

import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, INPUT } from "../shared/constants";
import {
    MiningSimBufferReader,
    MiningSimBufferWriter,
    allocateMiningSimBuffer,
} from "../shared/sim-buffer";
import type { InventoryEntry } from "../shared/types";

type MiningWorkerApi = {
  init(sab: SharedArrayBuffer): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  step(): Promise<void>;
  getStats(): Promise<{ fps: number; tick: number; frame: number }>;
};

export class MiningWorkerHost {
  private sab: SharedArrayBuffer;
  private writer: MiningSimBufferWriter;
  private reader: MiningSimBufferReader;
  private proxy: WorkerProxy<MiningWorkerApi> | null = null;
  private worker: Worker | null = null;
  private ready = false;
  private onCollected: ((items: InventoryEntry[]) => void) | null = null;

  constructor() {
    this.sab = allocateMiningSimBuffer();
    this.writer = new MiningSimBufferWriter(this.sab, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.reader = new MiningSimBufferReader(this.sab, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.writer.init();
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }
  getReader(): MiningSimBufferReader {
    return this.reader;
  }
  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    const workerUrl = new URL("./mining-worker.ts", import.meta.url);
    this.worker = new Worker(workerUrl, { type: "module" });
    this.proxy = wrap<MiningWorkerApi>(this.worker);

    this.worker.onerror = (e: ErrorEvent) => {
      console.error("[MiningWorkerHost] Worker error:", e.message);
    };

    this.proxy.onEvents((kind, data) => {
      if (kind === "ready") {
        this.ready = true;
      } else if (kind === "collected" && this.onCollected) {
        this.onCollected(data as InventoryEntry[]);
      }
    });

    await this.proxy.proxy.init(this.sab);
  }

  async stop(): Promise<void> {
    if (this.proxy) {
      try {
        await this.proxy.proxy.shutdown();
      } catch {}
      this.proxy.terminate();
    }
    this.proxy = null;
    this.worker = null;
    this.ready = false;
  }

  pause(): void {
    this.proxy?.proxy.pause().catch(() => {});
  }
  resume(): void {
    this.proxy?.proxy.resume().catch(() => {});
  }
  setSpeed(speed: number): void {
    this.proxy?.proxy.setSpeed(speed).catch(() => {});
  }
  step(): void {
    this.proxy?.proxy.step().catch(() => {});
  }

  onCollectedItems(cb: (items: InventoryEntry[]) => void): void {
    this.onCollected = cb;
  }

  // --- Input writing ---

  writePlayerInput(
    left: boolean,
    right: boolean,
    up: boolean,
    down: boolean,
    jump: boolean,
  ): void {
    this.writer.writeInput(INPUT.LEFT, left ? 1 : 0);
    this.writer.writeInput(INPUT.RIGHT, right ? 1 : 0);
    this.writer.writeInput(INPUT.UP, up ? 1 : 0);
    this.writer.writeInput(INPUT.DOWN, down ? 1 : 0);
    this.writer.writeInput(INPUT.JUMP, jump ? 1 : 0);
  }

  writeMouseDown(down: boolean): void {
    this.writer.writeInput(INPUT.MOUSE_DOWN, down ? 1 : 0);
  }

  writeMousePos(worldX: number, worldY: number): void {
    this.writer.writeInputF32(INPUT.MOUSE_X, worldX);
    this.writer.writeInputF32(INPUT.MOUSE_Y, worldY);
  }

  writeDigRadius(radius: number): void {
    this.writer.writeInput(INPUT.DIG_RADIUS, radius);
  }

  // --- Player state reading ---

  getPlayerF32(field: number): number {
    return this.reader.getPlayerF32(field);
  }
  getPlayerI32(field: number): number {
    return this.reader.getPlayerI32(field);
  }

  getStat(field: number): number {
    return this.reader.getStat(field);
  }

  async getStats(): Promise<{ fps: number; tick: number; frame: number } | null> {
    if (!this.proxy) return null;
    try {
      return await this.proxy.proxy.getStats();
    } catch {
      return null;
    }
  }
}
