import { computeGridDims } from "../shared/constants";
import { SimBufferReader } from "../shared/sim-buffer";
import { AlchemyWorkerHost } from "../simulation/alchemy-worker-host";
import { useGameStore } from "../stores/game-store";
import { createInputHandler } from "./input-handler";
import { SandGridPass } from "./sand-grid-pass";

export class AlchemyRenderer {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private gridPass: SandGridPass | null = null;
  private input: ReturnType<typeof createInputHandler> | null = null;
  private workerHost: AlchemyWorkerHost | null = null;
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  getFPS(): number { return this.fps; }
  getCanvas(): HTMLCanvasElement { return this.canvas; }
  getGridW(): number { return this.gridW; }
  getGridH(): number { return this.gridH; }
  getWorkerHost(): AlchemyWorkerHost | null { return this.workerHost; }

  /** Snapshot the cauldron grid + fields for saving. */
  snapshotGrid(): { grid: Uint32Array; fields: Uint8Array; gridW: number; gridH: number } {
    if (!this.gridReader) return { grid: new Uint32Array(0), fields: new Uint8Array(0), gridW: 0, gridH: 0 };
    return {
      grid: new Uint32Array(this.gridReader.getGrid()),
      fields: new Uint8Array(this.gridReader.getFieldGrid()),
      gridW: this.gridW,
      gridH: this.gridH,
    };
  }

  clearAll(): void {
    this.workerHost?.clear();
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
    if (!navigator.gpu) {
      console.error("WebGPU not supported");
      return false;
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return false;
    this.device = await adapter.requestDevice();
    this.context = this.canvas.getContext("webgpu") as GPUCanvasContext;
    if (!this.context) return false;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });

    this.input = createInputHandler(this.canvas);

    this.resizeCanvas();
    const dims = computeGridDims(this.canvas.width, this.canvas.height);
    this.gridW = dims.w;
    this.gridH = dims.h;

    this.resizeHandler = () => this.handleResize();
    window.addEventListener("resize", this.resizeHandler);

    this.input.selectedMaterial = useGameStore.getState().selectedIngredient;
    this.input.brushRadius = useGameStore.getState().brushRadius;
    this.storeUnsub = useGameStore.subscribe((s) => {
      if (this.input) {
        this.input.selectedMaterial = s.selectedIngredient;
        this.input.brushRadius = s.brushRadius;
      }
    });

    this.gridPass = new SandGridPass(this.device, this.format, this.gridW, this.gridH);
    this.gridPass.init();

    this.workerHost = new AlchemyWorkerHost(this.gridW, this.gridH);
    await this.workerHost.start();
    this.gridReader = this.workerHost.getReader();

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
    };
    window.addEventListener("keydown", this.keydownHandler);

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

  private handleResize(): void {
    if (!this.device || !this.gridPass || !this.workerHost) return;
    this.resizeCanvas();
    const dims = computeGridDims(this.canvas.width, this.canvas.height);
    if (dims.w === this.gridW && dims.h === this.gridH) {
      return;
    }
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
  }

  private frame(time: number): void {
    if (!this.running || !this.device || !this.context || !this.input || !this.gridReader || !this.gridPass) return;
    const dt = Math.min(0.1, (time - this.lastTime) / 1000);
    this.lastTime = time;
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    this.writeInputToWorker();
    this.updateMixture();

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

    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private writeInputToWorker(): void {
    if (!this.input || !this.workerHost) return;
    this.workerHost.writeMouseDown(this.input.mouseDown);
    this.workerHost.writeMouseRight(this.input.mouseRight);
    this.workerHost.writeMousePos(this.input.mouseX, this.input.mouseY);
    if (this.input.hasLastMouse) {
      this.workerHost.writeLastMousePos(this.input.lastMouseX, this.input.lastMouseY);
    } else {
      this.workerHost.writeLastMousePos(this.input.mouseX, this.input.mouseY);
    }
    this.workerHost.writeSelectedMaterial(this.input.selectedMaterial);
    this.workerHost.writeBrushRadius(this.input.brushRadius);
  }

  /** Read the mixture histogram from the SAB and update the store's currentMixture. */
  private updateMixture(): void {
    if (!this.gridReader) return;
    const s = useGameStore.getState();
    // Throttle: only update every ~100ms to avoid excessive store writes
    if (performance.now() - s.lastMixtureUpdate < 100) return;
    const hist = this.gridReader.getMixtureHistogram();
    s.setMixtureHistogram(new Uint32Array(hist));
  }
}
