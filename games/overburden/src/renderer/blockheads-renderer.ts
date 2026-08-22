// ============================================================================
// BlockheadsRenderer — main render orchestrator
//
// Manages the WebGPU device, the sim worker host, the block grid render pass,
// the stickman render pass, the camera, and input. Renders the active grid
// + blockhead characters each frame.
// ============================================================================

import { GPUDeviceManager } from "@downdraft/core";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR, BLOCK_DIRT, BLOCK_GRASS, BLOCK_STONE, BLOCK_WOOD,
} from "../shared/constants";
import { SimBufferReader } from "../shared/sim-buffer";
import { BlockheadsWorkerHost } from "../simulation/blockheads-worker-host";
import { BlockGridPass3D } from "./block-grid-pass-3d";
import { Camera } from "./camera";
import {
    createInputHandler, type BlockheadsInputState,
} from "./input-handler";
import { invert, rayToZ0, unprojectScreen } from "./matrix";
import { SkyPass } from "./sky-pass";
import { StickmanPass } from "./stickman-pass";

// Hotbar block IDs (selectable with number keys 1-9)
const HOTBAR_BLOCKS = [
  BLOCK_DIRT,
  BLOCK_GRASS,
  BLOCK_STONE,
  BLOCK_WOOD,
  BLOCK_AIR, // slot 5: empty
  BLOCK_AIR,
  BLOCK_AIR,
  BLOCK_AIR,
  BLOCK_AIR,
];

export class BlockheadsRenderer {
  private canvas: HTMLCanvasElement;
  private deviceManager = new GPUDeviceManager();
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private running = false;
  private raf = 0;
  private lastTime = 0;
  private frameCount = 0;
  private fps = 0;
  private fpsTimer = 0;
  private inputInterval = 0; // separate interval for input processing (works even when render loop is paused)

  // Render passes
  private blockGridPass: BlockGridPass3D | null = null;
  private stickmanPass: StickmanPass | null = null;
  private skyPass: SkyPass | null = null;

  // Camera
  camera: Camera;

  // Smoothed blockhead render position (interpolates between sim ticks)
  private smoothBhX = 0;
  private smoothBhY = 0;
  private smoothBhInit = false;

  // Sim worker
  workerHost: BlockheadsWorkerHost | null = null;
  private simReader: SimBufferReader | null = null;
  private simReady = false;

