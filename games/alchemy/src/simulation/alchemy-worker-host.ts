import { BaseWorkerHost } from "@downdraft/core";
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

export class AlchemyWorkerHost extends BaseWorkerHost<AlchemyWorkerApi> {
  private writer: SimBufferWriter;
  private reader: SimBufferReader;
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

  protected createWorker(): Worker {
    // CRITICAL: `new URL(...)` must be inlined directly inside `new Worker()` —
    // Vite only bundles worker modules when it sees this exact pattern.
    // Assigning the URL to a variable first causes Vite to emit the worker
    // as a raw unbundled asset (bare imports unresolved), breaking prod.
    return new Worker(new URL("./alchemy-worker.ts", import.meta.url), { type: "module" });
  }

  protected async onInit(): Promise<void> {
    await this.getProxy()!.proxy.init(this.getSimBuffer(), this.gridW, this.gridH);
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
  clear(): void { this.getProxy()?.proxy.clear().catch(() => {}); }

  async loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void> {
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.writer.setDims(gridW, gridH);
      this.reader.setDims(gridW, gridH);
    }
    await this.getProxy()?.proxy.loadGrid(grid, fields, gridW, gridH);
  }

  async getStats(): Promise<{ fps: number; tick: number; frame: number } | null> {
    try { return await this.getProxy()?.proxy.getStats() ?? null; }
    catch { return null; }
  }

  runStation(station: "heat" | "cool" | "settle", durationTicks: number): void {
    this.getProxy()?.proxy.runStation(station, durationTicks).catch(() => {});
  }

  cancelStation(): void {
    this.getProxy()?.proxy.cancelStation().catch(() => {});
  }

  async getStationState(): Promise<{ station: string | null; progress: number }> {
    try { return await this.getProxy()?.proxy.getStationState() ?? { station: null, progress: 0 }; }
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
