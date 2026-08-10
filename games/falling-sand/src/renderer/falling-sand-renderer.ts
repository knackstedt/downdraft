import { computeGridDims } from "../shared/constants";
import { SimBufferReader } from "../shared/sim-buffer";
import { SandWorkerHost } from "../simulation/sand-worker-host";
import { useGameStore } from "../stores/game-store";
import { createInputHandler } from "./input-handler";
import { SandGridPass } from "./sand-grid-pass";

export class FallingSandRenderer {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private gridPass: SandGridPass | null = null;
  private input: ReturnType<typeof createInputHandler> | null = null;
  private workerHost: SandWorkerHost | null = null;
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

  constructor(canvas: HTMLCanvasElement, _deterministic: boolean) {
    this.canvas = canvas;
  }

  getFPS(): number { return this.fps; }

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

    // Compute initial grid dimensions from viewport
    const dims = computeGridDims(window.innerWidth, window.innerHeight);
    this.gridW = dims.w;
    this.gridH = dims.h;

    this.resizeCanvas();
    this.resizeHandler = () => this.handleResize();
    window.addEventListener("resize", this.resizeHandler);

    // Sync material selection from the React store
    this.input.selectedMaterial = useGameStore.getState().selectedMaterial;
    this.storeUnsub = useGameStore.subscribe((s) => {
      if (this.input) this.input.selectedMaterial = s.selectedMaterial;
    });

    this.gridPass = new SandGridPass(this.device, this.format, this.gridW, this.gridH);
    this.gridPass.init();

    // Start the sim worker with initial grid dimensions
    this.workerHost = new SandWorkerHost(this.gridW, this.gridH);
    await this.workerHost.start();
    this.gridReader = this.workerHost.getReader();

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

    const dims = computeGridDims(window.innerWidth, window.innerHeight);
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

    const grid = this.gridReader.getGrid();

    const commandEncoder = this.device.createCommandEncoder();
    const cv = this.context.getCurrentTexture().createView();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: cv,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    this.gridPass.updateGrid(grid);
    this.gridPass.render(pass);
    pass.end();
    this.device.queue.submit([commandEncoder.finish()]);

    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private writeInputToWorker(): void {
    if (!this.input || !this.workerHost) return;

    const gx = Math.floor((this.input.mouseX / this.canvas.width) * this.gridW);
    const gy = Math.floor((this.input.mouseY / this.canvas.height) * this.gridH);

    this.workerHost.writeMouseDown(this.input.mouseDown);
    this.workerHost.writeMouseRight(this.input.mouseRight);
    this.workerHost.writeMousePos(gx, gy);
    this.workerHost.writeSelectedMaterial(this.input.selectedMaterial);
    this.workerHost.writeBrushRadius(this.input.brushRadius);
    this.workerHost.writeMagnet(this.input.magnet);
  }
}
