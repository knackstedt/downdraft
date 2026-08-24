// ============================================================================
// BlockheadsRenderer — main render orchestrator
//
// Manages the WebGPU device, the sim worker host, the block grid render pass,
// the stickman render pass, the camera, and input. Renders the active grid
// + blockhead characters each frame.
// ============================================================================

import { GPUDeviceManager } from "@downdraft/core";
import { getBlockDef } from "../shared/block-registry";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR, BLOCK_DIRT, BLOCK_GRASS, BLOCK_LADDER,
    BLOCK_ROPE, BLOCK_SAND, BLOCK_SCAFFOLDING, BLOCK_STONE, BLOCK_TORCH,
    BLOCK_WOOD,
    CHUNK_H, CHUNK_W, TICK_MS
} from "../shared/constants";
import { CROP_LOOKUP } from "../shared/crops";
import { getItemDef } from "../shared/items";
import { RENDER_TICK_SENTINEL } from "../shared/render-buffer";
import { SimBufferReader } from "../shared/sim-buffer";
import { isTreeBlock } from "../shared/tree-species";
import { BlockheadsWorkerHost } from "../simulation/blockheads-worker-host";
import { GridBuilderWorkerHost } from "../simulation/grid-builder-worker-host";
import { BlockGridPass3D } from "./block-grid-pass-3d";
import { Camera } from "./camera";
import { CropSpritePass } from "./crop-sprite-pass";
import { DropPass, type DropRenderData } from "./drop-pass";
import {
    createInputHandler, type BlockheadsInputState,
} from "./input-handler";
import { invert, raycastGridSlab, rayToZ0, unprojectScreen } from "./matrix";
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
  // Cached origin (read atomically with the tick to avoid race conditions
  // where the worker updates the origin between camera positioning and
  // grid rebuild — which would cause a 1-frame flash on chunk boundaries).
  private cachedOriginCx = 0;
  private cachedOriginCy = 0;
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
  private dropPass: DropPass | null = null;
  private cropSpritePass: CropSpritePass | null = null;

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

  // Grid-builder worker — offloads instance data + texture padding to a
  // dedicated worker. The renderer reads pre-built data from the render SAB
  // and uploads it to the GPU without any JS loops on the main thread.
  private gridBuilderHost: GridBuilderWorkerHost | null = null;
  private lastBuildTick = RENDER_TICK_SENTINEL;
  private lastCropTick = RENDER_TICK_SENTINEL;
  // Cached drop render data — only rebuilt when sim tick changes (30Hz),
  // not every render frame (60-360Hz). Avoids per-frame array + object
  // allocation in the drop loop.
  private cachedDropData: DropRenderData[] = [];
  private lastDropTick = RENDER_TICK_SENTINEL;

  // Input
  private input: BlockheadsInputState | null = null;

  // Queued task markers (in active-grid coords) for visual feedback.
  // Use the setter so the render data cache is invalidated.
  private _taskMarkers: { gridX: number; gridY: number; action: "mine" | "move" }[] = [];
  get taskMarkers(): { gridX: number; gridY: number; action: "mine" | "move" }[] {
    return this._taskMarkers;
  }
  set taskMarkers(v: { gridX: number; gridY: number; action: "mine" | "move" }[]) {
    this._taskMarkers = v;
    this.markerDataDirty = true;
  }
  // Cached marker render data — only rebuilt when markers or build tick changes
  private cachedMarkerData: MarkerData[] = [];
  private markerDataDirty = true;
  private lastMarkerBuildTick = RENDER_TICK_SENTINEL;

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

    this.dropPass = new DropPass(this.device, this.format);
    this.dropPass.init();
    // Async-load the fruit spritesheet (non-blocking; falls back to solid
    // colors until the texture is ready).
    this.dropPass.loadFruitTexture();

    this.cropSpritePass = new CropSpritePass(this.device, this.format);
    this.cropSpritePass.init();

    // Start the sim worker
    this.workerHost = new BlockheadsWorkerHost();
    this.simReader = new SimBufferReader(this.workerHost.getSimBuffer() as ArrayBufferLike);
    await this.workerHost.start();
    this.simReady = this.workerHost.isReady();

    // Start the grid-builder worker — offloads instance data + texture
    // padding from the render thread. It reads the sim SAB and writes
    // pre-built data to the render SAB.
    this.gridBuilderHost = new GridBuilderWorkerHost();
    await this.gridBuilderHost.start(this.workerHost.getSimBuffer());

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
    // In normal mode, the rAF loop already calls updateInput() every frame,
    // so the interval skips to avoid double raycasts (matrix invert + DDA).
    if (!this.inputInterval) {
      this.inputInterval = setInterval(() => {
        if (this.running) return; // rAF loop handles it
        this.updateInput();
      }, 16) as unknown as number;
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
    this.dropPass?.destroy();
    this.cropSpritePass?.destroy();
    await this.gridBuilderHost?.shutdown();
    this.gridBuilderHost = null;
    this.lastBuildTick = RENDER_TICK_SENTINEL;
    this.lastCropTick = RENDER_TICK_SENTINEL;
    this.lastDropTick = RENDER_TICK_SENTINEL;
    this.lastMarkerBuildTick = RENDER_TICK_SENTINEL;
    await this.workerHost?.shutdown();
  }

  /**
   * Reset the whole game: tell the worker to delete the OPFS save and
   * re-create the world from scratch, then reset renderer-side state
   * (camera, task markers, interpolation, hotbar) so the view snaps back
   * to the fresh spawn point.
   */
  async resetGame(): Promise<{ ok: boolean; error?: string }> {
    if (!this.workerHost) return { ok: false, error: "Worker not started" };
    const result = await this.workerHost.resetGame();
    if (!result.ok) return result;

    // Reset renderer-side state to match the fresh world
    this._taskMarkers.length = 0;
    this.markerDataDirty = true;
    this.hotbarBlocks = [...DEFAULT_HOTBAR_BLOCKS];
    // Clear drops display (worker already cleared the drop array)
    this.cachedDropData = [];
    this.lastDropTick = RENDER_TICK_SENTINEL;
    if (this.dropPass && this.blockGridPass) {
      this.dropPass.update(this.blockGridPass.getViewProj(), this.camera.canvasW, this.camera.canvasH, []);
    }
    // Clear crop sprites (worker already reset the grid)
    if (this.cropSpritePass && this.blockGridPass) {
      this.cropSpritePass.updateInstances(new Uint16Array(0), 0, 0);
      this.cropSpritePass.updateCamera(
        this.blockGridPass.getViewProj(), this.camera.canvasW, this.camera.canvasH,
      );
    }
    this.lastBuildTick = RENDER_TICK_SENTINEL; // force re-upload on next frame
    this.lastCropTick = RENDER_TICK_SENTINEL;
    this.lastDropTick = RENDER_TICK_SENTINEL;
    this.lastMarkerBuildTick = RENDER_TICK_SENTINEL;
    this.cachedOriginCx = 0;
    this.cachedOriginCy = 0;
    this.camWorldInit = false;
    this.interpInit = false;
    this.lastTick = -1;
    // Re-center camera on the spawn point (active grid center, surface level)
    this.camera.detached = false;
    this.camera.endPan();
    this.camera.setCenter(ACTIVE_GRID_W / 2, ACTIVE_GRID_H / 2);
    // Reset input state (clear any held keys / mouse buttons)
    if (this.input) {
      this.input.taskMode = false;
    }
    return { ok: true };
  }

  /**
   * Convert screen pixel coords to active-grid coords using a 3D raycast
   * against the actual rendered cube geometry.
   *
   * The scene has four depth layers (front→back):
   *   FG front  Z=[ 0,  1]  ← foreground grid
   *   FG back   Z=[-1,  0]  ← foreground grid (same cell, rendered at Z=-1)
   *   BG main   Z=[-2, -1]  ← background grid (trees + terrain)
   *   BG wall   Z=[-3, -2]  ← background grid (terrain only, no trees)
   *
   * A naive Z=1 plane intersection only works for the FG front face. When the
   * foreground is empty, the user sees background blocks at Z=-1 (front face
   * of BG main). The perspective shift between Z=1 and Z=-1 is ~2× larger
   * than between Z=0 and Z=1, so the Z=1 fallback selects a cell that's off
   * by 1+ cells near screen edges.
   *
   * This method marches a 2D DDA through the FG slab (Z=[1, -1]) first, then
   * the BG slab (Z=[-1, -3]), returning the first solid cube hit. If nothing
   * is hit (clicking empty space for placement), it falls back to the Z=1
   * plane intersection.
   */
  private screenToGrid3D(screenX: number, screenY: number): { x: number; y: number } {
    const vp = this.blockGridPass?.getViewProj();
    if (!vp) return this.camera.screenToGrid(screenX, screenY);
    const invVP = invert(vp);
    if (!invVP) return this.camera.screenToGrid(screenX, screenY);

    const ray = unprojectScreen(
      screenX, screenY,
      this.camera.canvasW, this.camera.canvasH,
      invVP,
    );

    const fg = this.simReader!.foreground;
    const bg = this.simReader!.background;

    // Crops/wild crops are rendered as 2D sprites, not cubes — exclude them
    // from the solid test so clicking a crop falls through to the plane.
    // Uses CROP_LOOKUP (Uint8Array) for O(1) check instead of Set.has().
    const isFgSolid = (cx: number, cy: number) => {
      const id = fg[cy * ACTIVE_GRID_W + cx] & 0xFF;
      return id !== BLOCK_AIR && CROP_LOOKUP[id] === 0;
    };
    // Background: trees ARE solid cubes in the BG main layer (Z=-2).
    const isBgSolid = (cx: number, cy: number) => {
      const id = bg[cy * ACTIVE_GRID_W + cx] & 0xFF;
      return id !== BLOCK_AIR && CROP_LOOKUP[id] === 0;
    };

    // 1) Foreground slab: Z=[1, -1] (front face at Z=1, back face at Z=-1)
    const fgHit = raycastGridSlab(
      ray.origin, ray.dir,
      1.0, -1.0,
      ACTIVE_GRID_W, ACTIVE_GRID_H,
      isFgSolid,
    );
    if (fgHit) return fgHit;

    // 2) Background slab: Z=[-1, -3] (front face at Z=-1, back face at Z=-3)
    const bgHit = raycastGridSlab(
      ray.origin, ray.dir,
      -1.0, -3.0,
      ACTIVE_GRID_W, ACTIVE_GRID_H,
      isBgSolid,
    );
    if (bgHit) return bgHit;

    // 3) Nothing hit — fall back to Z=1 plane for placement in empty space
    const plane = rayToZ0(ray.origin, ray.dir);
    return plane ?? { x: this.camera.x, y: this.camera.y };
  }

  /**
   * Process camera-related input (zoom, pan, detached WASD movement).
   * Called early in the frame, BEFORE the camera position is updated from
   * the interpolated player position and BEFORE updateCamera() computes the
   * view-projection matrix. This ensures the viewProj reflects the current
   * frame's camera state when the raycast runs.
   */
  private processCameraInput(): void {
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
  }

  private updateInput(): void {
    if (!this.input || !this.simReader) return;

    // Only raycast when a mouse button is held (mining/placing) or a
    // click is pending (task mode, inspect, etc). The raycast is
    // expensive (4×4 matrix invert + DDA grid march) and the result
    // is only needed for mining/placing — the worker ignores the
    // coords when inp[6] (mine) and inp[7] (place) are both 0.
    const placeBlockId = this.hotbarBlocks[this.input.selectedSlot] ?? BLOCK_AIR;
    const needsRaycast = this.input.mouseDown ||
                        (this.input.mouseRight && placeBlockId !== BLOCK_AIR) ||
                        this.input.inspectClickPending ||
                        this.input.forceFruitSpawnPending ||
                        (this.input.taskMode && this.input.taskClickPending);

    let grid: { x: number; y: number };
    if (needsRaycast) {
      grid = this.screenToGrid3D(this.input.mouseX, this.input.mouseY);
    } else {
      grid = { x: -1, y: -1 }; // dummy — worker ignores when no button is down
    }

    // --- Debug cell inspect (F6): log the 4 render depth layers at the clicked cell ---
    // Layers mirror block-grid-pass-3d.ts's 4-layer depth system:
    //   Layer 1 (Z= 0): foreground front   ← from `foreground`
    //   Layer 2 (Z=-1): foreground back    ← from `foreground` (same cell)
    //   Layer 3 (Z=-2): background main    ← from `background` (trees + terrain)
    //   Layer 4 (Z=-3): back wall          ← from `background`, excluding trees (wood/leaves)
    // Each entry is a slim summary (kind + basic metadata) or null for air/empty.
    if (this.input.inspectClickPending) {
      this.input.inspectClickPending = false;
      const inspectGrid = this.screenToGrid3D(this.input.inspectClickX, this.input.inspectClickY);
      const ax = Math.floor(inspectGrid.x);
      const ay = Math.floor(inspectGrid.y);
      const ocx = this.simReader.getOriginCx();
      const ocy = this.simReader.getOriginCy();
      const worldX = ax + ocx * CHUNK_W;
      const worldY = ay + ocy * CHUNK_H;
      if (ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H) {
        const cellIdx = ay * ACTIVE_GRID_W + ax;
        const fgId = this.simReader.foreground[cellIdx] & 0xFF;
        const bgId = this.simReader.background[cellIdx] & 0xFF;
        // Layer 4 (back wall) excludes trees — they render only in layer 3.
        const bgWallId = isTreeBlock(bgId) ? BLOCK_AIR : bgId;
        const summarize = (id: number) => {
          if (id === BLOCK_AIR) return null;
          const d = getBlockDef(id);
          if (!d) return null;
          return {
            kind: d.name,
            category: d.category,
            hardness: d.hardness,
            color: d.color,
            lightEmit: d.lightEmit,
            climbable: d.climbable,
            flammable: d.flammable,
            liquidFlow: d.liquidFlow,
            isStation: d.isStation,
          };
        };
        const layers = [
          summarize(fgId),     // layer 1: foreground front
          summarize(fgId),     // layer 2: foreground back (same cell)
          summarize(bgId),     // layer 3: background main
          summarize(bgWallId), // layer 4: back wall (no trees)
        ];
        console.log(
          `[Overburden] cell inspect @ active(${ax},${ay}) world(${worldX},${worldY})`,
          layers,
        );
      } else {
        console.log(`[Overburden] cell inspect @ active(${ax},${ay}) — out of active grid bounds`);
      }
    }

    // --- Debug force fruit spawn (F7): roll the fruit-spawn dice for all
    // fruit-capable leaf blocks immediately via the sim worker. ---
    if (this.input.forceFruitSpawnPending) {
      this.input.forceFruitSpawnPending = false;
      const host = this.workerHost;
      if (host) {
        host.forceFruitSpawn().then((count) => {
          console.log(`[Overburden] Force fruit spawn (F7): ${count} fruit${count === 1 ? "" : "s"} spawned`);
        }).catch((e) => {
          console.error("[Overburden] Force fruit spawn (F7) failed:", e);
        });
      }
    }

    // --- Task mode: handle clicks to queue tasks ---
    if (this.input.taskMode && this.input.taskClickPending) {
      this.input.taskClickPending = false;
      const clickGrid = this.screenToGrid3D(this.input.taskClickX, this.input.taskClickY);
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

    // Process camera-related input (zoom, pan, detached WASD) early so the
    // camera position + viewProj matrix reflect the current frame's input
    // when the raycast runs later.
    this.processCameraInput();

    // --- Tick-based interpolation (world coords) ---
    // The sim writes positions at 30Hz. We lerp between the previous and
    // current sim-tick positions using the wall-clock time since the last
    // tick arrived. This is more accurate than an accumulator because it
    // doesn't lose precision when a new tick arrives between render frames.
    // Everything is tracked in WORLD coords (active-grid pos + origin *
    // CHUNK_W) so chunk-boundary crossings are continuous.
    // Read the tick FIRST and cache the origin atomically — this prevents
    // race conditions where the worker updates the SAB between reads.
    if (this.simReader) {
      const tick = this.simReader.getTick();
      if (tick !== this.lastTick) {
        // Tick changed: read origin + bh position together (consistent snapshot)
        this.cachedOriginCx = this.simReader.getOriginCx();
        this.cachedOriginCy = this.simReader.getOriginCy();
        this.lastTick = tick;
        this.tickArrivalTime = now;

        const bhCount = this.simReader.getBlockheadCount();
        if (bhCount > 0) {
          const bh = this.simReader.getBlockhead(0);
          const worldX = bh[0] + this.cachedOriginCx * CHUNK_W;
          const worldY = bh[1] + this.cachedOriginCy * CHUNK_H;

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
        }
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

    // --- Camera position ---
    // When attached: camera follows the interpolated player world position.
    // When detached: camera stays at a fixed world position (tracked in world
    // coords so chunk-origin shifts don't cause teleportation). Each frame
    // we convert the world position to active-grid coords for rendering.
    if (this.simReader) {
      // Use cached origin (read atomically with the tick) to avoid
      // race conditions with the worker updating the SAB mid-frame.
      const originCx = this.cachedOriginCx;
      const originCy = this.cachedOriginCy;

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

    // Upload grid data from the render SAB (pre-built by the grid-builder
    // worker). The worker continuously builds instance data + padded textures
    // off the main thread; we just check if a new build is ready and upload
    // it to the GPU. This eliminates the ~10ms O(W×H) instance-building loop
    // that previously ran on the main thread every sim tick.
    if (this.gridBuilderHost) {
      const renderReader = this.gridBuilderHost.getReader();
      const buildTick = renderReader.getBuildTick();
      if (buildTick !== this.lastBuildTick) {
        this.lastBuildTick = buildTick;
        this.blockGridPass.updateGridFromBuffer(renderReader);
        this.blockGridPass.updateLightFromBuffer(renderReader);
        this.blockGridPass.updateExploredFromBuffer(renderReader);
      }
    }

    // Origin for texture stability (uses cached origin to stay consistent
    // with the grid data).
    const originX = this.cachedOriginCx * CHUNK_W;
    const originY = this.cachedOriginCy * CHUNK_H;

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
      originX,
      originY,
    );

    // Process input → SAB (raycast + write mine/place coords).
    // Called AFTER updateCamera() so the raycast uses the current frame's
    // viewProj matrix — not the previous frame's stale one. This eliminates
    // the one-frame offset between what the user sees and where the click
    // lands, which was most noticeable near screen edges where perspective
    // amplifies the delta.
    this.updateInput();

    // Update stickman pass with 3D perspective (use smoothed position)
    if (this.simReader && this.stickmanPass) {
      const bhCount = this.simReader.getBlockheadCount();
      if (bhCount > 0) {
        const bh = this.simReader.getBlockhead(0);
        // Convert interpolated world position → active-grid coords for rendering
        // Use cached origin for consistency with the grid data.
        const localX = this.interpWorldX - this.cachedOriginCx * CHUNK_W;
        const localY = this.interpWorldY - this.cachedOriginCy * CHUNK_H;
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

    // Update task markers — only rebuild render data when markers change
    // or the grid build tick advances (z-position depends on grid content).
    // The markers array is updated externally (~200ms); without caching,
    // .map() creates a new array + N objects every frame (GC pressure).
    if (this.taskMarkerPass && this.blockGridPass) {
      if (this.markerDataDirty || this.lastBuildTick !== this.lastMarkerBuildTick) {
        this.lastMarkerBuildTick = this.lastBuildTick;
        this.markerDataDirty = false;
        const W = ACTIVE_GRID_W;
        const fg = this.simReader?.foreground;
        const bg = this.simReader?.background;
        this.cachedMarkerData = this.taskMarkers.map((m) => {
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
      }
      this.taskMarkerPass.update(
        this.blockGridPass.getViewProj(),
        this.camera.canvasW,
        this.camera.canvasH,
        this.cachedMarkerData,
      );
    }

    // Update drop pass — only rebuild drop data when sim tick changes
    // (drops move at 30Hz, not render framerate). Camera uniforms update
    // every frame via dropPass.update().
    if (this.dropPass && this.blockGridPass && this.simReader) {
      if (this.lastBuildTick !== this.lastDropTick) {
        this.lastDropTick = this.lastBuildTick;
        const dropCount = this.simReader.getDropCount();
        if (dropCount > 0) {
          this.cachedDropData = [];
          for (let i = 0; i < dropCount && i < 512; i++) {
            const off = i * 8; // DROP_STRIDE = 8
            this.cachedDropData.push({
              x: this.simReader.drops[off + 0],
              y: this.simReader.drops[off + 1],
              spin: this.simReader.drops[off + 4],
              itemCode: this.simReader.drops[off + 6],
            });
          }
        } else {
          this.cachedDropData = [];
        }
      }
      this.dropPass.update(
        this.blockGridPass.getViewProj(),
        this.camera.canvasW,
        this.camera.canvasH,
        this.cachedDropData,
      );
    }

    // Update crop sprite pass — instance scan only when sim tick changes
    // (foreground grid is unchanged between ticks), camera uniforms every frame.
    if (this.cropSpritePass && this.blockGridPass && this.simReader) {
      if (this.lastBuildTick !== this.lastCropTick) {
        this.lastCropTick = this.lastBuildTick;
        this.cropSpritePass.updateInstances(
          this.simReader.foreground,
          ACTIVE_GRID_W,
          ACTIVE_GRID_H,
        );
      }
      this.cropSpritePass.updateCamera(
        this.blockGridPass.getViewProj(),
        this.camera.canvasW,
        this.camera.canvasH,
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
      // Render crop sprites (2D billboarded quads, no depth, on top of terrain)
      this.cropSpritePass?.render(pass);
      // Render world drops (spinning item quads, no depth, on top)
      this.dropPass?.render(pass);
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
