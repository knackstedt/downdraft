// ============================================================================
// GridBuilderWorkerHost — manages the grid-builder Web Worker and the render
// SharedArrayBuffer.
//
// The renderer creates this host, which spawns a worker that continuously
// builds instance data + padded textures from the sim SAB into the render SAB.
// The renderer reads the render SAB each frame and uploads pre-built data to
// the GPU — no JS loops on the main thread.
// ============================================================================

import { BaseWorkerHost } from "@downdraft/core";
import {
  createRenderBuffer,
  RenderBufferReader,
} from "../shared/render-buffer";

type GridBuilderWorkerApi = {
  init(simSab: SharedArrayBuffer, renderSab: SharedArrayBuffer): Promise<void>;
  shutdown(): Promise<void>;
  buildNow(): Promise<void>;
};

export class GridBuilderWorkerHost extends BaseWorkerHost<GridBuilderWorkerApi> {
  private reader: RenderBufferReader;
  private simSab: SharedArrayBuffer | null = null;
  private started = false;

  constructor() {
    const renderSab = createRenderBuffer();
    super(renderSab);
    this.reader = new RenderBufferReader(renderSab as ArrayBufferLike);
  }

  getRenderBuffer(): SharedArrayBuffer {
    return this.getSimBuffer();
  }

  getReader(): RenderBufferReader {
    return this.reader;
  }

  isStarted(): boolean {
    return this.started;
  }

  protected createWorker(): Worker {
    // CRITICAL: `new URL(...)` must be inlined directly inside `new Worker()` —
    // Vite only bundles worker modules when it sees this exact pattern.
    // Assigning the URL to a variable first causes Vite to emit the worker
    // as a raw unbundled asset (bare imports unresolved), breaking prod.
    return new Worker(new URL("./grid-builder-worker.ts", import.meta.url), { type: "module" });
  }

  protected async onInit(): Promise<void> {
    if (!this.simSab) throw new Error("GridBuilderWorkerHost.start() requires simSab — call startWithSimSab()");
    await this.getProxy()!.proxy.init(this.simSab, this.getSimBuffer());
    this.started = true;
  }

  /**
   * Spawn the worker and pass it the sim SAB + render SAB.
   * Overrides BaseWorkerHost.start() because this host needs the sim SAB
   * from the BlockheadsWorkerHost at startup.
   */
  async startWithSimSab(simSab: SharedArrayBuffer): Promise<void> {
    this.simSab = simSab;
    await this.start();
  }

  /** Force an immediate build (used for deterministic test mode). */
  async buildNow(): Promise<void> {
    await this.getProxy()?.proxy.buildNow();
  }
}
