import { computeGridDims } from "../shared/constants";
import { FIELD, NUM_LAYERS, PLAYER, SimBufferReader } from "../shared/sim-buffer";
import { MATERIALS } from "../simulation/materials";
import { SandWorkerHost } from "../simulation/sand-worker-host";
import { useGameStore } from "../stores/game-store";
import { createInputHandler } from "./input-handler";
import { SandGridPass } from "./sand-grid-pass";
import { StickmanPass } from "./stickman-pass";

export class FallingSandRenderer {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private gridPass: SandGridPass | null = null;
  private stickmanPass: StickmanPass | null = null;
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
  private prevMouseMiddle = false;
  private inspectorTimer = 0;

  constructor(canvas: HTMLCanvasElement, _deterministic: boolean) {
    this.canvas = canvas;
  }

  getFPS(): number { return this.fps; }

  getCanvas(): HTMLCanvasElement { return this.canvas; }
  getGridW(): number { return this.gridW; }
  getGridH(): number { return this.gridH; }

  /** Snapshot all layer grids + fields from the SAB for saving. */
  snapshotGrids(): { grids: Uint32Array[]; fields: Uint8Array[]; gridW: number; gridH: number } {
    if (!this.gridReader) return { grids: [], fields: [], gridW: 0, gridH: 0 };
    const grids: Uint32Array[] = [];
    const fields: Uint8Array[] = [];
    for (let i = 0; i < NUM_LAYERS; i++) {
      grids.push(new Uint32Array(this.gridReader.getGrid(i)));
      fields.push(new Uint8Array(this.gridReader.getFieldGrid(i)));
    }
    return { grids, fields, gridW: this.gridW, gridH: this.gridH };
  }

  clearAll(): void {
    this.workerHost?.clear();
  }

  async loadSave(grids: Uint32Array[], fields: Uint8Array[], gridW: number, gridH: number): Promise<void> {
    if (!this.workerHost || !this.gridPass) return;
    // If grid dimensions changed, resize the renderer too
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.gridPass.resize(gridW, gridH, this.canvas.width, this.canvas.height);
    }
    await this.workerHost.loadGrids(grids, fields, gridW, gridH);
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

    this.input.selectedMaterial = useGameStore.getState().selectedMaterial;
    this.input.brushRadius = useGameStore.getState().brushRadius;
    this.storeUnsub = useGameStore.subscribe((s) => {
      if (this.input) {
        this.input.selectedMaterial = s.selectedMaterial;
        this.input.brushRadius = s.brushRadius;
      }
    });

    this.gridPass = new SandGridPass(this.device, this.format, this.gridW, this.gridH, NUM_LAYERS);
    this.gridPass.init(this.canvas.width, this.canvas.height);

    this.stickmanPass = new StickmanPass(this.device, this.format, this.gridW, this.gridH);
    this.stickmanPass.init();

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

    const dims = computeGridDims(this.canvas.width, this.canvas.height);
    if (dims.w === this.gridW && dims.h === this.gridH) {
      // Canvas size changed but grid dims didn't — still need to recreate layer targets
      this.gridPass.resize(this.gridW, this.gridH, this.canvas.width, this.canvas.height);
      return;
    }

    this.gridW = dims.w;
    this.gridH = dims.h;
    this.gridPass.resize(this.gridW, this.gridH, this.canvas.width, this.canvas.height);
    this.stickmanPass?.resize(this.gridW, this.gridH);
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
    this.stickmanPass?.destroy();
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
    this.handlePicker();
    this.updateInspector(dt);

    // Update all layer grids
    for (let i = 0; i < NUM_LAYERS; i++) {
      this.gridPass.updateGrid(i, this.gridReader.getGrid(i));
    }
    this.gridPass.updateUniforms();

    // Update stickman uniforms from shared buffer
    if (this.stickmanPass && this.workerHost) {
      const pHealth = this.workerHost.getPlayerI32(PLAYER.HEALTH);
      const pOnGround = this.workerHost.getPlayerI32(PLAYER.ON_GROUND) !== 0;
      this.stickmanPass.update(
        this.workerHost.getPlayerF32(PLAYER.PX),
        this.workerHost.getPlayerF32(PLAYER.PY),
        this.workerHost.getPlayerI32(PLAYER.FACING),
        this.workerHost.getPlayerI32(PLAYER.ANIM_FRAME),
        pHealth,
        pOnGround,
        this.workerHost.getPlayerF32(PLAYER.VX),
        this.workerHost.getPlayerF32(PLAYER.VY),
      );
      // Sync player health to store
      const s = useGameStore.getState();
      if (s.health !== pHealth) s.setHealth(pHealth);
    }

    const commandEncoder = this.device.createCommandEncoder();

    // Phase 1: Render each layer (except the frontmost) to its offscreen target.
    // These offscreen targets are sampled by the next layer for reflections.
    for (let layer = 0; layer < NUM_LAYERS - 1; layer++) {
      const offscreenView = this.gridPass.getOffscreenView(layer)!;
      const offscreenPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: offscreenView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      this.gridPass.render(offscreenPass, layer);
      offscreenPass.end();
    }

