import { GameRenderer } from "@downdraft/core";
import { MATERIALS, SandGridPass } from "@downdraft/library-sand";
import { StickmanPass } from "@downdraft/library-stickman";
import SAND_FS from "../shaders/sand-render.wgsl?raw" with { type: "text" };
import { computeGridDims } from "../shared/constants";
import { FIELD, NUM_LAYERS, PLAYER, SimBufferReader, STATS } from "../shared/sim-buffer";
import { SandWorkerHost } from "../simulation/sand-worker-host";
import { useGameStore } from "../stores/game-store";
import { createInputHandler } from "./input-handler";

// Sim tick rate (must match sand-worker.ts TICK_MS = 1000/60).
const TICK_MS = 1000 / 60;
// If the player moves more than this many cells in one tick, snap instead of
// lerping (respawn / teleport). Normal max speed is 0.6 cells/tick.
const TELEPORT_SNAP_R2 = 10 * 10;

export class FallingSandRenderer extends GameRenderer {
  private gridPass: SandGridPass | null = null;
  private stickmanPass: StickmanPass | null = null;
  private input: ReturnType<typeof createInputHandler> | null = null;
  private workerHost: SandWorkerHost | null = null;
  private gridReader: SimBufferReader | null = null;
  private gridW = 0;
  private gridH = 0;
  private storeUnsub: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private prevMouseMiddle = false;
  private inspectorTimer = 0;

  // --- Player render interpolation ---
  private prevPx = 0;
  private prevPy = 0;
  private curPx = 0;
  private curPy = 0;
  private lastTick = -1;
  private renderAccumulator = 0;
  private interpInitialized = false;

  constructor(canvas: HTMLCanvasElement, _deterministic: boolean) {
    super(canvas, {
      mode: "2d",
      clearColor: { r: 0, g: 0, b: 0, a: 1 },
    });
    this.setViewportCount(0);
  }

