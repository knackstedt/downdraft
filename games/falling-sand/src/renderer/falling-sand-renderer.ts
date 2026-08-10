import { GRID_H, GRID_W } from "../shared/constants";
import { SandWorld } from "../simulation/sand-world";
import { createInputHandler } from "./input-handler";
import { SandGridPass } from "./sand-grid-pass";

const TARGET_FPS = 60;

export class FallingSandRenderer {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private world: SandWorld;
  private gridPass: SandGridPass | null = null;
  private input = createInputHandler(document.createElement("canvas"));
  private running = false;
  private raf = 0;
  private lastTime = 0;
  private frameCount = 0;
  private fps = 0;
  private fpsTimer = 0;

  constructor(canvas: HTMLCanvasElement, _deterministic: boolean) {
    this.canvas = canvas;
    this.world = new SandWorld();
    this.input = createInputHandler(canvas);
  }

  getFPS(): number {
    return this.fps;
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

    this.gridPass = new SandGridPass(this.device, this.format);
    this.gridPass.init();
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(time: number): void {
    if (!this.running || !this.device || !this.context) return;
    const dt = Math.min(0.1, (time - this.lastTime) / 1000);
    this.lastTime = time;
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    this.updateInput();
    this.world.step();

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
    this.gridPass!.updateGrid(this.world.grid);
    this.gridPass!.render(pass);
    pass.end();
    this.device.queue.submit([commandEncoder.finish()]);

    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private updateInput(): void {
    const gx = Math.floor(this.input.mouseX / this.canvas.width * GRID_W);
    const gy = Math.floor(this.input.mouseY / this.canvas.height * GRID_H);

    if (this.input.mouseDown) {
      this.world.paintMaterial(gx, gy, this.input.selectedMaterial, this.input.brushRadius);
    }
    if (this.input.mouseRight) {
      this.world.ignite(gx, gy, 3);
    }

    if (this.input.magnet) {
      this.world.setMagnet(gx, gy, true);
    } else {
      this.world.setMagnet(0, 0, false);
    }
  }
}
