// ============================================================================
// Sandjongg worker host — wraps the sim worker with a proxy + SAB reader/writer.
// ============================================================================

import { BaseWorkerHost, type BufferSyncConfig } from "@downdraft/core";
import { allocateSimBuffer, INPUT, INPUT_BYTES, INPUT_OFFSET, OFFSETS, SimBufferReader, SimBufferWriter, TOTAL_BYTES } from "../shared/sim-buffer";
import type { TilesetId } from "../shared/tilesets";
import type { GameMode, SerializedBoard } from "../shared/types";

type SandjonggWorkerApi = {
  init(sab: SharedArrayBuffer, gridW: number, gridH: number): Promise<void>;
  resize(gridW: number, gridH: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  step(): Promise<void>;
  newGame(level: number): Promise<void>;
  advanceLevel(level: number): Promise<void>;
  getStats(): Promise<{ fps: number; tick: number; frame: number; score: number; level: number; combo: number; tilesLeft: number }>;
  loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void>;
  loadBoard(cols: number, rows: number, elements: Int32Array, layers?: number): Promise<void>;
  getBoardState(): Promise<SerializedBoard | null>;
  loadBoardState(data: SerializedBoard): Promise<void>;
  setProgress(level: number, score: number, combo: number): Promise<void>;
  setBoardLayout(originCol: number, originRow: number, tileW: number, tileH: number): Promise<void>;
  setNoAdjacentSame(enabled: boolean): Promise<void>;
  setCustomDims(cols: number, rows: number): Promise<void>;
  setMode(mode: GameMode): Promise<void>;
  setTileset(id: TilesetId): Promise<void>;
  spawnSand(sandCol: number, sandRow: number, sandW: number, sandH: number, element: number): Promise<void>;
};

export class SandjonggWorkerHost extends BaseWorkerHost<SandjonggWorkerApi> {
  private writer: SimBufferWriter;
  private reader: SimBufferReader;
  private eventHandler: ((kind: string, data?: unknown) => void) | null = null;
  gridW: number;
  gridH: number;

  constructor(gridW: number, gridH: number) {
    const sab = allocateSimBuffer();
    super(sab);
    this.gridW = gridW;
    this.gridH = gridH;
    this.writer = new SimBufferWriter(sab, OFFSETS, gridW, gridH);
    this.reader = new SimBufferReader(sab, OFFSETS, gridW, gridH);
    this.writer.init();
  }

  getReader(): SimBufferReader { return this.reader; }

  /** Subscribe to worker events (matched, hint, noHint, matchFailed, deadEnd). */
  onEvents(handler: (kind: string, data?: unknown) => void): void {
    this.eventHandler = handler;
  }

  protected createWorker(): Worker {
    // CRITICAL: `new URL(...)` must be inlined directly inside `new Worker()` —
    // Vite only bundles worker modules when it sees this exact pattern. Assigning
    // the URL to a variable first causes Vite to emit the worker as a raw
    // unbundled asset (bare imports unresolved), breaking production builds.
    return new Worker(new URL("./sandjongg-worker.ts", import.meta.url), { type: "module" });
  }

  protected async onInit(): Promise<void> {
    await this.getProxy()!.proxy.init(this.getSimBuffer(), this.gridW, this.gridH);
  }

  /**
   * SAB polyfill: declare buffer sync regions for the copy-based protocol.
   *
   * Sandjongg uses a single SAB with embedded input at INPUT_OFFSET (64 bytes).
   * The main thread writes the input region; the worker writes everything else
   * (grid, fields, stats, board). The sync manager copies only the declared
   * write regions between threads.
   */
  protected getSyncConfig(): BufferSyncConfig | null {
    return {
      buffers: { sim: this.getSimBuffer() },
      regions: {
        sim: {
          // Main thread writes: input region only (64 bytes)
          writeRegions: [
            { offset: INPUT_OFFSET, length: INPUT_BYTES, name: "input" },
          ],
          // Worker writes: everything except the input region
          readRegions: [
            { offset: 0, length: INPUT_OFFSET, name: "pre-input" },
            { offset: INPUT_OFFSET + INPUT_BYTES, length: TOTAL_BYTES - INPUT_OFFSET - INPUT_BYTES, name: "post-input" },
          ],
        },
      },
    };
  }

  protected onEvent(kind: string, data?: unknown): void {
    if (kind === "ready") {
      this.ready = true;
    }
    this.eventHandler?.(kind, data);
  }

  protected onError(e: ErrorEvent): void {
    const errStr = e.error ? (e.error.stack || e.error.message || String(e.error)) : "null";
    console.error(
      `[SandjonggWorkerHost] worker error: msg=${e.message ?? "undefined"} ` +
      `file=${e.filename ?? "none"} line=${e.lineno} col=${e.colno} ` +
      `error=${errStr} type=${e.type}`,
    );
  }

  async resize(gridW: number, gridH: number): Promise<void> {
    this.gridW = gridW;
    this.gridH = gridH;
    this.writer.setDims(gridW, gridH);
    this.reader.setDims(gridW, gridH);
    await this.getProxy()?.proxy.resize(gridW, gridH);
  }

  pause(): void { this.getProxy()?.proxy.pause().catch(() => {}); }
  resume(): void { this.getProxy()?.proxy.resume().catch(() => {}); }
  setSpeed(speed: number): void { this.getProxy()?.proxy.setSpeed(speed).catch(() => {}); }
  step(): void { this.getProxy()?.proxy.step().catch(() => {}); }
  newGame(level: number): void { this.getProxy()?.proxy.newGame(level).catch(() => {}); }
  advanceLevel(level: number): void { this.getProxy()?.proxy.advanceLevel(level).catch(() => {}); }

  // --- Actions (written to SAB input region, processed by worker loop) ---
  requestMatch(aCol: number, aRow: number, aLayer: number, bCol: number, bRow: number, bLayer: number): void {
    this.writer.writeInput(INPUT.MATCH_A_COL, aCol);
    this.writer.writeInput(INPUT.MATCH_A_ROW, aRow);
    this.writer.writeInput(INPUT.MATCH_A_LAYER, aLayer);
    this.writer.writeInput(INPUT.MATCH_B_COL, bCol);
    this.writer.writeInput(INPUT.MATCH_B_ROW, bRow);
    this.writer.writeInput(INPUT.MATCH_B_LAYER, bLayer);
    this.writer.writeInput(INPUT.ACTION, 1); // must be last (worker reads action)
  }

  requestHint(): void { this.writer.writeInput(INPUT.ACTION, 2); }
  requestShuffle(): void { this.writer.writeInput(INPUT.ACTION, 3); }
  requestNewGame(level: number): void {
    this.writer.writeInput(INPUT.NEW_LEVEL, level);
    this.writer.writeInput(INPUT.ACTION, 4);
  }
  requestAdvance(level: number): void {
    this.writer.writeInput(INPUT.NEW_LEVEL, level);
    this.writer.writeInput(INPUT.ACTION, 6);
  }
  requestClearSand(): void { this.writer.writeInput(INPUT.ACTION, 5); }

  async getStats(): Promise<{ fps: number; tick: number; frame: number; score: number; level: number; combo: number; tilesLeft: number } | null> {
    try { return await this.getProxy()?.proxy.getStats() ?? null; }
    catch { return null; }
  }

  async loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void> {
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.writer.setDims(gridW, gridH);
      this.reader.setDims(gridW, gridH);
    }
    await this.getProxy()?.proxy.loadGrid(grid, fields, gridW, gridH);
  }

  loadBoard(cols: number, rows: number, elements: Int32Array, layers: number = 1): void {
    this.getProxy()?.proxy.loadBoard(cols, rows, elements, layers).catch(() => {});
  }

  async getBoardState(): Promise<SerializedBoard | null> {
    try { return await this.getProxy()?.proxy.getBoardState() ?? null; }
    catch { return null; }
  }

  async loadBoardState(data: SerializedBoard): Promise<void> {
    await this.getProxy()?.proxy.loadBoardState(data);
  }

  /** Restore the worker's level/score/combo variables when loading a save.
   *  Must be called after loadBoardState() so the SAB stats report the
   *  correct values (otherwise updateStatsFromSAB overwrites the store). */
  async setProgress(level: number, score: number, combo: number): Promise<void> {
    await this.getProxy()?.proxy.setProgress(level, score, combo);
  }

  setBoardLayout(originCol: number, originRow: number, tileW: number, tileH: number): void {
    this.getProxy()?.proxy.setBoardLayout(originCol, originRow, tileW, tileH).catch(() => {});
  }

  setNoAdjacentSame(enabled: boolean): void {
    this.getProxy()?.proxy.setNoAdjacentSame(enabled).catch(() => {});
  }

  setCustomDims(cols: number, rows: number): void {
    this.getProxy()?.proxy.setCustomDims(cols, rows).catch(() => {});
  }

  setMode(mode: GameMode): void {
    this.getProxy()?.proxy.setMode(mode).catch(() => {});
  }

  setTileset(id: TilesetId): void {
    this.getProxy()?.proxy.setTileset(id).catch(() => {});
  }

  /** Spawn sand at an exact sand-grid rect (driven by the renderer at match
   *  time using the tile's on-screen position). */
  spawnSand(sandCol: number, sandRow: number, sandW: number, sandH: number, element: number): void {
    this.getProxy()?.proxy.spawnSand(sandCol, sandRow, sandW, sandH, element).catch(() => {});
  }
}
