// ============================================================================
// MiningRenderer — the main WebGPU renderer for the mining RPG.
//
// Manages the canvas, WebGPU device, sand grid pass (with camera), stickman
// pass (player), and the mining worker host. Each frame:
//   1. Read input → write to worker SAB
//   2. Read active grid from worker SAB → upload to GPU texture
//   3. Update camera to follow player
//   4. Render sand grid pass (with camera uniforms)
//   5. Render stickman pass (player sprite)
// ============================================================================

import { ACTIVE_GRID_H, ACTIVE_GRID_W, BACKDROP_PARALLAX, CHUNK_H, CHUNK_W, PLAYER, STATS, WORLD_SEED } from "../shared/constants";
import { MiningSimBufferReader } from "../shared/sim-buffer";
import { BackdropWorkerHost } from "../simulation/backdrop-worker-host";
import { MiningWorkerHost } from "../simulation/mining-worker-host";
import { useGameStore } from "../stores/game-store";
import { AutosaveManager, loadWorld } from "../stores/save-system";
import { BackdropPass } from "./backdrop-pass";
import { makeCamera2D, screenToWorld, updateCamera, type Camera2D } from "./camera";
import { createMiningInputHandler, type MiningInputState } from "./input-handler";
import { SandGridPass } from "./sand-grid-pass";
import { StickmanPass } from "./stickman-pass";