  getFPS(): number { return super.getFPS(); }
  getCanvas(): HTMLCanvasElement { return super.getCanvas(); }
  getGridW(): number { return this.gridW; }
  getGridH(): number { return this.gridH; }
  getWorkerHost(): SandWorkerHost | null { return this.workerHost; }

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
    const canvas = this.getCanvas();
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.gridPass.resize(gridW, gridH, canvas.width, canvas.height);
    }
    await this.workerHost.loadGrids(grids, fields, gridW, gridH);
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

    this.input.selectedMaterial = useGameStore.getState().selectedMaterial;
    this.input.brushRadius = useGameStore.getState().brushRadius;
    this.storeUnsub = useGameStore.subscribe((s) => {
      if (this.input) {
        this.input.selectedMaterial = s.selectedMaterial;
        this.input.brushRadius = s.brushRadius;
      }
    });

    this.gridPass = new SandGridPass({
      device, format,
      gridW: this.gridW, gridH: this.gridH,
      fragmentShader: SAND_FS,
      numLayers: NUM_LAYERS,
    });
    this.gridPass.init(canvas.width, canvas.height);

    this.stickmanPass = new StickmanPass({ device, format });
    this.stickmanPass.setGridViewport(this.gridW, this.gridH);
    this.stickmanPass.init();

    this.workerHost = new SandWorkerHost(this.gridW, this.gridH);
    await this.workerHost.start();
    this.gridReader = this.workerHost.getReader();

    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P" || e.key === "Escape") {
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

    this.setCallbacks({
      afterFrame: (dt) => this.drawFrame(dt),
      onResize: () => this.handleResize(),
    });

    return true;
  }

  private handleResize(): void {
    if (!this.gridPass || !this.workerHost) return;
    const canvas = this.getCanvas();
    const dims = computeGridDims(canvas.width, canvas.height);
    if (dims.w === this.gridW && dims.h === this.gridH) {
      this.gridPass.resize(this.gridW, this.gridH, canvas.width, canvas.height);
      return;
    }
    this.gridW = dims.w;
    this.gridH = dims.h;
    this.gridPass.resize(this.gridW, this.gridH, canvas.width, canvas.height);
    this.stickmanPass?.setGridViewport(this.gridW, this.gridH);
    this.workerHost.resize(this.gridW, this.gridH);
  }

  stop(): void {
    super.stop();
    this.workerHost?.stop();
    this.stickmanPass?.destroy();
    this.gridPass?.destroy();
    this.input?.destroy();
    if (this.storeUnsub) this.storeUnsub();
    if (this.keydownHandler) window.removeEventListener("keydown", this.keydownHandler);
    this.destroy();
  }

  private drawFrame(dt: number): void {
    const device = this.getDevice();
    const context = this.getContext();
    const canvas = this.getCanvas();
    if (!device || !context || !this.input || !this.gridReader || !this.gridPass) return;

    this.input.update();
    this.writeInputToWorker();
    this.handlePicker();
    this.updateInspector(dt);

    for (let i = 0; i < NUM_LAYERS; i++) {
      this.gridPass.updateGrid(this.gridReader.getGrid(i), i);
    }
    this.gridPass.updateUniforms();

    if (this.stickmanPass && this.workerHost) {
      const px = this.workerHost.getPlayerF32(PLAYER.PX);
      const py = this.workerHost.getPlayerF32(PLAYER.PY);
      const pHealth = this.workerHost.getPlayerI32(PLAYER.HEALTH);
      const pOnGround = this.workerHost.getPlayerI32(PLAYER.ON_GROUND) !== 0;
      const pFacing = this.workerHost.getPlayerI32(PLAYER.FACING);
      const pAnimFrame = this.workerHost.getPlayerI32(PLAYER.ANIM_FRAME);
      const pVx = this.workerHost.getPlayerF32(PLAYER.VX);
      const pVy = this.workerHost.getPlayerF32(PLAYER.VY);

      const tick = this.gridReader.getStat(STATS.TICK);
      if (tick !== this.lastTick) {
        if (this.interpInitialized) {
          this.prevPx = this.curPx;
          this.prevPy = this.curPy;
          this.curPx = px;
          this.curPy = py;
          const ddx = this.curPx - this.prevPx;
          const ddy = this.curPy - this.prevPy;
          if (ddx * ddx + ddy * ddy > TELEPORT_SNAP_R2) {
            this.prevPx = this.curPx;
            this.prevPy = this.curPy;
          }
        } else {
          this.prevPx = px;
          this.prevPy = py;
          this.curPx = px;
          this.curPy = py;
          this.interpInitialized = true;
        }
        this.lastTick = tick;
        this.renderAccumulator = 0;
      }
      this.renderAccumulator = Math.min(TICK_MS, this.renderAccumulator + dt * 1000);
      const alpha = this.renderAccumulator / TICK_MS;
      const interpPx = this.prevPx + (this.curPx - this.prevPx) * alpha;
      const interpPy = this.prevPy + (this.curPy - this.prevPy) * alpha;

      this.stickmanPass.update({
        cx: interpPx, topY: interpPy, facing: pFacing, animFrame: pAnimFrame,
        health: pHealth, onGround: pOnGround, vx: pVx, vy: pVy,
      });
      const s = useGameStore.getState();
      if (s.health !== pHealth) s.setHealth(pHealth);
    }

    const commandEncoder = device.createCommandEncoder();

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

    const cv = context.getCurrentTexture().createView();
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

    device.queue.submit([commandEncoder.finish()]);
  }

  private writeInputToWorker(): void {
    if (!this.input || !this.workerHost) return;
    const canvas = this.getCanvas();
    const gx = Math.floor((this.input.mouseX / canvas.width) * this.gridW);
    const gy = Math.floor((this.input.mouseY / canvas.height) * this.gridH);

    // Don't paint while the pointer is over an interactive UI element.
    const uiBlocked = this.getUIInputRouter()?.isPointerOverUI() ?? false;

    this.workerHost.writeMouseDown(this.input.mouseDown && !uiBlocked);
    this.workerHost.writeMouseRight(this.input.mouseRight && !uiBlocked);
    this.workerHost.writeMousePos(gx, gy);
    this.workerHost.writeSelectedMaterial(this.input.selectedMaterial);
    this.workerHost.writeBrushRadius(this.input.brushRadius);

    const s = useGameStore.getState();
    this.workerHost.writeImpulseChance(s.settings.horizontalImpulseChance);
    this.workerHost.writeImpulseStrength(s.settings.horizontalImpulseStrength);
    this.workerHost.writeBrushMode(s.brushMode === "field" ? 1 : 0);
    this.workerHost.writeShowFields(s.showFieldOverlay);

    this.workerHost.writePlayerInput(
      this.input.left, this.input.right, this.input.up, this.input.down, this.input.jump
    );

    const FIELD_GRAVITY = 0, FIELD_TEMP = 1;
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
        case "windY":
          break;
      }
    }
  }

  private handlePicker(): void {
    if (!this.input || !this.gridReader) return;
    const canvas = this.getCanvas();
    const middle = this.input.mouseMiddle && !(this.getUIInputRouter()?.isPointerOverUI() ?? false);
    if (middle && !this.prevMouseMiddle) {
      const gx = Math.floor((this.input.mouseX / canvas.width) * this.gridW);
      const gy = Math.floor((this.input.mouseY / canvas.height) * this.gridH);
      if (gx >= 0 && gx < this.gridW && gy >= 0 && gy < this.gridH) {
        const grid = this.gridReader.getGrid(0);
        const packed = grid[gy * this.gridW + gx];
        const mat = packed & 0xff;
        if (mat > 0) {
          useGameStore.getState().setSelectedMaterial(mat);
        }
      }
    }
    this.prevMouseMiddle = middle;
  }

  private updateInspector(dt: number): void {
    if (!this.input || !this.gridReader) return;
    const canvas = this.getCanvas();
    this.inspectorTimer += dt;
    if (this.inspectorTimer < 0.066) return;
    this.inspectorTimer = 0;

    const gx = Math.floor((this.input.mouseX / canvas.width) * this.gridW);
    const gy = Math.floor((this.input.mouseY / canvas.height) * this.gridH);

    if (gx < 0 || gx >= this.gridW || gy < 0 || gy >= this.gridH) {
      const cur = useGameStore.getState().inspector;
      if (cur.valid) {
        useGameStore.getState().setInspector({ ...cur, valid: false, gx: -1, gy: -1 });
      }
      return;
    }

    const grid = this.gridReader.getGrid(0);
    const fields = this.gridReader.getFieldGrid(0);
    const packed = grid[gy * this.gridW + gx];
    const mat = packed & 0xff;
    const lifetime = (packed >> 8) & 0xff;
    const flags = (packed >> 16) & 0xff;
    const shade = flags & 0x03;

    const fi = (gy * this.gridW + gx) * 4;
    const gravity = fields[fi + FIELD.GRAVITY];
    const temperature = fields[fi + FIELD.TEMP];
    const windX = 0;
    const windY = 0;
    const windMag = 0;
    const windDir = 0;

    const matName = MATERIALS[mat]?.name ?? "Unknown";

    useGameStore.getState().setInspector({
      gx, gy, layer: 0,
      mat, matName, lifetime, shade,
      gravity, gravityMult: gravity / 128,
      temperature, temperatureMult: temperature / 128,
      windX, windY, windMag, windDir,
      valid: true,
    });
  }
}