  // Input
  private input: BlockheadsInputState | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new Camera(canvas.width, canvas.height);
  }

  getFPS(): number {
    return this.fps;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getInput(): BlockheadsInputState | null {
    return this.input;
  }

  getSimReader(): SimBufferReader | null {
    return this.simReader;
  }

  async init(): Promise<boolean> {
    this.device = await this.deviceManager.requestDevice();
    if (!this.device) return false;

    // Resize canvas BEFORE configuring the WebGPU context
    this.resizeCanvas();
    // Camera uses CSS pixel dimensions (not device pixels) so zoom=96
    // means 96 CSS pixels per block regardless of devicePixelRatio.
    const dpr = window.devicePixelRatio || 1;
    this.camera.resize(this.canvas.width / dpr, this.canvas.height / dpr);

    this.context = this.canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!this.context) return false;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });

    // Create render passes (3D block grid with depth buffer)
    this.blockGridPass = new BlockGridPass3D(this.device, this.format);
    this.blockGridPass.init();

    this.stickmanPass = new StickmanPass(this.device, this.format);
    this.stickmanPass.init();

    this.skyPass = new SkyPass(this.device, this.format);
    this.skyPass.init();

    // Start the sim worker
    this.workerHost = new BlockheadsWorkerHost();
    this.simReader = new SimBufferReader(this.workerHost.getSimBuffer() as ArrayBufferLike);
    await this.workerHost.start();
    this.simReady = this.workerHost.isReady();

    // Set initial camera to center of active grid, at surface level.
    // The active grid is centered at SURFACE_Y in world coords, so the surface
    // is at active grid Y = ACTIVE_GRID_H/2 = 224.
    this.camera.setCenter(ACTIVE_GRID_W / 2, ACTIVE_GRID_H / 2);

    // Set up input handlers
    this.input = createInputHandler(this.canvas);

    // Listen for window resize
    window.addEventListener("resize", this.resizeHandler);

    return true;
  }

  private resizeHandler = (): void => {
    this.resizeCanvas();
    const dpr = window.devicePixelRatio || 1;
    this.camera.resize(this.canvas.width / dpr, this.canvas.height / dpr);
  };

  private resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // Ensure the canvas CSS size matches the window (not the device-pixel size)
    this.canvas.style.width = window.innerWidth + "px";
    this.canvas.style.height = window.innerHeight + "px";
  }

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
    // Start a separate input processing interval so input keeps flowing
    // to the sim worker even when the render loop is paused (deterministic mode).
    // The worker runs its own loop and needs fresh input every frame.
    if (!this.inputInterval) {
      this.inputInterval = setInterval(() => this.updateInput(), 16) as unknown as number;
    }
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    // NOTE: do NOT clear the input interval here — the sim worker still needs
    // input even when rendering is paused (deterministic mode).
  }

  renderOneFrame(): void {
    if (this.running) return;
    if (!this.device || !this.context || !this.blockGridPass) return;
    this.lastTime = performance.now();
    this.running = true;
    this.loop();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
  }

  async captureScreenshot(): Promise<Blob | null> {
    if (!this.running) {
      this.renderOneFrame();
    }
    return new Promise((resolve) => {
      this.canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.inputInterval) clearInterval(this.inputInterval);
    this.inputInterval = 0;
    window.removeEventListener("resize", this.resizeHandler);
    this.stickmanPass?.destroy();
    this.skyPass?.destroy();
    await this.workerHost?.shutdown();
  }

  private updateInput(): void {
    if (!this.input || !this.simReader) return;

    // Handle zoom — dynamic zoom with scroll wheel.
    // Each zoom step multiplies/divides by a factor for smooth zoom.
    if (this.input.zoomDelta !== 0) {
      const factor = this.input.zoomDelta > 0 ? 1.2 : 1 / 1.2;
      this.camera.zoom = Math.max(Camera.MIN_ZOOM, Math.min(Camera.MAX_ZOOM, this.camera.zoom * factor));
      this.input.zoomDelta = 0;
    }

    // Handle mouse pan (middle button or right button when not placing)
    // Right-click is used for placing, so only pan with middle button
    // (The canvas mousedown handler in input-handler.ts doesn't handle middle,
    //  so we handle it here directly)
    // Actually, let's handle pan in the renderer directly:

    // Convert mouse screen coords to active-grid coords using 3D ray-cast.
    // The 3D perspective camera makes the old 2D orthographic formula
    // completely wrong, so we unproject through the view-projection matrix
    // and intersect the resulting ray with the Z=0 plane.
    let grid: { x: number; y: number };
    const vp = this.blockGridPass?.getViewProj();
    if (vp) {
      const invVP = invert(vp);
      if (invVP) {
        const ray = unprojectScreen(
          this.input.mouseX, this.input.mouseY,
          this.camera.canvasW, this.camera.canvasH,
          invVP,
        );
        const hit = rayToZ0(ray.origin, ray.dir);
        grid = hit ?? { x: this.camera.x, y: this.camera.y };
      } else {
        grid = this.camera.screenToGrid(this.input.mouseX, this.input.mouseY);
      }
    } else {
      grid = this.camera.screenToGrid(this.input.mouseX, this.input.mouseY);
    }

    // Determine placing block from hotbar
    const placeBlockId = HOTBAR_BLOCKS[this.input.selectedSlot] ?? BLOCK_AIR;

    // Write input to SAB
    const inp = this.simReader.inputInt32;
    const inpF = this.simReader.inputF32;
    // Convert active grid coords to world coords for the worker
    const originCx = this.simReader.getOriginCx();
    const originCy = this.simReader.getOriginCy();
    const worldX = grid.x + originCx * 64;
    const worldY = grid.y + originCy * 64;
    inp[0] = this.input.left ? 1 : 0;
    inp[1] = this.input.right ? 1 : 0;
    inp[2] = this.input.up ? 1 : 0;
    inp[3] = this.input.down ? 1 : 0;
    inp[4] = this.input.jump ? 1 : 0;
    inp[5] = this.input.noclip ? 1 : 0;
    inp[6] = this.input.mouseDown ? 1 : 0;  // mine active
    inp[7] = (this.input.mouseRight && placeBlockId !== BLOCK_AIR) ? 1 : 0;  // place active
    inpF[8] = worldX;  // mine X (world coords for worker)
    inpF[9] = worldY;  // mine Y
    inpF[10] = worldX; // place X
    inpF[11] = worldY; // place Y
    inp[12] = placeBlockId;
    // Camera position in active grid coords (for worker reference)
    inpF[13] = this.camera.x;
    inpF[14] = this.camera.y;
  }

  private loop = (): void => {
    if (!this.running || !this.device || !this.context || !this.blockGridPass) return;

    const now = performance.now();
    const elapsed = now - this.lastTime;
    this.lastTime = now;
    const dt = Math.min(elapsed, 100) / 1000; // seconds, capped

    // Process input → SAB
    this.updateInput();

    // Smooth the blockhead's rendered position. The sim updates at 30Hz but
    // rendering can run at 300fps, so without interpolation the player and
    // camera stutter (same position for ~10 frames, then a jump).
    // Use frame-rate-independent exponential smoothing:
    //   lerp = 1 - exp(-rate * dt)
    // rate=15 means convergence to ~95% in 200ms regardless of fps.
    const smoothRate = 15.0;
    const smoothLerp = 1 - Math.exp(-smoothRate * dt);
    if (this.simReader) {
      const bhCount = this.simReader.getBlockheadCount();
      if (bhCount > 0) {
        const bh = this.simReader.getBlockhead(0);
        const targetX = bh[0];
        const targetY = bh[1];
        if (!this.smoothBhInit) {
          this.smoothBhX = targetX;
          this.smoothBhY = targetY;
          this.smoothBhInit = true;
        } else {
          this.smoothBhX += (targetX - this.smoothBhX) * smoothLerp;
          this.smoothBhY += (targetY - this.smoothBhY) * smoothLerp;
        }
      }
    }

    // Camera follows the smoothed blockhead position (same smoothing rate)
    if (this.simReader && !this.camera.isPanning()) {
      const bhCount = this.simReader.getBlockheadCount();
      if (bhCount > 0) {
        const targetX = this.smoothBhX + 0.5; // center of 1-wide body
        const targetY = this.smoothBhY + 1.0; // center of 2-tall body
        this.camera.x += (targetX - this.camera.x) * smoothLerp;
        this.camera.y += (targetY - this.camera.y) * smoothLerp;
      }
    }

    // Update canvas size if needed (camera uses CSS pixels)
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    if (this.camera.canvasW !== w || this.camera.canvasH !== h) {
      this.camera.resize(w, h);
    }

    // Read daylight from SAB (0-15, from day/night cycle)
    const daylight = this.simReader ? this.simReader.getDaylight() : 15;
    const daylightNorm = daylight / 15; // 0..1 for shader

    // Upload grid data from SAB (builds 3D instance data)
    if (this.simReader) {
      this.blockGridPass.updateGrid(this.simReader.foreground, this.simReader.background);
      this.blockGridPass.updateLight(this.simReader.light);
      this.blockGridPass.updateExplored(this.simReader.explored);
    }

    // Ensure depth texture matches canvas size (device pixels, not CSS)
    this.blockGridPass.ensureDepthTexture(this.canvas.width, this.canvas.height);

    // Update 3D camera uniforms + mining VFX
    const mineX = this.simReader ? this.simReader.getMineX() : -1;
    const mineY = this.simReader ? this.simReader.getMineY() : -1;
    const mineDamage = this.simReader ? this.simReader.getMineDamage() : 0;
    this.blockGridPass.updateCamera(
      this.camera.x,
      this.camera.y,
      this.camera.zoom,
      this.camera.canvasW,
      this.camera.canvasH,
      daylightNorm,
      mineX,
      mineY,
      mineDamage,
    );

    // Update stickman pass with 3D perspective (use smoothed position)
    if (this.simReader && this.stickmanPass) {
      const bhCount = this.simReader.getBlockheadCount();
      if (bhCount > 0) {
        const bh = this.simReader.getBlockhead(0);
        this.stickmanPass.update3D(
          this.smoothBhX, this.smoothBhY,
          bh[4], // facing
          bh[6], // animFrame
          this.blockGridPass.getViewProj(),
          this.camera.canvasW, this.camera.canvasH,
          bh[7], // health
          bh[5] !== 0, // onGround
          bh[2], // vx
        );
      }
    }

    // Update sky pass with current daylight level
    if (this.skyPass) {
      this.skyPass.update(this.camera.canvasW, this.camera.canvasH, daylight);
    }

    // Render with depth buffer for 3D occlusion
    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const depthView = this.blockGridPass.getDepthTextureView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0.1, g: 0.1, b: 0.18, a: 1.0 },
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        },
      ],
      depthStencilAttachment: depthView ? {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear" as GPULoadOp,
        depthStoreOp: "store" as GPUStoreOp,
      } : undefined,
    });
    // Render sky first (full-screen background, no depth)
    this.skyPass?.render(pass);
    // Render 3D block grid (with depth testing)
    this.blockGridPass.render(pass);
    // Render stickman on top (with depth testing)
    if (this.simReader && this.simReader.getBlockheadCount() > 0) {
      this.stickmanPass?.render(pass);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    // FPS tracking
    this.frameCount++;
    this.fpsTimer += elapsed;
    if (this.fpsTimer >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / this.fpsTimer);
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    this.raf = requestAnimationFrame(this.loop);
  };
}