export class MiningRenderer {
  private canvas: HTMLCanvasElement;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private gridPass: SandGridPass | null = null;
  private backdropPass: BackdropPass | null = null;
  private stickmanPass: StickmanPass | null = null;
  private input: MiningInputState | null = null;
  private workerHost: MiningWorkerHost | null = null;
  private backdropHost: BackdropWorkerHost | null = null;
  private gridReader: MiningSimBufferReader | null = null;
  private autosave: AutosaveManager | null = null;
  private camera: Camera2D;
  private running = false;
  private raf = 0;
  private lastTime = 0;
  private frameCount = 0;
  private fps = 0;
  private fpsTimer = 0;
  private resizeHandler: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, _deterministic: boolean) {
    this.canvas = canvas;
    this.camera = makeCamera2D(canvas.width, canvas.height);
  }

  getFPS(): number {
    return this.fps;
  }
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
  getWorkerHost(): MiningWorkerHost | null {
    return this.workerHost;
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

    this.input = createMiningInputHandler(this.canvas);

    this.resizeCanvas();
    this.camera = makeCamera2D(this.canvas.width, this.canvas.height);

    this.resizeHandler = () => this.handleResize();
    window.addEventListener("resize", this.resizeHandler);

    this.gridPass = new SandGridPass(this.device, this.format, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.gridPass.init(this.canvas.width, this.canvas.height);

    // Backdrop pass (rendered behind the foreground with parallax)
    this.backdropPass = new BackdropPass(this.device, this.format);
    this.backdropPass.init();

    this.stickmanPass = new StickmanPass(this.device, this.format);
    this.stickmanPass.init();

    this.workerHost = new MiningWorkerHost();
    await this.workerHost.start();
    this.gridReader = this.workerHost.getReader();

    // Backdrop worker (generates low-res cave-wall texture)
    this.backdropHost = new BackdropWorkerHost();
    await this.backdropHost.start();

    // --- Load save data (if any) ---
    const deterministic = !!(globalThis as any).__downdraft_deterministic;
    try {
      const save = await loadWorld();
      if (save) {
        // Restore chunks + player state in the worker
        await this.workerHost.loadSaveData({
          player: save.player,
          chunks: save.chunks,
          tick: 0, // don't restore tick counter (fresh start)
        });
        // Restore inventory to the game store
        const store = useGameStore.getState();
        store.setInventory(save.inventory);
        if (save.player.health) store.setHealth(save.player.health);
      }
    } catch (e) {
      console.warn("[MiningRenderer] Failed to load save:", e);
    }

    // --- Set up autosave ---
    this.autosave = new AutosaveManager(async () => {
      const saveData = await this.workerHost!.getSaveData();
      if (!saveData) {
        return { version: 1, seed: WORLD_SEED, player: { x: 0, y: 0, vx: 0, vy: 0, onGround: false, facing: 1, animFrame: 0, health: 100 }, inventory: [], chunks: [], savedAt: Date.now() };
      }
      const store = useGameStore.getState();
      return {
        version: 1,
        seed: WORLD_SEED,
        player: saveData.player,
        inventory: store.inventory,
        chunks: saveData.dirtyChunks,
        savedAt: Date.now(),
      };
    }, deterministic);
    this.autosave.start();

    // Handle collected items
    this.workerHost.onCollectedItems((items) => {
      for (const item of items) {
        useGameStore.getState().addToInventory(item.mat, item.count);
      }
    });

    // P key toggles pause
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
    if (!this.device || !this.gridPass) return;
    this.resizeCanvas();
    this.camera.width = this.canvas.width;
    this.camera.height = this.canvas.height;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    // Final save before shutdown
    if (this.autosave) {
      try { await this.autosave.saveNow(); } catch {}
      this.autosave.stop();
    }
    this.workerHost?.stop();
    this.backdropHost?.stop();
    this.stickmanPass?.destroy();
    this.backdropPass?.destroy();
    if (this.resizeHandler) window.removeEventListener("resize", this.resizeHandler);
    if (this.keydownHandler) window.removeEventListener("keydown", this.keydownHandler);
  }

  private frame(time: number): void {
    if (!this.running || !this.device || !this.context || !this.input || !this.gridReader ||
        !this.gridPass || !this.backdropPass || !this.stickmanPass || !this.workerHost ||
        !this.backdropHost) return;

    const dt = Math.min(0.1, (time - this.lastTime) / 1000);
    this.lastTime = time;
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 1) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    // --- Write input to worker ---
    this.writeInputToWorker();

    // --- Read active grid from SAB and upload to GPU ---
    this.gridPass.updateGrid(this.gridReader.getGrid());
    this.gridPass.updateUniforms();

    // --- Read player state and active grid origin ---
    const px = this.workerHost.getPlayerF32(PLAYER.PX);
    const py = this.workerHost.getPlayerF32(PLAYER.PY);
    const facing = this.workerHost.getPlayerI32(PLAYER.FACING);
    const animFrame = this.workerHost.getPlayerI32(PLAYER.ANIM_FRAME);
    const health = this.workerHost.getPlayerI32(PLAYER.HEALTH);
    const onGround = this.workerHost.getPlayerI32(PLAYER.ON_GROUND) !== 0;
    const vx = this.workerHost.getPlayerF32(PLAYER.VX);
    const vy = this.workerHost.getPlayerF32(PLAYER.VY);
    const originX = this.gridReader.getStat(STATS.ORIGIN_X);
    const originY = this.gridReader.getStat(STATS.ORIGIN_Y);

    // --- Update backdrop window + upload backdrop grid ---
    // The backdrop uses the same chunk origin as the foreground.
    const fgOriginCx = Math.floor(originX / CHUNK_W);
    const fgOriginCy = Math.floor(originY / CHUNK_H);
    this.backdropHost.updateWindowIfNeeded(fgOriginCx, fgOriginCy);
    this.backdropPass.updateGrid(this.backdropHost.getGrid());

    // Convert player world coords to active-grid-local coords.
    // The grid texture and stickman shader both work in local coords.
    const localPx = px - originX;
    const localPy = py - originY;

    // Track the camera in WORLD coords — this is continuous across chunk
    // boundary crossings (the active grid origin shifts by CHUNK_W, which
    // would make a local-space target jump by a full chunk). The camera
    // lerps toward the player's world position; we convert to local below.
    updateCamera(this.camera, px, py);
    // Sync player health + depth to store (needed for depth uniform)
    const s = useGameStore.getState();
    if (s.health !== health) s.setHealth(health);
    const depth = Math.floor(py / 128);
    if (s.depth !== depth) s.setDepth(depth);
    const loadedChunks = this.gridReader.getStat(STATS.LOADED_CHUNKS);
    if (s.loadedChunks !== loadedChunks) s.setLoadedChunks(loadedChunks);

    // Convert camera world coords → active-grid-local coords for the
    // render passes (grid texture + stickman shader work in local coords).
    const camLocalX = this.camera.x - originX;
    const camLocalY = this.camera.y - originY;

    this.gridPass.updateCamera(
      camLocalX, camLocalY, this.camera.zoom,
      this.canvas.width, this.canvas.height,
      depth,
    );
    // Backdrop camera: compute the camera position in BACKDROP-local coords.
    // The backdrop has its own origin (in backdrop cell coords, at half the
    // foreground resolution). We convert the world-space camera position to
    // backdrop-local: world * parallax * 0.5 (half-res + parallax) - bdOrigin.
    // Using the backdrop's own origin (not the foreground origin) ensures
    // continuity across chunk boundary crossings — both the camera and the
    // backdrop grid shift together when the backdrop window updates.
    const bdOriginX = this.backdropHost.getOriginX();
    const bdOriginY = this.backdropHost.getOriginY();
    const bdCamX = this.camera.x * BACKDROP_PARALLAX * 0.5 - bdOriginX;
    const bdCamY = this.camera.y * BACKDROP_PARALLAX * 0.5 - bdOriginY;
    this.backdropPass.updateCamera(
      bdCamX, bdCamY, this.camera.zoom,
      this.canvas.width, this.canvas.height,
    );

    // --- Update stickman (in local coords) ---
    this.stickmanPass.update(
      localPx, localPy, facing, animFrame,
      camLocalX, camLocalY, this.camera.zoom,
      this.canvas.width, this.canvas.height,
      health, onGround, vx, vy,
    );

    // --- Render ---
    const commandEncoder = this.device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.02, g: 0.02, b: 0.05, a: 1.0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });

    // Render backdrop first (opaque, fills the background)
    this.backdropPass.render(passEncoder);
    // Then foreground grid + player on top
    this.gridPass.render(passEncoder);
    this.stickmanPass.render(passEncoder);

    passEncoder.end();
    this.device.queue.submit([commandEncoder.finish()]);

    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private writeInputToWorker(): void {
    if (!this.input || !this.workerHost) return;

    // Keyboard
    this.workerHost.writePlayerInput(
      this.input.left, this.input.right, this.input.up, this.input.down, this.input.jump,
    );

    // Mouse: convert screen pixels → world cell coords
    // (camera tracks in world coords, so screenToWorld returns world coords)
    const dpr = window.devicePixelRatio || 1;
    const screenX = this.input.mouseX * dpr;
    const screenY = this.input.mouseY * dpr;
    const world = screenToWorld(this.camera, screenX, screenY);
    this.workerHost.writeMousePos(world.x, world.y);
    this.workerHost.writeMouseDown(this.input.mouseDown);
    this.workerHost.writeDigRadius(this.input.digRadius);
  }
}
