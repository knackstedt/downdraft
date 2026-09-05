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
    RenderBufferReader
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
    // Compute offsets from byteLength at runtime — avoids importing computed
    // constants that Vite may tree-shake incorrectly in the mobile bundle.
    const HEADER_SIZE = 48;
    const DROPS_SIZE = 4 * 8 * 512;     // DROP_STRIDE(8) * MAX_DROPS(512) * 4
    const BLOCKHEADS_SIZE = 4 * 16 * 32; // BH_STRIDE(16) * MAX_BLOCKHEADS(32) * 4
    const inputOffset = this.simSab.byteLength - INPUT_SIZE;
    const dropsOffset = inputOffset - DROPS_SIZE;
    const blockheadsOffset = dropsOffset - BLOCKHEADS_SIZE;
    const gridsLength = blockheadsOffset - HEADER_SIZE;
    const renderSab = this.getSimBuffer();
    // Render SAB layout offsets — computed locally to avoid importing
    // constants that Vite may tree-shake incorrectly in the mobile bundle.
    // Layout: HEADER(32) | INSTANCE_DATA | PADDED_FG | PADDED_BG | PADDED_LIGHT | PADDED_EXPLORED
    // Texture sizes (computed from ACTIVE_GRID_W=448, ACTIVE_GRID_H=448):
    //   PADDED_GRID_ROW = ceil(448/256)*256 = 512; grid tex = 512*448 = 229376
    //   PADDED_LIGHT_ROW = ceil(448*4/256)*256 = 1792; light tex = 1792*448 = 802816
    //   PADDED_EXPLORED = 512*448 = 229376
    //   Total textures = 2*229376 + 802816 + 229376 = 1490944
    const RENDER_HDR = 32;
    const TEX_SIZE = 1490944; // PADDED_FG + PADDED_BG + PADDED_LIGHT + PADDED_EXPLORED
    const INSTANCE_OFFSET = RENDER_HDR;
    const TEXTURE_OFFSET = renderSab.byteLength - TEX_SIZE;
    return {
      buffers: {
        sim: this.simSab,
        render: renderSab,
      },
      regions: {
        // Sim SAB: main thread syncs sim data → grid builder (writeRegions).
        // Split into fast (header, synced every frame) + slow (grids, synced
        // every 6 frames) to reduce copy overhead. The grid builder needs the
        // header (tick) every frame to know when to build, but the grid data
        // can tolerate several frames of staleness.
        sim: {
          writeRegions: [
            { offset: 0, length: HEADER_SIZE, name: "header" },
            { offset: HEADER_SIZE, length: gridsLength, name: "grids", syncInterval: 18 },
            { offset: blockheadsOffset, length: BLOCKHEADS_SIZE, name: "blockheads" },
            { offset: dropsOffset, length: DROPS_SIZE, name: "drops" },
          ],
          readRegions: [],
        },
        // Render SAB: grid builder writes everything → main thread (readRegions).
        // Main thread doesn't write to the render SAB, so no writeRegions.
        // Split into header + instances + textures to mirror the worker's
        // write regions. The instances region uses dynamic length on the
        // worker side; the host just copies whatever it receives.
        render: {
          writeRegions: [],
          readRegions: [
            { offset: 0, length: RENDER_HDR, name: "render-header" },
            { offset: INSTANCE_OFFSET, length: TEXTURE_OFFSET - INSTANCE_OFFSET, name: "render-instances" },
            { offset: TEXTURE_OFFSET, length: TEX_SIZE, name: "render-textures" },
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
