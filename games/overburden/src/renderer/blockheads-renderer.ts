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
    BLOCK_AIR, BLOCK_DIRT, BLOCK_GRASS, BLOCK_LADDER, BLOCK_ROPE,
    BLOCK_SAND, BLOCK_SCAFFOLDING, BLOCK_STONE, BLOCK_TORCH, BLOCK_WOOD,
    CHUNK_H, CHUNK_W, TICK_MS,
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

// Hotbar block IDs (selectable with number keys 1-9).
// Each slot maps to a placeable block; placing consumes the matching item
// from the blockhead's inventory (handled in the sim worker).
const HOTBAR_BLOCKS = [
  BLOCK_DIRT,
  BLOCK_GRASS,
  BLOCK_STONE,
  BLOCK_WOOD,
  BLOCK_SAND,
  BLOCK_TORCH,
  BLOCK_LADDER,
  BLOCK_ROPE,
  BLOCK_SCAFFOLDING,
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
  private debugNoShadows = false;
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

  // Tick-based interpolation for smooth rendering at display framerate.
  // The sim writes positions at 30Hz; we lerp between prev and cur sim
  // positions using the wall-clock time since the last tick arrived.
  // Everything is tracked in WORLD coords (active-grid pos + origin *
  // CHUNK_W) so chunk-boundary crossings don't cause jumps.
  private prevWorldX = 0;
  private prevWorldY = 0;
  private curWorldX = 0;
  private curWorldY = 0;
  private lastTick = -1;
  private tickArrivalTime = 0; // wall-clock ms when we first saw the current tick
  private interpInit = false;
  // Interpolated world position (computed each frame from prev/cur + alpha)
  private interpWorldX = 0;
  private interpWorldY = 0;

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

  getWorkerHost(): BlockheadsWorkerHost | null {
    return this.workerHost;
  }

  /** Expose camera for debug overlays (chunk grid, etc.). */
  getCamera(): Camera {
    return this.camera;
  }

  /** Active grid origin + size in active-grid coords (for debug overlay). */
  getActiveGridOrigin(): { x: number; y: number; w: number; h: number } {
    return { x: 0, y: 0, w: ACTIVE_GRID_W, h: ACTIVE_GRID_H };
  }

  /** Toggle debug mode: disables fog-of-war + shadow darkening (F1). */
  setDebugNoShadows(enabled: boolean): void {
    this.debugNoShadows = enabled;
    this.blockGridPass?.setDebugNoShadows(enabled);
  }

  getDebugNoShadows(): boolean {
    return this.debugNoShadows;
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

    // Process input → SAB
    this.updateInput();

    // --- Tick-based interpolation (world coords) ---
    // The sim writes positions at 30Hz. We lerp between the previous and
    // current sim-tick positions using the wall-clock time since the last
    // tick arrived. This is more accurate than an accumulator because it
    // doesn't lose precision when a new tick arrives between render frames.
    // Everything is tracked in WORLD coords (active-grid pos + origin *
    // CHUNK_W) so chunk-boundary crossings are continuous.
    if (this.simReader) {
      const bhCount = this.simReader.getBlockheadCount();
      if (bhCount > 0) {
        const bh = this.simReader.getBlockhead(0);
        const tick = this.simReader.getTick();
        const originCx = this.simReader.getOriginCx();
        const originCy = this.simReader.getOriginCy();
        // Convert active-grid position to world position
        const worldX = bh[0] + originCx * CHUNK_W;
        const worldY = bh[1] + originCy * CHUNK_H;

        if (tick !== this.lastTick) {
          if (this.interpInit) {
            this.prevWorldX = this.curWorldX;
            this.prevWorldY = this.curWorldY;
            this.curWorldX = worldX;
            this.curWorldY = worldY;
            // Teleport detection: if the world position jumped too far
            // for normal movement, snap instead of lerping.
            const ddx = this.curWorldX - this.prevWorldX;
            const ddy = this.curWorldY - this.prevWorldY;
            if (ddx * ddx + ddy * ddy > 256) { // >16 blocks
              this.prevWorldX = this.curWorldX;
              this.prevWorldY = this.curWorldY;
            }
          } else {
            this.prevWorldX = worldX;
            this.prevWorldY = worldY;
            this.curWorldX = worldX;
            this.curWorldY = worldY;
            this.interpInit = true;
          }
          this.lastTick = tick;
          this.tickArrivalTime = now;
        }
        // Compute alpha from wall-clock time since the tick arrived.
        // Allow extrapolation past alpha=1.0 (up to 1.5) using the per-tick
        // velocity. This keeps motion smooth when the sim runs slightly late
        // (setTimeout jitter) — without it, the player would "stop" for a few
        // frames while waiting for the next tick, causing micro-stutters.
        const timeSinceTick = now - this.tickArrivalTime;
        const alpha = Math.min(1.5, Math.max(0, timeSinceTick / TICK_MS));
        if (alpha <= 1) {
          this.interpWorldX = this.prevWorldX + (this.curWorldX - this.prevWorldX) * alpha;
          this.interpWorldY = this.prevWorldY + (this.curWorldY - this.prevWorldY) * alpha;
        } else {
          // Extrapolate: continue at the same velocity past the current tick
          const vx = this.curWorldX - this.prevWorldX;
          const vy = this.curWorldY - this.prevWorldY;
          this.interpWorldX = this.curWorldX + vx * (alpha - 1);
          this.interpWorldY = this.curWorldY + vy * (alpha - 1);
        }
      }
    }

    // --- Camera follows the interpolated world position ---
    // Camera is tracked in world coords (continuous across chunk boundaries).
    // Convert to active-grid coords when setting this.camera.x/y.
    // No smoothing — the interpolated position is already smooth (tick-based
    // lerp), so camera smoothing would only add lag and rubber-banding.
    if (this.simReader && !this.camera.isPanning()) {
      const bhCount = this.simReader.getBlockheadCount();
      if (bhCount > 0) {
        // Camera target: visual center of the player in world coords.
        // The player box spans Z=-1..0 (center at Z=-0.5). The 3D camera
        // targets Z=0 with a 20° pitch, so objects at lower Z appear
        // higher on screen. Compensate by shifting the target Y down by
        // zOffset * tan(pitchAngle) so the player appears at screen center.
        const PITCH_RAD = 20 * Math.PI / 180;
        const PLAYER_Z_CENTER = -0.5;
        const yCompensation = -PLAYER_Z_CENTER * Math.tan(PITCH_RAD); // ~0.182
        const camWorldX = this.interpWorldX + 0.5;
        const camWorldY = this.interpWorldY + 0.975 + yCompensation;

        // Convert camera world coords → active-grid coords for rendering
        const originCx = this.simReader.getOriginCx();
        const originCy = this.simReader.getOriginCy();
        this.camera.x = camWorldX - originCx * CHUNK_W;
        this.camera.y = camWorldY - originCy * CHUNK_H;
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
        // Convert interpolated world position → active-grid coords for rendering
        const originCx = this.simReader.getOriginCx();
        const originCy = this.simReader.getOriginCy();
        const localX = this.interpWorldX - originCx * CHUNK_W;
        const localY = this.interpWorldY - originCy * CHUNK_H;
        this.stickmanPass.update3D(
          localX, localY,
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
