// ============================================================================
// Sandjongg worker host — wraps the sim worker with a proxy + SAB reader/writer.
// ============================================================================

import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import { allocateSimBuffer, INPUT, OFFSETS, SimBufferReader, SimBufferWriter } from "../shared/sim-buffer";
import type { SerializedBoard } from "../shared/types";

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
};

export class SandjonggWorkerHost {
  private sab: SharedArrayBuffer;
  private writer: SimBufferWriter;
  private reader: SimBufferReader;
  private proxy: WorkerProxy<SandjonggWorkerApi> | null = null;
  private worker: Worker | null = null;
  private ready = false;
  gridW: number;
  gridH: number;

  constructor(gridW: number, gridH: number) {
    this.gridW = gridW;
    this.gridH = gridH;
    this.sab = allocateSimBuffer();
    this.writer = new SimBufferWriter(this.sab, OFFSETS, gridW, gridH);
    this.reader = new SimBufferReader(this.sab, OFFSETS, gridW, gridH);
    this.writer.init();
  }

  getSimBuffer(): SharedArrayBuffer { return this.sab; }
  getReader(): SimBufferReader { return this.reader; }
  isReady(): boolean { return this.ready; }

  /** Subscribe to worker events (matched, hint, noHint, matchFailed, deadEnd). */
  onEvents(handler: (kind: string, data?: unknown) => void): void {
    this.proxy?.onEvents(handler);
  }

  async start(): Promise<void> {
    const workerUrl = new URL("./sandjongg-worker.ts", import.meta.url);
    const worker = new Worker(workerUrl, { type: "module" });
    const wp = wrap<SandjonggWorkerApi>(worker);

    worker.onerror = (e: ErrorEvent) => {
      console.error("[SandjonggWorkerHost] worker error:", e.message);
    };

    wp.onEvents((kind) => {
      if (kind === "ready") this.ready = true;
    });

    this.proxy = wp;
    this.worker = worker;
    await wp.proxy.init(this.sab, this.gridW, this.gridH);
  }

  async resize(gridW: number, gridH: number): Promise<void> {
    this.gridW = gridW;
    this.gridH = gridH;
    this.writer.setDims(gridW, gridH);
    this.reader.setDims(gridW, gridH);
    await this.proxy?.proxy.resize(gridW, gridH);
  }

  async stop(): Promise<void> {
    if (this.proxy) {
      try { await this.proxy.proxy.shutdown(); } catch { /* worker may already be dead */ }
      this.proxy.terminate();
    }
    this.proxy = null;
    this.worker = null;
    this.ready = false;
  }

  pause(): void { this.proxy?.proxy.pause().catch(() => {}); }
  resume(): void { this.proxy?.proxy.resume().catch(() => {}); }
  setSpeed(speed: number): void { this.proxy?.proxy.setSpeed(speed).catch(() => {}); }
  step(): void { this.proxy?.proxy.step().catch(() => {}); }
  newGame(level: number): void { this.proxy?.proxy.newGame(level).catch(() => {}); }
  advanceLevel(level: number): void { this.proxy?.proxy.advanceLevel(level).catch(() => {}); }

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
    try { return await this.proxy?.proxy.getStats() ?? null; }
    catch { return null; }
  }

  async loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void> {
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.writer.setDims(gridW, gridH);
      this.reader.setDims(gridW, gridH);
    }
    await this.proxy?.proxy.loadGrid(grid, fields, gridW, gridH);
  }

  loadBoard(cols: number, rows: number, elements: Int32Array, layers: number = 1): void {
    this.proxy?.proxy.loadBoard(cols, rows, elements, layers).catch(() => {});
  }

  async getBoardState(): Promise<SerializedBoard | null> {
    try { return await this.proxy?.proxy.getBoardState() ?? null; }
    catch { return null; }
  }

  async loadBoardState(data: SerializedBoard): Promise<void> {
    await this.proxy?.proxy.loadBoardState(data);
  }
}
