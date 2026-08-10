import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import { allocateSimBuffer, INPUT, SimBufferReader, SimBufferWriter } from "../shared/sim-buffer";

type SandApi = {
  init(sab: SharedArrayBuffer, gridW: number, gridH: number): Promise<void>;
  resize(gridW: number, gridH: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  clear(): Promise<void>;
  loadGrids(grids: Uint32Array[], fields: Uint8Array[], gridW: number, gridH: number): Promise<void>;
  getStats(): Promise<{ fps: number; tick: number; frame: number }>;
};

export class SandWorkerHost {
  private sab: SharedArrayBuffer;
  private writer: SimBufferWriter;
  private reader: SimBufferReader;
  private wp: WorkerProxy<SandApi> | null = null;
  private worker: Worker | null = null;
  private ready = false;
  gridW: number;
  gridH: number;

  constructor(gridW: number, gridH: number) {
    this.gridW = gridW;
    this.gridH = gridH;
    this.sab = allocateSimBuffer();
    this.writer = new SimBufferWriter(this.sab, gridW, gridH);
    this.reader = new SimBufferReader(this.sab, gridW, gridH);
    this.writer.init();
  }

  getSimBuffer(): SharedArrayBuffer { return this.sab; }
  getReader(): SimBufferReader { return this.reader; }
  isReady(): boolean { return this.ready; }

  async start(): Promise<void> {
    const workerUrl = new URL("./sand-worker.ts", import.meta.url);
    this.worker = new Worker(workerUrl, { type: "module" });
    this.wp = wrap<SandApi>(this.worker);

    this.worker.onerror = (e: ErrorEvent) => {
      console.error("[SandWorkerHost] Worker error:", e.message);
    };

    this.wp.onEvents((kind) => {
      if (kind === "ready") this.ready = true;
    });

    await this.wp.proxy.init(this.sab, this.gridW, this.gridH);
  }

  async resize(gridW: number, gridH: number): Promise<void> {
    this.gridW = gridW;
    this.gridH = gridH;
    this.writer.setDims(gridW, gridH);
    this.reader.setDims(gridW, gridH);
    await this.wp?.proxy.resize(gridW, gridH);
  }

  async stop(): Promise<void> {
    if (!this.wp) return;
    try { await this.wp.proxy.shutdown(); } catch {}
    this.wp.terminate();
    this.wp = null;
    this.worker = null;
    this.ready = false;
  }

  pause(): void { this.wp?.proxy.pause().catch(() => {}); }
  resume(): void { this.wp?.proxy.resume().catch(() => {}); }

  clear(): void { this.wp?.proxy.clear().catch(() => {}); }

  async loadGrids(grids: Uint32Array[], fields: Uint8Array[], gridW: number, gridH: number): Promise<void> {
    // If dimensions changed, resize first
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.writer.setDims(gridW, gridH);
      this.reader.setDims(gridW, gridH);
    }
    await this.wp?.proxy.loadGrids(grids, fields, gridW, gridH);
  }

  async getStats(): Promise<{ fps: number; tick: number; frame: number } | null> {
    if (!this.wp) return null;
    try { return await this.wp.proxy.getStats(); }
    catch { return null; }
  }

  writeMouseDown(down: boolean): void { this.writer.writeInput(INPUT.MOUSE_DOWN, down ? 1 : 0); }
  writeMouseRight(right: boolean): void { this.writer.writeInput(INPUT.MOUSE_RIGHT, right ? 1 : 0); }
  writeMousePos(x: number, y: number): void { this.writer.writeInput(INPUT.MOUSE_X, x); this.writer.writeInput(INPUT.MOUSE_Y, y); }
  writeLastMousePos(x: number, y: number): void { this.writer.writeInput(INPUT.LAST_MOUSE_X, x); this.writer.writeInput(INPUT.LAST_MOUSE_Y, y); }
  writeSelectedMaterial(mat: number): void { this.writer.writeInput(INPUT.SELECTED_MAT, mat); }
  writeBrushRadius(r: number): void { this.writer.writeInput(INPUT.BRUSH_RADIUS, r); }
  writeMagnet(_active: boolean): void { /* deprecated */ }

  writeImpulseChance(chance: number): void {
    this.writer.writeInput(INPUT.IMPULSE_CHANCE, Math.round(chance * 1000));
  }

  writeImpulseStrength(strength: number): void {
    this.writer.writeInput(INPUT.IMPULSE_STRENGTH, Math.round(strength * 1000));
  }

  writeBrushMode(mode: number): void {
    this.writer.writeInput(INPUT.BRUSH_MODE, mode);
  }

  writeFieldType(type: number): void {
    this.writer.writeInput(INPUT.FIELD_TYPE, type);
  }

  writeFieldValue(value: number): void {
    this.writer.writeInput(INPUT.FIELD_VALUE, value);
  }

  writeShowFields(show: boolean): void {
    this.writer.writeInput(INPUT.SHOW_FIELDS, show ? 1 : 0);
  }

  writeActiveLayer(layer: number): void {
    this.writer.writeInput(INPUT.ACTIVE_LAYER, layer);
  }
}