    // Phase 2: Render all layers to the canvas (back to front).
    // Layer 0 clears the canvas; subsequent layers load and alpha-blend on top.
    // Each layer samples the previous layer's offscreen target for reflections.
    const cv = this.context.getCurrentTexture().createView();
    for (let layer = 0; layer < NUM_LAYERS; layer++) {
      const isFirst = layer === 0;
      const canvasPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: cv,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: isFirst ? "clear" : "load",
          storeOp: "store",
        }],
      });
      this.gridPass.render(canvasPass, layer);
      canvasPass.end();
    }

    // Phase 3: Render stickman player on top of all layers
    if (this.stickmanPass) {
      const stickmanPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: cv,
          loadOp: "load",
          storeOp: "store",
        }],
      });
      this.stickmanPass.render(stickmanPass);
      stickmanPass.end();
    }

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

    const s = useGameStore.getState();
    this.workerHost.writeImpulseChance(s.settings.horizontalImpulseChance);
    this.workerHost.writeImpulseStrength(s.settings.horizontalImpulseStrength);
    this.workerHost.writeBrushMode(s.brushMode === "field" ? 1 : 0);
    this.workerHost.writeShowFields(s.showFieldOverlay);
    this.workerHost.writeActiveLayer(s.activeLayer);

    // Player input
    this.workerHost.writePlayerInput(
      this.input.left, this.input.right, this.input.up, this.input.down, this.input.jump
    );

    const FIELD_GRAVITY = 0, FIELD_TEMP = 1, FIELD_WIND_X = 2, FIELD_WIND_Y = 3;
    if (s.brushMode === "field") {
      switch (s.fieldType) {
        case "gravity":
          this.workerHost.writeFieldType(FIELD_GRAVITY);
          this.workerHost.writeFieldValue(s.fieldGravity);
          break;
        case "temperature":
          this.workerHost.writeFieldType(FIELD_TEMP);
          this.workerHost.writeFieldValue(s.fieldTemperature);
          break;
        case "windX":
          this.workerHost.writeFieldType(FIELD_WIND_X);
          this.workerHost.writeFieldValue(s.fieldWindX & 0xff);
          break;
        case "windY":
          this.workerHost.writeFieldType(FIELD_WIND_Y);
          this.workerHost.writeFieldValue(s.fieldWindY & 0xff);
          break;
      }
    }
  }

  /** Middle-click picker: read the material under the cursor and select it. */
  private handlePicker(): void {
    if (!this.input || !this.gridReader) return;
    const middle = this.input.mouseMiddle;
    // Detect rising edge (click moment)
    if (middle && !this.prevMouseMiddle) {
      const gx = Math.floor((this.input.mouseX / this.canvas.width) * this.gridW);
      const gy = Math.floor((this.input.mouseY / this.canvas.height) * this.gridH);
      if (gx >= 0 && gx < this.gridW && gy >= 0 && gy < this.gridH) {
        const layer = useGameStore.getState().activeLayer;
        const grid = this.gridReader.getGrid(layer);
        const packed = grid[gy * this.gridW + gx];
        const mat = packed & 0xff;
        if (mat > 0) {
          useGameStore.getState().setSelectedMaterial(mat);
        }
      }
    }
    this.prevMouseMiddle = middle;
  }

  /**
   * Live cell inspector: reads cell + field data at the cursor position and
   * updates the store. Throttled to ~15fps to avoid excessive React re-renders.
   */
  private updateInspector(dt: number): void {
    if (!this.input || !this.gridReader) return;
    this.inspectorTimer += dt;
    if (this.inspectorTimer < 0.066) return; // ~15fps
    this.inspectorTimer = 0;

    const gx = Math.floor((this.input.mouseX / this.canvas.width) * this.gridW);
    const gy = Math.floor((this.input.mouseY / this.canvas.height) * this.gridH);
    const layer = useGameStore.getState().activeLayer;

    if (gx < 0 || gx >= this.gridW || gy < 0 || gy >= this.gridH) {
      const cur = useGameStore.getState().inspector;
      if (cur.valid) {
        useGameStore.getState().setInspector({ ...cur, valid: false, gx: -1, gy: -1 });
      }
      return;
    }

    const grid = this.gridReader.getGrid(layer);
    const fields = this.gridReader.getFieldGrid(layer);
    const packed = grid[gy * this.gridW + gx];
    const mat = packed & 0xff;
    const lifetime = (packed >> 8) & 0xff;
    const flags = (packed >> 16) & 0xff;
    const shade = flags & 0x03;

    const fi = (gy * this.gridW + gx) * 4;
    const gravity = fields[fi + FIELD.GRAVITY];
    const temperature = fields[fi + FIELD.TEMP];
    const windX = (fields[fi + FIELD.WIND_X] << 24) >> 24; // sign-extend i8
    const windY = (fields[fi + FIELD.WIND_Y] << 24) >> 24;
    const windMag = Math.sqrt(windX * windX + windY * windY);
    const windDir = Math.atan2(windY, windX) * 180 / Math.PI;

    const matName = MATERIALS[mat]?.name ?? "Unknown";

    useGameStore.getState().setInspector({
      gx, gy, layer,
      mat, matName, lifetime, shade,
      gravity, gravityMult: gravity / 128,
      temperature, temperatureMult: temperature / 128,
      windX, windY, windMag, windDir,
      valid: true,
    });
  }
}
