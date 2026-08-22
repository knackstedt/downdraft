import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import { allocateSimBuffer, INPUT, NUM_LAYERS, OFFSETS, SimBufferReader, SimBufferWriter } from "../shared/sim-buffer";

// Per-layer worker API. Each worker ticks exactly one layer and writes to its
// own region of the shared SAB.
type SandLayerApi = {
  init(sab: SharedArrayBuffer, gridW: number, gridH: number, layer: number): Promise<void>;
  resize(gridW: number, gridH: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  clear(): Promise<void>;
  loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void>;
  getStats(): Promise<{ fps: number; tick: number; frame: number }>;
  setSpeed(speed: number): Promise<void>;
  step(): Promise<void>;
};

interface LayerWorker {
  proxy: WorkerProxy<SandLayerApi>;
  worker: Worker;
  ready: boolean;
}

export class SandWorkerHost {
  private sab: SharedArrayBuffer;
  private writer: SimBufferWriter;
  private reader: SimBufferReader;
  private layers: LayerWorker[] = [];
  private readyCount = 0;
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
  isReady(): boolean { return this.readyCount >= NUM_LAYERS; }

  async start(): Promise<void> {
    const workerUrl = new URL("./sand-worker.ts", import.meta.url);

    // Snapshot the grid dimensions at spawn time. The await on init() below
    // yields to the event loop, which can fire a resize event between spawning
    // worker 0 and worker 1 — causing them to be initialized with different
    // grid dimensions. Capturing the dims upfront ensures all workers start
    // with the same size; any resize that arrived during spawn is applied
    // after (via the resize RPC fan-out).
    const spawnW = this.gridW;
    const spawnH = this.gridH;

    for (let i = 0; i < NUM_LAYERS; i++) {
      const worker = new Worker(workerUrl, { type: "module" });
      const wp = wrap<SandLayerApi>(worker);

      worker.onerror = (e: ErrorEvent) => {
        console.error(`[SandWorkerHost] Layer ${i} worker error:`, e.message);
      };

      // Track ready events per-worker. isReady() returns true once every
      // layer worker has reported ready.
      const layerIdx = i;
      wp.onEvents((kind) => {
        if (kind === "ready") {
          this.layers[layerIdx].ready = true;
          this.readyCount++;
        }
      });

      this.layers.push({ proxy: wp, worker, ready: false });

      // Pass the shared SAB + this worker's layer index. All workers share
      // the same SAB; each writes only to its own layer region.
      await wp.proxy.init(this.sab, spawnW, spawnH, i);
    }
  }

  async resize(gridW: number, gridH: number): Promise<void> {
    this.gridW = gridW;
    this.gridH = gridH;
    this.writer.setDims(gridW, gridH);
    this.reader.setDims(gridW, gridH);
    await Promise.all(this.layers.map(l => l.proxy.proxy.resize(gridW, gridH)));
  }

  async stop(): Promise<void> {
    await Promise.all(this.layers.map(async l => {
      try { await l.proxy.proxy.shutdown(); } catch {}
      l.proxy.terminate();
    }));
    this.layers = [];
    this.readyCount = 0;
  }

  pause(): void {
    for (const l of this.layers) l.proxy.proxy.pause().catch(() => {});
  }
  resume(): void {
    for (const l of this.layers) l.proxy.proxy.resume().catch(() => {});
  }
  setSpeed(speed: number): void {
    for (const l of this.layers) l.proxy.proxy.setSpeed(speed).catch(() => {});
  }
  step(): void {
    for (const l of this.layers) l.proxy.proxy.step().catch(() => {});
  }

  clear(): void {
    for (const l of this.layers) l.proxy.proxy.clear().catch(() => {});
  }

  async loadGrids(grids: Uint32Array[], fields: Uint8Array[], gridW: number, gridH: number): Promise<void> {
    // If dimensions changed, resize the host-side reader/writer first
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.writer.setDims(gridW, gridH);
      this.reader.setDims(gridW, gridH);
    }
    // Each worker loads only its own layer's grid + fields
    await Promise.all(this.layers.map((l, i) => {
      if (i >= grids.length) return Promise.resolve();
      const g = grids[i] ?? new Uint32Array(gridW * gridH);
      const f = fields[i] ?? new Uint8Array(gridW * gridH * 4);
      return l.proxy.proxy.loadGrid(g, f, gridW, gridH);
    }));
  }

  async getStats(): Promise<{ fps: number; tick: number; frame: number } | null> {
    // Stats are written by layer 0 (the primary worker).
    if (this.layers.length === 0) return null;
    try { return await this.layers[0].proxy.proxy.getStats(); }
    catch { return null; }
  }

  // --- Input writing (unchanged — writes to the shared SAB input region) ---
  // All workers read from the same input region; no per-worker fan-out needed.

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

  writePlayerInput(left: boolean, right: boolean, up: boolean, down: boolean, jump: boolean): void {
    this.writer.writeInput(INPUT.LEFT, left ? 1 : 0);
    this.writer.writeInput(INPUT.RIGHT, right ? 1 : 0);
    this.writer.writeInput(INPUT.UP, up ? 1 : 0);
    this.writer.writeInput(INPUT.DOWN, down ? 1 : 0);
    this.writer.writeInput(INPUT.JUMP, jump ? 1 : 0);
  }

  getPlayerF32(field: number): number { return this.reader.getPlayerF32(field); }
  getPlayerI32(field: number): number { return this.reader.getPlayerI32(field); }
}
