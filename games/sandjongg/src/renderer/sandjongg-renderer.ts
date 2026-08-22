// ============================================================================
// SandjonggRenderer — orchestrates the WebGPU sand pass + Canvas2D tile pass.
// ============================================================================

import { GPUDeviceManager } from "@downdraft/core";
import { computeGridDims, MAX_LAYERS, MAX_TILES } from "../shared/constants";
import { BOARD_ELEMENT_OFFSET, BOARD_META_OFFSET, SimBufferReader, STATS } from "../shared/sim-buffer";
import { SandjonggWorkerHost } from "../simulation/sandjongg-worker-host";
import { useGameStore } from "../stores/game-store";
import { createInputHandler, type InputHandler } from "./input-handler";
import { SandGridPass } from "./sand-grid-pass";
import { TileCanvasPass } from "./tile-canvas-pass";

export class SandjonggRenderer {
  private canvas: HTMLCanvasElement;
  private tileCanvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private deviceManager = new GPUDeviceManager();
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private gridPass: SandGridPass | null = null;
  private tilePass: TileCanvasPass | null = null;
  private input: InputHandler | null = null;
  private workerHost: SandjonggWorkerHost | null = null;
  private gridReader: SimBufferReader | null = null;
  private gridW = 0;
  private gridH = 0;
  private running = false;
  private raf = 0;
  private lastTime = 0;
  private frameCount = 0;
  private fps = 0;
  private fpsTimer = 0;
  private resizeHandler: (() => void) | null = null;
  private storeUnsub: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private prevBoardCols = 0;
  private prevBoardRows = 0;
  // Cached SAB views to avoid per-frame allocations.
  private cachedBoardElements: Int32Array | null = null;
  private cachedBoardMeta: Int32Array | null = null;
  private cachedUniformBuf: Float32Array = new Float32Array(4);
  // Frame rate cap — the renderer doesn't need to run faster than 60fps.
  private static readonly MIN_FRAME_MS = 1000 / 60;
  private lastFrameTime = 0;

  constructor(canvas: HTMLCanvasElement, tileCanvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.tileCanvas = tileCanvas;
  }

  getFPS(): number { return this.fps; }
  getCanvas(): HTMLCanvasElement { return this.canvas; }
  getGridW(): number { return this.gridW; }
  getGridH(): number { return this.gridH; }
  getWorkerHost(): SandjonggWorkerHost | null { return this.workerHost; }
  getTilePass(): TileCanvasPass | null { return this.tilePass; }

  /** Snapshot the sand grid + fields for saving. */
  snapshotGrid(): { grid: Uint32Array; fields: Uint8Array; gridW: number; gridH: number } {
    if (!this.gridReader) return { grid: new Uint32Array(0), fields: new Uint8Array(0), gridW: 0, gridH: 0 };
    return {
      grid: new Uint32Array(this.gridReader.getGrid()),
      fields: new Uint8Array(this.gridReader.getFieldGrid()),
      gridW: this.gridW,
      gridH: this.gridH,
    };
  }

  async loadSave(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void> {
    if (!this.workerHost || !this.gridPass) return;
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.gridPass.resize(gridW, gridH);
    }
    await this.workerHost.loadGrid(grid, fields, gridW, gridH);
  }

