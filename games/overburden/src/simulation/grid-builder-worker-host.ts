// ============================================================================
// GridBuilderWorkerHost — manages the grid-builder Web Worker and the render
// SharedArrayBuffer.
//
// The renderer creates this host, which spawns a worker that continuously
// builds instance data + padded textures from the sim SAB into the render SAB.
// The renderer reads the render SAB each frame and uploads pre-built data to
// the GPU — no JS loops on the main thread.
// ============================================================================

import { BaseWorkerHost, type BufferSyncConfig } from "@downdraft/core";
import {
    createRenderBuffer,
    RenderBufferReader,
} from "../shared/render-buffer";

// INPUT is the last region in the sim SAB (128 bytes). Compute its offset
// from the buffer's byteLength at runtime — avoids importing computed
// constants that Vite may tree-shake incorrectly in the mobile bundle.
const INPUT_SIZE = 128;

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

  /**
   * SAB polyfill: declare buffer sync regions for the copy-based protocol.
   *
   * The grid builder uses two SABs:
   *   1. sim SAB (read-only) — reads sim data written by the sim worker.
   *      The main thread's copy is kept in sync by BlockheadsWorkerHost's
   *      BufferSyncHost. This host re-syncs it to the grid builder worker.
   *   2. render SAB (write-only) — the grid builder writes pre-built instance
   *      data + padded textures. This host receives them and copies into the
   *      main thread's render SAB copy.
   *
   * The render SAB's build-tick field (RENDER_HEADER_TICK at offset 0) is used
   * as the sequence number for change gating — sync is skipped when the grid
   * builder hasn't published a new build.
   */
  protected getSyncConfig(): BufferSyncConfig | null {
    if (!this.simSab) return null;
    const inputOffset = this.simSab.byteLength - INPUT_SIZE;
    const renderSab = this.getSimBuffer();
    return {
      buffers: {
        sim: this.simSab,
        render: renderSab,
      },
      regions: {
        // Sim SAB: main thread syncs sim data → grid builder (writeRegions).
        // Grid builder doesn't write to the sim SAB, so no readRegions.
        sim: {
          writeRegions: [
            { offset: 0, length: inputOffset, name: "sim-data" },
          ],
          readRegions: [],
        },
        // Render SAB: grid builder writes everything → main thread (readRegions).
        // Main thread doesn't write to the render SAB, so no writeRegions.
        render: {
          writeRegions: [],
          readRegions: [
            { offset: 0, length: renderSab.byteLength, name: "render-data" },
          ],
        },
      },
      seqFields: {
        sim: { offset: 0 },    // HDR_TICK (Uint32 at offset 0)
        render: { offset: 0 }, // RENDER_HEADER_TICK (Uint32 at offset 0)
      },
    };
  }
}
