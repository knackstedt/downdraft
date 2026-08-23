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
import { getItemDef } from "../shared/items";
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
import { TaskMarkerPass, type MarkerData } from "./task-marker-pass";

// Default hotbar block IDs (selectable with number keys 1-9).
// Each slot maps to a placeable block; placing consumes the matching item
// from the blockhead's inventory (handled in the sim worker).
// This is the fallback; the actual hotbar is updated dynamically from the
// inventory via setHotbarFromInventory().
const DEFAULT_HOTBAR_BLOCKS = [
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
  private lastSimTick = -1;
  private debugNoShadows = false;
  private frameCount = 0;
  private fps = 0;
  private fpsTimer = 0;
  private inputInterval = 0; // separate interval for input processing (works even when render loop is paused)

  // Hotbar: dynamic array of block IDs (updated from inventory)
  private hotbarBlocks: number[] = [...DEFAULT_HOTBAR_BLOCKS];

  // Render passes
  blockGridPass: BlockGridPass3D | null = null;
  private stickmanPass: StickmanPass | null = null;
  private skyPass: SkyPass | null = null;
  private taskMarkerPass: TaskMarkerPass | null = null;

  // Camera
  camera: Camera;
  // When detached, the camera position is tracked in world coords so that
  // chunk-origin shifts don't cause the camera to teleport. Each frame we
  // convert the world-coord position to active-grid coords for rendering.
  private camWorldX = 0;
  private camWorldY = 0;
  private camWorldInit = false;

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

  // Queued task markers (in active-grid coords) for visual feedback
  taskMarkers: { gridX: number; gridY: number; action: "mine" | "move" }[] = [];

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

  /** Set task mode (click to queue tasks instead of direct mining/placing). */
  setTaskMode(enabled: boolean): void {
    if (this.input) this.input.taskMode = enabled;
    if (!enabled) {
      // Re-attach camera to player when exiting task mode
      this.camera.detached = false;
      this.camera.endPan();
      this.camWorldInit = false; // will be re-initialized from player position
    }
  }

  /**
   * Update the hotbar from the inventory snapshot.
   * Builds a 9-slot array of block IDs from the first 9 placeable items
   * in the inventory. Slots that have no item are set to BLOCK_AIR.
   * Preserves default blocks for items that aren't in the inventory yet
   * (so the hotbar isn't empty at game start before inventory loads).
   */
  setHotbarFromInventory(inventory: { itemId: string; count: number }[]): void {
    const slots: number[] = new Array(9).fill(BLOCK_AIR);
    let idx = 0;
    // First, fill from placeable inventory items
    for (const slot of inventory) {
      if (idx >= 9) break;
      if (slot.count <= 0) continue;
      const def = getItemDef(slot.itemId);
      if (def && def.placeBlock > 0) {
        slots[idx] = def.placeBlock;
        idx++;
      }
    }
    // If fewer than 9 placeable items, fill remaining with defaults
    for (let i = idx; i < 9; i++) {
      slots[i] = DEFAULT_HOTBAR_BLOCKS[i] ?? BLOCK_AIR;
    }
    this.hotbarBlocks = slots;
  }

  /** Get the current hotbar block IDs (for UI display). */
  getHotbarBlocks(): number[] {
    return this.hotbarBlocks;
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

    // Register a device-lost handler so we can log the reason and
    // attempt to keep the app alive (skip frames until recovery).
    this.deviceManager.onDeviceLost((info) => {
      console.error(`[Renderer] GPU device lost: ${info.message}. Will skip frames until context recovers.`);
    });

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

    this.taskMarkerPass = new TaskMarkerPass(this.device, this.format);
    this.taskMarkerPass.init();

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

    // ResizeObserver catches DevTools panel toggling and other container
    // size changes that don't fire a window resize event.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
        const dpr = window.devicePixelRatio || 1;
        this.camera.resize(this.canvas.width / dpr, this.canvas.height / dpr);
        // Reconfigure the WebGPU context after canvas size change.
        if (this.context && this.device) {
          try {
            this.context.configure({
              device: this.device,
              format: this.format,
              alphaMode: "opaque",
            });
          } catch {
            // Context might be invalid during rapid resize — ignore
          }
        }
      });
      this.resizeObserver.observe(this.canvas);
      // Also observe the canvas's parent element in case the canvas itself
      // has a fixed size but the parent shrinks (DevTools docking)
      if (this.canvas.parentElement) {
        this.resizeObserver.observe(this.canvas.parentElement);
      }
    }

    return true;
  }

  private resizeHandler = (): void => {
    this.resizeCanvas();
    const dpr = window.devicePixelRatio || 1;
    this.camera.resize(this.canvas.width / dpr, this.canvas.height / dpr);
    // Reconfigure the WebGPU context after canvas size change.
    // This is critical: without reconfiguration, getCurrentTexture() can
    // return a texture sized to the old canvas, causing a GPU crash when
    // the render pass tries to write to it.
    if (this.context && this.device) {
      try {
        this.context.configure({
          device: this.device,
          format: this.format,
          alphaMode: "opaque",
        });
      } catch {
        // Context might be invalid during rapid resize — ignore
      }
    }
  };

  /** ResizeObserver callback — catches DevTools panel toggling and container changes. */
  private resizeObserver: ResizeObserver | null = null;

  private resizeCanvas(): void {
    // The canvas CSS size is controlled by the framework's base CSS
    // (width: 100vw; height: 100vh), which correctly shrinks when DevTools
    // is docked. We must NOT override canvas.style.width/height — that would
    // pin it to a fixed pixel size that doesn't update when the viewport
    // changes. Instead, we only set the drawing buffer (canvas.width/height)
    // to match the CSS size × DPR.
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(cssW * dpr);
    const h = Math.floor(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // Do NOT set canvas.style.width/height — the CSS 100vw/100vh handles it.
    // Setting a fixed px value here would prevent the canvas from shrinking
    // when DevTools is docked.
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
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.stickmanPass?.destroy();
    this.skyPass?.destroy();
    this.taskMarkerPass?.destroy();
    await this.workerHost?.shutdown();
  }

  private updateInput(): void {
    if (!this.input || !this.simReader) return;

    // Handle zoom — dynamic zoom with scroll wheel.
    if (this.input.zoomDelta !== 0) {
      const factor = this.input.zoomDelta > 0 ? 1.2 : 1 / 1.2;
      this.camera.zoomAt(this.input.mouseX, this.input.mouseY, factor);
      this.input.zoomDelta = 0;
    }

    // Handle camera panning (middle-mouse drag).
    // Panning detaches the camera from the player. The camera stays
    // detached after releasing the mouse until the user re-attaches it.
    if (this.input.panning) {
      if (!this.camera.isPanning()) {
        // Initialize pan from current world position
        const ocx = this.simReader.getOriginCx();
        const ocy = this.simReader.getOriginCy();
        this.camera.startPan(this.input.panStartX, this.input.panStartY);
        this.camera.detached = true;
      }
      this.camera.updatePan(this.input.mouseX, this.input.mouseY);
      // Sync world position from active-grid position after pan update
      const ocx = this.simReader.getOriginCx();
      const ocy = this.simReader.getOriginCy();
      this.camWorldX = this.camera.x + ocx * CHUNK_W;
      this.camWorldY = this.camera.y + ocy * CHUNK_H;
      this.camWorldInit = true;
    } else if (this.camera.isPanning()) {
      this.camera.endPan();
    }

    // In detached mode, WASD moves the camera instead of the player.
    if (this.camera.detached && !this.input.panning) {
      const panSpeed = 8 / this.camera.zoom;
      let dx = 0, dy = 0;
      if (this.input.left) dx -= panSpeed;
      if (this.input.right) dx += panSpeed;
      if (this.input.up) dy -= panSpeed;
      if (this.input.down) dy += panSpeed;
      if (dx !== 0 || dy !== 0) {
        // Move in world coords so origin shifts don't cause jumps
        this.camWorldX += dx;
        this.camWorldY += dy;
        const ocx = this.simReader.getOriginCx();
        const ocy = this.simReader.getOriginCy();
        this.camera.x = this.camWorldX - ocx * CHUNK_W;
        this.camera.y = this.camWorldY - ocy * CHUNK_H;
      }
    }

    // Convert mouse screen coords to active-grid coords using 3D ray-cast.
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

    // --- Task mode: handle clicks to queue tasks ---
    if (this.input.taskMode && this.input.taskClickPending) {
      this.input.taskClickPending = false;
      let clickGrid: { x: number; y: number };
      if (vp) {
        const invVP = invert(vp);
        if (invVP) {
          const ray = unprojectScreen(
            this.input.taskClickX, this.input.taskClickY,
            this.camera.canvasW, this.camera.canvasH,
            invVP,
          );
          const hit = rayToZ0(ray.origin, ray.dir);
          clickGrid = hit ?? { x: this.camera.x, y: this.camera.y };
        } else {
          clickGrid = this.camera.screenToGrid(this.input.taskClickX, this.input.taskClickY);
        }
      } else {
        clickGrid = this.camera.screenToGrid(this.input.taskClickX, this.input.taskClickY);
      }
      const originCx = this.simReader.getOriginCx();
      const originCy = this.simReader.getOriginCy();
      const worldX = Math.floor(clickGrid.x + originCx * 64);
      const worldY = Math.floor(clickGrid.y + originCy * 64);
      const action: "mine" | "move" = this.input.taskClickButton === 2 ? "move" : "mine";
      const markerGX = Math.floor(clickGrid.x);
      const markerGY = Math.floor(clickGrid.y);

      // Toggle: if a task already exists at this position, cancel it.
      // Otherwise, queue a new one. The marker sync interval (in app.tsx)
      // will pick up the change from getTasks().
      const host = this.workerHost;
      if (host) {
        const taskType = action === "mine" ? "MINE_BLOCK" : "MOVE_TO";
        host.queueTask(taskType, { targetX: worldX, targetY: worldY }, 0).then((result) => {
          if (result.duplicate) {
            host.cancelTask(taskType, worldX, worldY, 0);
          }
        });
      }
    }

    // In task mode, suppress direct mining/placing input
    if (this.input.taskMode) {
      // Write only movement input to SAB (no mining/placing)
      // When camera is detached, WASD moves the camera (not the player),
      // so suppress movement input to the worker.
      const inp = this.simReader.inputInt32;
      const inpF = this.simReader.inputF32;
      const movementActive = this.camera.detached ? 0 : 1;
      inp[0] = (this.input.left ? 1 : 0) * movementActive;
      inp[1] = (this.input.right ? 1 : 0) * movementActive;
      inp[2] = (this.input.up ? 1 : 0) * movementActive;
      inp[3] = (this.input.down ? 1 : 0) * movementActive;
      inp[4] = (this.input.jump ? 1 : 0) * movementActive;
      inp[5] = this.input.noclip ? 1 : 0;
      inp[6] = 0; // no mining in task mode
      inp[7] = 0; // no placing in task mode
      inpF[8] = -1; inpF[9] = -1;
      inpF[10] = -1; inpF[11] = -1;
      inp[12] = 0;
      inpF[13] = this.camera.x;
      inpF[14] = this.camera.y;
      return;
    }

    // Determine placing block from hotbar
    const placeBlockId = this.hotbarBlocks[this.input.selectedSlot] ?? BLOCK_AIR;

    // Write input to SAB
    const inp = this.simReader.inputInt32;
    const inpF = this.simReader.inputF32;
    // Convert active grid coords to world coords for the worker
    const originCx = this.simReader.getOriginCx();
    const originCy = this.simReader.getOriginCy();
    const worldX = grid.x + originCx * 64;
    const worldY = grid.y + originCy * 64;
    // When camera is detached, WASD moves the camera (handled above),
    // so suppress movement input to the worker.
    const movementActive = this.camera.detached ? 0 : 1;
    inp[0] = (this.input.left ? 1 : 0) * movementActive;
    inp[1] = (this.input.right ? 1 : 0) * movementActive;
    inp[2] = (this.input.up ? 1 : 0) * movementActive;
    inp[3] = (this.input.down ? 1 : 0) * movementActive;
    inp[4] = (this.input.jump ? 1 : 0) * movementActive;
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

    // Skip rendering if the GPU device was lost (e.g. during DevTools resize).
    // The device.lost handler will log the error; we just bail out gracefully.
    if (this.deviceManager.isDeviceLost()) {
      this.raf = requestAnimationFrame(this.loop);
      return;
    }

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

    // --- Camera position ---
    // When attached: camera follows the interpolated player world position.
    // When detached: camera stays at a fixed world position (tracked in world
    // coords so chunk-origin shifts don't cause teleportation). Each frame
    // we convert the world position to active-grid coords for rendering.
    if (this.simReader) {
      const originCx = this.simReader.getOriginCx();
      const originCy = this.simReader.getOriginCy();

      if (!this.camera.detached) {
        // Attached: follow the player
        const bhCount = this.simReader.getBlockheadCount();
        if (bhCount > 0) {
          const PITCH_RAD = 20 * Math.PI / 180;
          const PLAYER_Z_CENTER = -0.5;
          const yCompensation = -PLAYER_Z_CENTER * Math.tan(PITCH_RAD);
          this.camWorldX = this.interpWorldX + 0.5;
          this.camWorldY = this.interpWorldY + 0.975 + yCompensation;
          this.camera.x = this.camWorldX - originCx * CHUNK_W;
          this.camera.y = this.camWorldY - originCy * CHUNK_H;
          this.camWorldInit = true;
        }
      } else {
        // Detached: keep the camera at its fixed world position.
        // Initialize the world position on first detach (or if not yet set).
        if (!this.camWorldInit) {
          this.camWorldX = this.camera.x + originCx * CHUNK_W;
          this.camWorldY = this.camera.y + originCy * CHUNK_H;
          this.camWorldInit = true;
        }
        // Convert world position → active-grid coords using current origin.
        // This keeps the camera at the same world position even when the
        // chunk origin shifts (player crosses a boundary).
        this.camera.x = this.camWorldX - originCx * CHUNK_W;
        this.camera.y = this.camWorldY - originCy * CHUNK_H;
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

    // Upload grid data from SAB (builds 3D instance data).
    // Skip when the sim tick hasn't advanced — the SAB data is unchanged
    // between sim ticks (30Hz), so we only need to rebuild on new ticks.
    if (this.simReader) {
      const tick = this.simReader.getTick();
      if (tick !== this.lastSimTick) {
        this.lastSimTick = tick;
        this.blockGridPass.updateGrid(this.simReader.foreground, this.simReader.background);
        this.blockGridPass.updateLight(this.simReader.light);
        this.blockGridPass.updateExplored(this.simReader.explored);
      }
    }

    // Ensure depth texture matches canvas size (device pixels, not CSS)
    this.blockGridPass.ensureDepthTexture(this.canvas.width, this.canvas.height);

    // Update 3D camera uniforms + mining VFX
    const mineX = this.simReader ? this.simReader.getMineX() : -1;
    const mineY = this.simReader ? this.simReader.getMineY() : -1;
    const mineDamage = this.simReader ? this.simReader.getMineDamage() : 0;
    const originX = this.simReader ? this.simReader.getOriginCx() * CHUNK_W : 0;
    const originY = this.simReader ? this.simReader.getOriginCy() * CHUNK_H : 0;
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
      originX,
      originY,
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

    // Update task markers (convert active-grid markers to render data)
    if (this.taskMarkerPass && this.blockGridPass) {
      const W = ACTIVE_GRID_W;
      const fg = this.simReader?.foreground;
      const bg = this.simReader?.background;
      const markerData: MarkerData[] = this.taskMarkers.map((m) => {
        // Place marker in front of whatever layer has content at this cell.
        // Cube front face is at Z+1 (local Z=1), so marker goes at Z+1.05.
        let z = -0.95; // default: in front of layer 3 (Z=-2, front face at Z=-1)
        if (fg) {
          const idx = m.gridY * W + m.gridX;
          if (idx >= 0 && idx < fg.length && (fg[idx] & 0xFF) !== 0) {
            z = 1.05; // in front of layer 1 (Z=0, front face at Z=1)
          } else if (bg && (bg[idx] & 0xFF) !== 0) {
            z = -0.95; // in front of layer 3 (Z=-2, front face at Z=-1)
          }
        }
        return {
          gridX: m.gridX,
          gridY: m.gridY,
          z,
          color: m.action === "mine" ? [0.91, 0.30, 0.24] : [0.20, 0.60, 0.86],
        };
      });
      this.taskMarkerPass.update(
        this.blockGridPass.getViewProj(),
        this.camera.canvasW,
        this.camera.canvasH,
        markerData,
      );
    }

    // Render with depth buffer for 3D occlusion.
    // Wrapped in try/catch because canvas resize (e.g. DevTools toggling)
    // can invalidate the WebGPU surface, causing getCurrentTexture() to
    // throw or the render pass to fail. We skip the frame gracefully
    // instead of crashing the GPU device.
    try {
      const encoder = this.device.createCommandEncoder();
      const currentTexture = this.context.getCurrentTexture();
      if (!currentTexture) {
        // Surface not ready (e.g. mid-resize) — skip this frame
        this.raf = requestAnimationFrame(this.loop);
        return;
      }
      const view = currentTexture.createView();
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
      // Render task markers on top (no depth, alpha blended)
      this.taskMarkerPass?.render(pass);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } catch (err) {
      // Canvas resize or surface invalidation — skip this frame.
      // The ResizeObserver will fire and reconfigure things; the next
      // frame should render normally.
      console.warn(`[Renderer] Frame skipped (surface invalid): ${(err as Error).message}`);
    }

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