  async init(): Promise<boolean> {
    this.device = await this.deviceManager.requestDevice();
    if (!this.device) return false;
    this.context = this.canvas.getContext("webgpu") as GPUCanvasContext;
    if (!this.context) return false;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });

    this.input = createInputHandler(this.tileCanvas);

    this.resizeCanvas();
    const dims = computeGridDims(this.canvas.width, this.canvas.height);
    this.gridW = dims.w;
    this.gridH = dims.h;

    this.resizeHandler = () => this.handleResize();
    window.addEventListener("resize", this.resizeHandler);

    this.gridPass = new SandGridPass(this.device, this.format, this.gridW, this.gridH);
    this.gridPass.init();

    this.tilePass = new TileCanvasPass(this.tileCanvas);
    this.resizeTileCanvas();

    this.workerHost = new SandjonggWorkerHost(this.gridW, this.gridH);
    await this.workerHost.start();
    this.gridReader = this.workerHost.getReader();

    // Subscribe to store for hint/clear actions.
    this.storeUnsub = useGameStore.subscribe((s) => {
      if (s._pendingHint) {
        this.workerHost?.requestHint();
        useGameStore.getState()._setPendingHint(false);
      }
      if (s._pendingShuffle) {
        this.workerHost?.requestShuffle();
        useGameStore.getState()._setPendingShuffle(false);
      }
      if (s._pendingNewGame) {
        this.workerHost?.requestNewGame(s._pendingNewGameLevel);
        useGameStore.getState()._setPendingNewGame(0);
      }
      if (s._pendingClearSand) {
        this.workerHost?.requestClearSand();
        useGameStore.getState()._setPendingClearSand(false);
      }
    });

    // Keyboard shortcuts.
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P") {
        const s = useGameStore.getState();
        if (s.paused) {
          this.workerHost?.resume();
          s.setPaused(false);
        } else {
          this.workerHost?.pause();
          s.setPaused(true);
        }
      }
      if (e.key === "h" || e.key === "H") {
        this.workerHost?.requestHint();
      }
      if (e.key === "f" || e.key === "F") {
        this.workerHost?.requestShuffle();
      }
      if (e.key === "n" || e.key === "N") {
        const s = useGameStore.getState();
        this.workerHost?.requestNewGame(s.level + 1);
      }
    };
    window.addEventListener("keydown", this.keydownHandler);

    // Listen for worker events (match results, hints).
    this.workerHost["proxy"]?.onEvents((kind: string, data?: unknown) => {
      if (kind === "matched" && this.tilePass && data) {
        const d = data as { score: number; combo: number; path: { points: { col: number; row: number; layer: number }[]; turns: number }; element?: number };
        // Trigger path animation.
        // We need the element — get it from the first tile in the path.
        const startPt = d.path.points[0];
        const el = this.tilePass.state.boardElements[(startPt.col + startPt.row * this.tilePass.state.boardCols) * MAX_LAYERS + (startPt.layer ?? 0)];
        this.tilePass.state.pathAnim = {
          path: d.path,
          startTime: performance.now(),
          element: el >= 0 ? el : 0,
        };
        // Trigger crumble animations for the two matched tiles.
        const pts = d.path.points;
        const first = pts[0];
        const last = pts[pts.length - 1];
        this.tilePass.state.crumbleAnims.push(
          { col: first.col, row: first.row, element: el, startTime: performance.now() },
          { col: last.col, row: last.row, element: el, startTime: performance.now() },
        );
        // Update store score.
        useGameStore.getState().addScore(d.score);
        useGameStore.getState().setCombo(d.combo);
      }
      if (kind === "hint" && this.tilePass && data) {
        const d = data as { a: { col: number; row: number; layer: number }; b: { col: number; row: number; layer: number }; element: number };
        this.tilePass.state.hint = { a: d.a, b: d.b };
        // Clear hint after 3 seconds.
        setTimeout(() => {
          if (this.tilePass) this.tilePass.state.hint = null;
        }, 3000);
      }
      if (kind === "noHint") {
        // No valid moves — could auto-shuffle or show message.
      }
    });

    return true;
  }

  private resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private resizeTileCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    this.tileCanvas.width = w;
    this.tileCanvas.height = h;
    this.tileCanvas.style.width = "100%";
    this.tileCanvas.style.height = "100%";
    if (this.tilePass) {
      this.tilePass.computeLayout(w, h);
    }
  }

  private handleResize(): void {
    if (!this.device || !this.gridPass || !this.workerHost) return;
    this.resizeCanvas();
    this.resizeTileCanvas();
    const dims = computeGridDims(this.canvas.width, this.canvas.height);
    if (dims.w === this.gridW && dims.h === this.gridH) return;
    this.gridW = dims.w;
    this.gridH = dims.h;
    this.gridPass.resize(this.gridW, this.gridH);
    this.workerHost.resize(this.gridW, this.gridH);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.workerHost?.stop();
    if (this.resizeHandler) window.removeEventListener("resize", this.resizeHandler);
    if (this.storeUnsub) this.storeUnsub();
    if (this.keydownHandler) window.removeEventListener("keydown", this.keydownHandler);
    this.input?.destroy();
  }

  private frame(time: number): void {
    if (!this.running || !this.device || !this.context || !this.input || !this.gridReader || !this.gridPass || !this.tilePass) return;

    // Frame rate cap — don't render faster than 60fps to avoid burning CPU.
    if (time - this.lastFrameTime < SandjonggRenderer.MIN_FRAME_MS) {
      this.raf = requestAnimationFrame((t) => this.frame(t));
      return;
    }
    this.lastFrameTime = time;

    const dt = Math.min(0.1, (time - this.lastTime) / 1000);
    this.lastTime = time;
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    // Process click input.
    if (this.input.hasClick) {
      this.input.hasClick = false;
      const hit = this.tilePass.hitTest(this.input.mouseX, this.input.mouseY);
      if (hit) {
        const el = this.tilePass.state.boardElements[(hit.col + hit.row * this.tilePass.state.boardCols) * MAX_LAYERS + hit.layer];
        if (el >= 0) {
          // Tile click — handle selection logic.
          if (this.tilePass.state.selected === null) {
            // First selection.
            this.tilePass.state.selected = hit;
          } else {
            // Second selection — attempt match.
            const sel = this.tilePass.state.selected;
            this.tilePass.state.selected = null;
            this.workerHost?.requestMatch(sel.col, sel.row, sel.layer, hit.col, hit.row, hit.layer);
          }
        } else {
          // Clicked empty cell — deselect.
          this.tilePass.state.selected = null;
        }
      } else {
        // Clicked outside board — deselect.
        this.tilePass.state.selected = null;
      }
    }

    // Read board from SAB.
    this.updateBoardFromSAB();

    // Update tile pass layout if board dimensions changed.
    if (this.tilePass.state.boardCols !== this.prevBoardCols || this.tilePass.state.boardRows !== this.prevBoardRows) {
      this.prevBoardCols = this.tilePass.state.boardCols;
      this.prevBoardRows = this.tilePass.state.boardRows;
      this.tilePass.computeLayout(this.tileCanvas.width, this.tileCanvas.height);
    }

    // Draw tiles on Canvas2D.
    this.tilePass.draw();

    // Render sand on WebGPU.
    this.gridPass.updateGrid(this.gridReader.getGrid());
    this.gridPass.updateUniforms();

    const commandEncoder = this.device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    this.gridPass.render(pass);
    pass.end();
    this.device.queue.submit([commandEncoder.finish()]);

    // Update store stats from SAB.
    this.updateStatsFromSAB();

    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private updateBoardFromSAB(): void {
    if (!this.gridReader || !this.tilePass) return;
    // Reuse cached Int32Array views to avoid per-frame allocations.
    if (!this.cachedBoardElements || this.cachedBoardElements.buffer !== this.gridReader.sab) {
      this.cachedBoardElements = new Int32Array(this.gridReader.sab, BOARD_ELEMENT_OFFSET, MAX_TILES);
      this.cachedBoardMeta = new Int32Array(this.gridReader.sab, BOARD_META_OFFSET, 4);
    }
    const meta = this.cachedBoardMeta!;
    const cols = meta[0];
    const rows = meta[1];
    const layers = meta[2] || 1;
    if (cols > 0 && rows > 0) {
      this.tilePass.state.boardElements = this.cachedBoardElements;
      this.tilePass.state.boardCols = cols;
      this.tilePass.state.boardRows = rows;
      this.tilePass.state.boardLayers = layers;
    }
  }

  private updateStatsFromSAB(): void {
    if (!this.gridReader) return;
    const s = useGameStore.getState();
    // Throttle store updates.
    if (performance.now() - s.lastStatsUpdate < 100) return;
    const score = this.gridReader.getStat(STATS.SCORE);
    const combo = this.gridReader.getStat(STATS.COMBO);
    const level = this.gridReader.getStat(STATS.LEVEL);
    const tilesLeft = this.gridReader.getStat(STATS.TILES_LEFT);
    if (score !== s.score) s.setScore(score);
    if (combo !== s.combo) s.setCombo(combo);
    if (level !== s.level) s.setLevel(level);
    s.setTilesLeft(tilesLeft);
    s.setLastStatsUpdate(performance.now());
  }
}
