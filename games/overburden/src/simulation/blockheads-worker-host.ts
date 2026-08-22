// ============================================================================
// BlockheadsWorkerHost — manages the blockheads sim Web Worker and the SAB.
//
// The renderer creates this host, which spawns a worker running BlockWorld.
// The host provides methods to control the sim (pause/resume/step) and read
// the active grid + stats from the SAB.
// ============================================================================

import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import { createSimBuffer, SimBufferReader } from "../shared/sim-buffer";

type BlockheadsWorkerApi = {
  init(sab: SharedArrayBuffer): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  step(): Promise<void>;
  getStats(): Promise<{ fps: number; tick: number; frame: number }>;
  setFocus(x: number, y: number): Promise<void>;
  setBlock(x: number, y: number, blockId: number): Promise<void>;
  getBlock(x: number, y: number): Promise<number>;
  getWorldStats(): Promise<{ loadedChunks: number; activeChunks: number; tick: number }>;
};

export class BlockheadsWorkerHost {
  private sab: SharedArrayBuffer;
  private reader: SimBufferReader;
  private proxy: WorkerProxy<BlockheadsWorkerApi> | null = null;
  private worker: Worker | null = null;
  private ready = false;

  constructor() {
    this.sab = createSimBuffer();
    this.reader = new SimBufferReader(this.sab as ArrayBufferLike);
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  getReader(): SimBufferReader {
    return this.reader;
  }

  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    const workerUrl = new URL("./blockheads-worker.ts", import.meta.url);
    this.worker = new Worker(workerUrl, { type: "module" });
    this.proxy = wrap<BlockheadsWorkerApi>(this.worker);

    this.worker.onerror = (e: ErrorEvent) => {
      console.error("[BlockheadsWorkerHost] Worker error:", e.message);
    };

    this.proxy.onEvents((kind: string) => {
      if (kind === "ready") {
        this.ready = true;
      }
    });

    await this.proxy.proxy.init(this.sab);
  }

  async pause(): Promise<void> {
    await this.proxy?.proxy.pause();
  }

  async resume(): Promise<void> {
    await this.proxy?.proxy.resume();
  }

  async shutdown(): Promise<void> {
    if (this.proxy) {
      try {
        await this.proxy.proxy.shutdown();
      } catch { /* ignore */ }
      this.proxy.terminate();
    }
    this.worker = null;
    this.proxy = null;
    this.ready = false;
  }

  async setFocus(x: number, y: number): Promise<void> {
    await this.proxy?.proxy.setFocus(x, y);
  }

  async setBlock(x: number, y: number, blockId: number): Promise<void> {
    await this.proxy?.proxy.setBlock(x, y, blockId);
  }

  async getBlock(x: number, y: number): Promise<number> {
    return await this.proxy?.proxy.getBlock(x, y) ?? 0;
  }

  async getStats(): Promise<{ fps: number; tick: number; frame: number }> {
    return await this.proxy?.proxy.getStats() ?? { fps: 0, tick: 0, frame: 0 };
  }

  async getWorldStats(): Promise<{ loadedChunks: number; activeChunks: number; tick: number }> {
    return await this.proxy?.proxy.getWorldStats() ?? { loadedChunks: 0, activeChunks: 0, tick: 0 };
  }
}
