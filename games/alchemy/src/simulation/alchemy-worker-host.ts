import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import { allocateSimBuffer, INPUT, OFFSETS, SimBufferReader, SimBufferWriter } from "../shared/sim-buffer";

type AlchemyWorkerApi = {
  init(sab: SharedArrayBuffer, gridW: number, gridH: number): Promise<void>;
  resize(gridW: number, gridH: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  clear(): Promise<void>;
  loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void>;
  getStats(): Promise<{ fps: number; tick: number; frame: number }>;
  setSpeed(speed: number): Promise<void>;
  step(): Promise<void>;
  runStation(station: "heat" | "cool" | "settle", durationTicks: number): Promise<void>;
  cancelStation(): Promise<void>;
  getStationState(): Promise<{ station: string | null; progress: number }>;
};

export class AlchemyWorkerHost {
  private sab: SharedArrayBuffer;
  private writer: SimBufferWriter;
  private reader: SimBufferReader;
  private proxy: WorkerProxy<AlchemyWorkerApi> | null = null;
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

  async start(): Promise<void> {
    const workerUrl = new URL("./alchemy-worker.ts", import.meta.url);
    const worker = new Worker(workerUrl, { type: "module" });
    const wp = wrap<AlchemyWorkerApi>(worker);

    worker.onerror = (e: ErrorEvent) => {
      console.error("[AlchemyWorkerHost] worker error:", e.message);
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
  clear(): void { this.proxy?.proxy.clear().catch(() => {}); }

  async loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void> {
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.writer.setDims(gridW, gridH);
      this.reader.setDims(gridW, gridH);
    }
    await this.proxy?.proxy.loadGrid(grid, fields, gridW, gridH);
  }

  async getStats(): Promise<{ fps: number; tick: number; frame: number } | null> {
    try { return await this.proxy?.proxy.getStats() ?? null; }
    catch { return null; }
  }

  runStation(station: "heat" | "cool" | "settle", durationTicks: number): void {
    this.proxy?.proxy.runStation(station, durationTicks).catch(() => {});
  }

  cancelStation(): void {
    this.proxy?.proxy.cancelStation().catch(() => {});
  }

  async getStationState(): Promise<{ station: string | null; progress: number }> {
    try { return await this.proxy?.proxy.getStationState() ?? { station: null, progress: 0 }; }
    catch { return { station: null, progress: 0 }; }
  }

  // --- Input writing ---
  writeMouseDown(down: boolean): void { this.writer.writeInput(INPUT.MOUSE_DOWN, down ? 1 : 0); }
  writeMouseRight(right: boolean): void { this.writer.writeInput(INPUT.MOUSE_RIGHT, right ? 1 : 0); }
  writeMousePos(x: number, y: number): void { this.writer.writeInput(INPUT.MOUSE_X, x); this.writer.writeInput(INPUT.MOUSE_Y, y); }
  writeLastMousePos(x: number, y: number): void { this.writer.writeInput(INPUT.LAST_MOUSE_X, x); this.writer.writeInput(INPUT.LAST_MOUSE_Y, y); }
  writeSelectedMaterial(mat: number): void { this.writer.writeInput(INPUT.SELECTED_MAT, mat); }
  writeBrushRadius(r: number): void { this.writer.writeInput(INPUT.BRUSH_RADIUS, r); }
}
