import { GameRenderer } from "@downdraft/core";
import { computeGridDims } from "../shared/constants";
import { SimBufferReader } from "../shared/sim-buffer";
import { AlchemyWorkerHost } from "../simulation/alchemy-worker-host";
import { useGameStore } from "../stores/game-store";
import { createInputHandler } from "./input-handler";
import { SandGridPass } from "./sand-grid-pass";

export class AlchemyRenderer extends GameRenderer {
  private gridPass: SandGridPass | null = null;
  private input: ReturnType<typeof createInputHandler> | null = null;
  private workerHost: AlchemyWorkerHost | null = null;
  private gridReader: SimBufferReader | null = null;
  private gridW = 0;
  private gridH = 0;
  private storeUnsub: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas, {
      mode: "2d",
      clearColor: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
    });
    // 2D mode with viewportCount=0: we do custom rendering in afterFrame
    this.setViewportCount(0);
  }

  getFPS(): number { return super.getFPS(); }
  getCanvas(): HTMLCanvasElement { return super.getCanvas(); }
  getGridW(): number { return this.gridW; }
  getGridH(): number { return this.gridH; }
  getWorkerHost(): AlchemyWorkerHost | null { return this.workerHost; }

  /**
   * Inject a pre-created worker host (e.g. from startGame()'s sim factory).
   * When set, init() will use this host instead of creating its own.
   */
  setWorkerHost(host: AlchemyWorkerHost): void {
    this.workerHost = host;
  }

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
    const ok = await super.init();
    if (!ok) return false;

    const device = this.getDevice()!;
    const format = this.getFormat();
    const canvas = this.getCanvas();

    this.input = createInputHandler(canvas);

    const dims = computeGridDims(canvas.width, canvas.height);
    this.gridW = dims.w;
    this.gridH = dims.h;

    this.input.selectedMaterial = useGameStore.getState().selectedIngredient;
    this.input.brushRadius = useGameStore.getState().brushRadius;
    this.storeUnsub = useGameStore.subscribe((s) => {
      if (this.input) {
        this.input.selectedMaterial = s.selectedIngredient;
        this.input.brushRadius = s.brushRadius;
      }
    });

    this.gridPass = new SandGridPass(device, format, this.gridW, this.gridH);
    this.gridPass.init();

    if (!this.workerHost) {
      this.workerHost = new AlchemyWorkerHost(this.gridW, this.gridH);
      await this.workerHost.start();
    } else if (this.workerHost.gridW !== this.gridW || this.workerHost.gridH !== this.gridH) {
      await this.workerHost.resize(this.gridW, this.gridH);
    }
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

    // Wire the afterFrame callback for custom 2D rendering
    this.setCallbacks({
      afterFrame: () => this.renderGrid(),
      onResize: () => this.handleResize(),
    });

    return true;
  }

  private handleResize(): void {
    if (!this.gridPass || !this.workerHost) return;
    const canvas = this.getCanvas();
    const dims = computeGridDims(canvas.width, canvas.height);
    if (dims.w === this.gridW && dims.h === this.gridH) {
      return;
    }
    this.gridW = dims.w;
    this.gridH = dims.h;
    this.gridPass.resize(this.gridW, this.gridH);
    this.workerHost.resize(this.gridW, this.gridH);
  }

  stop(): void {
    super.stop();
    this.workerHost?.stop();
    if (this.storeUnsub) this.storeUnsub();
    if (this.keydownHandler) window.removeEventListener("keydown", this.keydownHandler);
    this.destroy();
  }

  private renderGrid(): void {
    const device = this.getDevice();
    const context = this.getContext();
    if (!device || !context || !this.input || !this.gridReader || !this.gridPass) return;

    this.writeInputToWorker();
    this.updateMixture();

    this.gridPass.updateGrid(this.gridReader.getGrid());
    this.gridPass.updateUniforms();

    const commandEncoder = device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    this.gridPass.render(pass);
    pass.end();
    device.queue.submit([commandEncoder.finish()]);
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
