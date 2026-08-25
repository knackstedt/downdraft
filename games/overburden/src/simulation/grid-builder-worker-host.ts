// ============================================================================
// GridBuilderWorkerHost — manages the grid-builder Web Worker and the render
// SharedArrayBuffer.
//
// The renderer creates this host, which spawns a worker that continuously
// builds instance data + padded textures from the sim SAB into the render SAB.
// The renderer reads the render SAB each frame and uploads pre-built data to
// the GPU — no JS loops on the main thread.
// ============================================================================

import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import {
    createRenderBuffer,
    RenderBufferReader,
} from "../shared/render-buffer";

type GridBuilderWorkerApi = {
  init(simSab: SharedArrayBuffer, renderSab: SharedArrayBuffer): Promise<void>;
  shutdown(): Promise<void>;
  buildNow(): Promise<void>;
};

export class GridBuilderWorkerHost {
  private renderSab: SharedArrayBuffer;
  private reader: RenderBufferReader;
  private proxy: WorkerProxy<GridBuilderWorkerApi> | null = null;
  private worker: Worker | null = null;
  private started = false;

  constructor() {
    this.renderSab = createRenderBuffer();
    this.reader = new RenderBufferReader(this.renderSab as ArrayBufferLike);
  }

  getRenderBuffer(): SharedArrayBuffer {
    return this.renderSab;
  }

  getReader(): RenderBufferReader {
    return this.reader;
  }

  async start(simSab: SharedArrayBuffer): Promise<void> {
    // NOTE: `new URL(...)` must be inlined directly inside `new Worker()` —
    // Vite only bundles worker modules when it sees this exact pattern.
    // Assigning the URL to a variable first causes Vite to emit the worker
    // as a raw unbundled asset (bare imports unresolved), breaking prod.
    this.worker = new Worker(new URL("./grid-builder-worker.ts", import.meta.url), { type: "module" });
    this.proxy = wrap<GridBuilderWorkerApi>(this.worker);

    this.worker.onerror = (e: ErrorEvent) => {
      console.error("[GridBuilderWorkerHost] Worker error:", e.message);
    };

    await this.proxy.proxy.init(simSab, this.renderSab);
    this.started = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Force an immediate build (used for deterministic test mode). */
  async buildNow(): Promise<void> {
    await this.proxy?.proxy.buildNow();
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
    this.started = false;
  }
}
