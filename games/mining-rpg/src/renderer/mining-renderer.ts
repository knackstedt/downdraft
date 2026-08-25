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

import { GameRenderer } from "@downdraft/core";
import { Material, MATERIALS } from "@downdraft/library-sand";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, BACKDROP_PARALLAX, CHUNK_H, CHUNK_W, HEADLAMP_COLOR, MAX_CHUNKS_X, OXYGEN_MAX_TICKS, PLAYER, SIGNPOST_RADIUS, STATS, TICK_RATE, WORLD_SEED, type BuildMaterialType, type UpgradeConfig } from "../shared/constants";
import { MiningSimBufferReader } from "../shared/sim-buffer";
import type { SavedGlowstick } from "../shared/types";
import { BackdropWorkerHost } from "../simulation/backdrop-worker-host";
import { MiningWorkerHost } from "../simulation/mining-worker-host";
import { BASE_SURFACE_Y, surfaceHeightAt } from "../simulation/terrain";
import { pickDeathQuip, useGameStore } from "../stores/game-store";
import { AutosaveManager, createAutosaveManager, deleteSave, loadWorld } from "../stores/save-system";
import { BackdropPass } from "./backdrop-pass";
import { BackgroundGridPass } from "./background-grid-pass";
import { makeCamera2D, screenToWorld, updateCamera, worldToScreen, type Camera2D } from "./camera";
import { FogOfWarPass } from "./fog-pass";
import { createMiningInputHandler, type MiningInputState } from "./input-handler";
import { createExplosionLight, LightAccumPass, type RendererLight } from "./light-accum-pass";
import { SandGridPass } from "./sand-grid-pass";
import { StickmanPass } from "./stickman-pass";
import { VolumetricLightPass, type VolRendererLight } from "./volumetric-light-pass";

// --- Bomb constants ---
const BOMB_RADIUS = 6;       // explosion radius in cells
const BOMB_COOLDOWN_MS = 800; // throw cooldown
const BOMB_SPEED = 0.8;      // initial speed multiplier
const BOMB_GRAVITY = 0.015;  // per-tick gravity acceleration
const BOMB_MAX_TICKS = 120;  // max travel ticks before forced explosion (~4s)
const MAX_BOMBS = 8;

// --- Glowstick constants ---
const GLOWSTICK_SPEED = 0.6;   // initial throw speed
const GLOWSTICK_GRAVITY = 0.012; // per-tick gravity (lighter than bombs)
const GLOWSTICK_MAX_TICKS = 200; // max travel ticks before settling (~6.7s)
const MAX_GLOWSTICKS = 32;
const GLOWSTICK_LIFETIME_MS = 60 * 60 * 1000; // 1 hour real time
const GLOWSTICK_RADIUS = 25;   // light radius in cells
const GLOWSTICK_INTENSITY = 1.5;

// --- Enemy constants ---
// Enemies are client-side creatures that spawn in dark caves below a depth
// threshold. They chase the player through air cells and deal contact damage
// via the worker's damagePlayer RPC. Killed by bomb explosions or by being
// mined (clicking on their cell). Different types spawn at different depths.
interface Enemy {
  x: number; y: number;     // world cell coords (float)
  vx: number; vy: number;   // velocity per tick
  health: number;
  maxHealth: number;
  type: EnemyType;
  damagePerTick: number;    // contact damage
  speed: number;            // chase speed
  color: string;            // render color
  size: number;             // render size in CSS pixels
  name: string;
  contactCooldown: number;  // ticks until next damage (prevents every-tick hits)
}

type EnemyType = "cave-bat" | "rock-golem" | "lava-imp";

const ENEMY_SPAWN_INTERVAL = 600; // ticks between spawn attempts (~10s @ 60tps)
const ENEMY_SPAWN_DEPTH = 200;    // min depth in meters for enemies
const MAX_ENEMIES = 12;
const ENEMY_CONTACT_COOLDOWN = 30; // ticks between contact hits (~0.5s)

// --- Zoom constants ---
// Per keypress step factor; drained from input.zoomDelta each frame.
const ZOOM_STEP_FACTOR = 1.2;
const ZOOM_MIN = 1;
const ZOOM_MAX = 24;

/** Convert HSV (h: 0-360, s: 0-1, v: 0-1) to RGB [r,g,b] (0-1). */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = v - c;
  return [r + m, g + m, b + m];
}

// --- Player render interpolation ---
// The sim runs at TICK_RATE (30Hz) but the renderer runs at the display
// framerate (~60Hz). Without interpolation the player sprite snaps forward
// in stair-steps every sim tick — visible as "teleportation" when zoomed in
// (up to ~14px per tick at ZOOM_MAX). We lerp between the previous and
// current sim-tick positions using a wall-clock accumulator so the rendered
// player moves smoothly at the display framerate.
const TICK_MS = 1000 / TICK_RATE;
// If the player moves more than this many cells in one tick transition, treat
// it as a teleport (respawn / world reset / save load) and snap instead of
// lerping across the gap. Normal max speed is 0.6 cells/tick × up to 5
// catch-up ticks = 3 cells; 10 is safely above that.
const TELEPORT_SNAP_R2 = 10 * 10;

interface Bomb {
  x: number; y: number;       // world cell coords (float)
  vx: number; vy: number;     // velocity per tick
  ticks: number;              // ticks since thrown
}

export class MiningRenderer extends GameRenderer {
  private gridPass: SandGridPass | null = null;
  private bgGridPass: BackgroundGridPass | null = null;
  private backdropPass: BackdropPass | null = null;
  private stickmanPass: StickmanPass | null = null;
  private fogPass: FogOfWarPass | null = null;
  private lightAccumPass: LightAccumPass | null = null;
  private volumetricPass: VolumetricLightPass | null = null;
  private input: MiningInputState | null = null;
  private workerHost: MiningWorkerHost | null = null;
  private backdropHost: BackdropWorkerHost | null = null;
  private gridReader: MiningSimBufferReader | null = null;
  private autosave: AutosaveManager | null = null;
  private camera: Camera2D;
  // Dirty-tracking — skip rendering when nothing changed (player idle).
  // Tracks the last-rendered state; if nothing changed, we skip grid uploads
  // + render passes entirely and just re-present the last frame.
  private lastRenderedTick = -1;
  private lastRenderedOriginX = 0;
  private lastRenderedOriginY = 0;
  private lastRenderedCamX = NaN;
  private lastRenderedCamY = NaN;
  private lastRenderedCamZoom = NaN;
  private lastRenderedHealth = -1;
  private lastRenderedExplosions = 0;
  private lastRenderedGlowsticks = 0;
  private lastRenderedHeadlamp = false;
  private forceDirty = true; // first frame must always render
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private respawning = false; // suppresses death re-detection until SAB health > 0
  private lastTeleportTime = 0; // timestamp of last teleport (for cooldown)
  private simReady = false; // false until the worker writes its first frame (prevents false death on init/hot-reload)
  // Signpost position (surface spawn point) — computed once, used for sell proximity
  private readonly signpostX = Math.floor(MAX_CHUNKS_X * CHUNK_W / 2);
  private readonly signpostY: number;
  // Bomb state
  private bombs: Bomb[] = [];
  private lastBombTime = 0;
  private prevMouseRight = false;
  // Explosion flashes: { x, y, age, maxAge } in world coords
  private explosions: { x: number; y: number; age: number; maxAge: number }[] = [];
  // Glowstick state (thrown light sources that persist for 1 hour real time)
  private glowsticks: SavedGlowstick[] = [];
  private prevKeyG = false;
  // Enemy state — client-side simple creatures that spawn in dark caves,
  // chase the player, and deal contact damage. Killed by bombs or mining.
  private enemies: Enemy[] = [];
  private enemySpawnTimer = 0;
  // Debug toggle (F1): when true, fog-of-war and the lighting/shadow passes are
  // disabled — the light texture is cleared to full white and the volumetric
  // texture to black so the scene renders fully lit with no fog overlay.
  private disableFogAndShadows = false;
  // Player render interpolation: prev = position at the previous sim tick,
  // cur = position at the current sim tick. The rendered player is lerped
  // between them by alpha = renderAccumulator / TICK_MS.
  private prevPx = 0;
  private prevPy = 0;
  private curPx = 0;
  private curPy = 0;
  private lastTick = -1;
  private renderAccumulator = 0;
  private interpInitialized = false;
  // Stats tracking: last sim tick we recorded (for delta tick counting)
  private lastStatsTick = -1;
  // Achievement check timer (checks every 1 second, not every frame)
  private achievementCheckTimer = 0;
  // Camera snap-on-first-frame: the camera starts at (0,0) from makeCamera2D
  // (constructor / hot reload). Without this flag, the first updateCamera call
  // lerps from (0,0) toward the player — visible as a tween from the top-left
  // corner on hot reload. Snapping on the first frame avoids the tween.
  private cameraInitialized = false;

  constructor(canvas: HTMLCanvasElement, _deterministic: boolean) {
    super(canvas, {
      mode: "2d",
      clearColor: { r: 0, g: 0, b: 0, a: 1 },
    });
    // 2D mode with viewportCount=0: we do custom rendering in afterFrame
    this.setViewportCount(0);
    this.camera = makeCamera2D(canvas.width, canvas.height, { zoom: 4, x: 0, y: 0 });
    // Compute signpost Y from terrain (surface height at spawn X)
    this.signpostY = surfaceHeightAt(this.signpostX, WORLD_SEED);
  }

  getFPS(): number { return super.getFPS(); }
  getCanvas(): HTMLCanvasElement { return super.getCanvas(); }
  getWorkerHost(): MiningWorkerHost | null {
    return this.workerHost;
  }
  getCamera(): Camera2D {
    return this.camera;
  }
  /** Active grid origin in WORLD cell coords (top-left of the simulated
   *  window). Used by the debug chunk-border overlay to highlight the active
   *  simulation window. Returns {0,0} before the worker writes its first
   *  frame. */
  getActiveGridOrigin(): { x: number; y: number; w: number; h: number } {
    const originX = this.gridReader?.getStat(STATS.ORIGIN_X) ?? 0;
    const originY = this.gridReader?.getStat(STATS.ORIGIN_Y) ?? 0;
    return { x: originX, y: originY, w: ACTIVE_GRID_W, h: ACTIVE_GRID_H };
  }
  /** Signpost world position (surface spawn point). */
  getSignpostPos(): { x: number; y: number } {
    return { x: this.signpostX, y: this.signpostY };
  }
  /** Surface height (world Y) at a given world X — for placing objects on the ground. */
  getSurfaceHeightAt(wx: number): number {
    return surfaceHeightAt(wx, WORLD_SEED);
  }
  /** Grid reader for minimap/overlays that need direct grid access. */
  getGridReader(): MiningSimBufferReader | null {
    return this.gridReader;
  }
  /** Player position in world coords (for minimap). */
  getPlayerPos(): { x: number; y: number } {
    if (!this.workerHost) return { x: 0, y: 0 };
    return {
      x: this.workerHost.getPlayerF32(PLAYER.PX),
      y: this.workerHost.getPlayerF32(PLAYER.PY),
    };
  }
  /**
   * Get the material at the mouse cursor position (for ore tooltips).
   * Returns { mat, wx, wy } where mat is the material ID at the hovered
   * cell, or 0 if the cell is air/out of bounds. wx/wy are world cell coords.
   */
  getHoveredCell(): { mat: number; wx: number; wy: number } {
    if (!this.gridReader || !this.input) return { mat: 0, wx: 0, wy: 0 };
    const dpr = window.devicePixelRatio || 1;
    const screenX = this.input.mouseX * dpr;
    const screenY = this.input.mouseY * dpr;
    const world = screenToWorld(this.camera, screenX, screenY);
    const wx = Math.floor(world.x);
    const wy = Math.floor(world.y);
    const originX = this.gridReader.getStat(STATS.ORIGIN_X);
    const originY = this.gridReader.getStat(STATS.ORIGIN_Y);
    const lx = wx - originX;
    const ly = wy - originY;
    if (lx < 0 || ly < 0 || lx >= ACTIVE_GRID_W || ly >= ACTIVE_GRID_H) {
      return { mat: 0, wx, wy };
    }
    const grid = this.gridReader.getGrid();
    const packed = grid[ly * ACTIVE_GRID_W + lx];
    const mat = packed & 0xff; // material ID is lowest 8 bits
    return { mat, wx, wy };
  }
  /** Get the mouse screen position (CSS pixels) for tooltip positioning. */
  getMouseScreenPos(): { x: number; y: number } {
    if (!this.input) return { x: 0, y: 0 };
    return { x: this.input.mouseX, y: this.input.mouseY };
  }
  /** Get the player's screen position (CSS pixels) for floating text. */
  getPlayerScreenPos(): { x: number; y: number } {
    if (!this.workerHost) return { x: 0, y: 0 };
    const px = this.workerHost.getPlayerF32(PLAYER.PX);
    const py = this.workerHost.getPlayerF32(PLAYER.PY);
    const screen = worldToScreen(this.camera, px, py);
    const dpr = window.devicePixelRatio || 1;
    return { x: screen.x / dpr, y: screen.y / dpr };
  }
  /** Reset camera zoom to 1x (called from R key). */
  resetZoom(): void {
    this.camera.zoom = 1;
  }

  /** Pause the simulation (called from UI menus). */
  pause(): void {
    this.workerHost?.pause();
  }
  /** Save the world immediately (called from the escape menu "Save Now" button). */
  async saveNow(): Promise<void> {
    await this.autosave?.saveNow();
    useGameStore.getState().setLastSaveTime(Date.now());
  }
  /**
   * Teleport the player to the surface spawn point. Costs gold based on
   * current depth (1 gold per 10m). Returns true on success, false if the
   * player can't afford it or is already at the surface.
   */
  teleportToSurface(): boolean {
    const s = useGameStore.getState();
    if (s.gameOver || s.paused) return false;
    // Cooldown check (3 seconds)
    const now = Date.now();
    if (now - this.lastTeleportTime < 3000) return false;
    const depthMeters = s.depth * 128;
    if (depthMeters < 10) return false; // already at surface
    const cost = Math.max(1, Math.floor(depthMeters / 10));
    if (s.currency < cost) return false;
    // Deduct gold and teleport
    s.addCurrency(-cost);
    s.recordGoldSpent(cost);
    s.recordTeleport();
    // Spawn teleport floating text
    const pos = this.getPlayerScreenPos();
    s.spawnFloatingText(pos.x, pos.y - 30, `Teleport -${cost}g`, "#42a5f5");
    this.lastTeleportTime = now;
    this.resetInterpolation();
    this.workerHost?.respawn();
    return true;
  }

  /** Resume the simulation (called from UI menus). */
  resume(): void {
    this.workerHost?.resume();
  }

  async init(): Promise<boolean> {
    const ok = await super.init();
    if (!ok) return false;

    const device = this.getDevice()!;
    const format = this.getFormat();
    const canvas = this.getCanvas();

    // Handle GPU device loss — disable the volumetric compute pass (the most
    // likely culprit for TDR crashes) so the game can attempt to continue
    // with just the LightAccumPass lighting.
    device.lost.then((info: GPUDeviceLostInfo) => {
      console.error(`[DownDraft] GPU device lost: ${info.message}`);
      if (this.volumetricPass) {
        this.volumetricPass.disabled = true;
      }
    });

    this.input = createMiningInputHandler(canvas);

    this.camera = makeCamera2D(canvas.width, canvas.height, { zoom: 4, x: 0, y: 0 });

    this.gridPass = new SandGridPass(device, format, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.gridPass.init(canvas.width, canvas.height);

    // Background grid pass — renders build materials (scaffolding/ladders/ropes)
    // with material-specific shape masks, between the backdrop and foreground.
    this.bgGridPass = new BackgroundGridPass(device, format, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.bgGridPass.init(canvas.width, canvas.height);

    // Backdrop pass (rendered behind the foreground with parallax)
    this.backdropPass = new BackdropPass(device, format);
    this.backdropPass.init();

    this.stickmanPass = new StickmanPass(device, format);
    this.stickmanPass.init();

    // Fog-of-war pass: renders solid black over unexplored cells, transparent
    // over explored cells. The light texture (below) provides the actual
    // lighting for explored cells — dim ambient underground, bright near lights.
    this.fogPass = new FogOfWarPass(device, format, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.fogPass.init();

    // Light accumulation pass (renders to a half-res light texture).
    // Provides per-cell colored lighting: ambient (sky light that drops with
    // depth) + dynamic lights (headlamp, torches, lava, explosions).
    this.lightAccumPass = new LightAccumPass(device);
    this.lightAccumPass.init(ACTIVE_GRID_W, ACTIVE_GRID_H);

    // Volumetric light pass (render-pass-based diffusion through air/water/solid).
    // Uses fragment shaders + render targets (no compute shaders, no storage
    // textures) for maximum GPU compatibility. Diffuses ambient + world lights
    // (lava, torches, glowsticks) through cells with per-medium attenuation so
    // caves are visualized with light flooding through air tunnels and dimming
    // in water. Augments LightAccumPass, which keeps sharp nearby lights.
    this.volumetricPass = new VolumetricLightPass(device);
    this.volumetricPass.init(ACTIVE_GRID_W, ACTIVE_GRID_H);

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
        // Restore chunks + player state + upgrades in the worker
        await this.workerHost.loadSaveData({
          player: save.player,
          upgrades: save.upgrades,
          buildMaterials: save.buildMaterials,
          chunks: save.chunks,
          tick: 0, // don't restore tick counter (fresh start)
        });
        // Restore inventory, upgrades, and currency to the game store
        const store = useGameStore.getState();
        store.setInventory(save.inventory);
        if (save.upgrades) store.setUpgrades(save.upgrades);
        if (save.player.health) store.setHealth(save.player.health);
        store.setCurrency(save.currency ?? 0);
        store.setBuildMaterials(save.buildMaterials ?? { scaffolding: 0, ladder: 0, rope: 0, torch: 0 });
        // Restore stats (old saves without stats get a fresh zeroed stats object)
        if (save.stats) store.setStats(save.stats);
        // Restore achievements (old saves without achievements get an empty set)
        if (save.unlockedAchievements) {
          store.setUnlockedAchievements(new Set(save.unlockedAchievements));
        }
        // Restore crafted items (old saves without crafted items get zeroed counts)
        if (save.craftedItems) store.setCraftedItems(save.craftedItems);
        // Restore camera zoom (clamped to the allowed range; old saves
        // without a zoom field keep the default from makeCamera2D).
        if (typeof save.zoom === "number" && Number.isFinite(save.zoom)) {
          this.camera.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, save.zoom));
        }
        // Restore glowsticks (defensive: filter out malformed entries and
        // clamp any future-dated bornAt to now so a bad save can't create a
        // glowstick that never expires). Old saves without glowsticks load
        // with an empty array.
        const now = Date.now();
        this.glowsticks = (save.glowsticks ?? [])
          .filter((g) => g && typeof g.x === "number" && typeof g.y === "number" && Array.isArray(g.color))
          .map((g) => ({
            x: g.x, y: g.y,
            vx: g.settled ? 0 : (g.vx ?? 0),
            vy: g.settled ? 0 : (g.vy ?? 0),
            ticks: g.ticks ?? 0,
            settled: !!g.settled,
            bornAt: Math.min(g.bornAt ?? now, now),
            color: g.color as [number, number, number],
          }))
          .slice(0, MAX_GLOWSTICKS);
        // Show welcome back message
        const stats = store.stats;
        const playTimeSecs = Math.floor(stats.totalTicks / 60);
        const playTimeStr = playTimeSecs > 3600
          ? `${Math.floor(playTimeSecs / 3600)}h ${Math.floor((playTimeSecs % 3600) / 60)}m`
          : playTimeSecs > 60
            ? `${Math.floor(playTimeSecs / 60)}m`
            : `${playTimeSecs}s`;
        store.setWelcomeBack(
          `Welcome back! Depth: ${stats.maxDepthCells}m | Gold: ${save.currency ?? 0}g | Play time: ${playTimeStr} | Deaths: ${stats.totalDeaths}`
        );
      }
    } catch (e) {
      console.warn("[MiningRenderer] Failed to load save:", e);
    }

    // Resume the worker now that save data has been loaded (or there was no
    // save). The worker starts paused (see mining-worker.ts init) to prevent
    // it from simulating at the default spawn position before saved chunks
    // are restored, which would overwrite saved chunks near spawn with
    // freshly generated terrain on the first rebuild.
    this.workerHost.resume();

    // --- Set up autosave ---
    this.autosave = createAutosaveManager(async () => {
      const saveData = await this.workerHost!.getSaveData();
      const store = useGameStore.getState();
      if (!saveData) {
        return { version: 1, seed: WORLD_SEED, player: { x: 0, y: 0, vx: 0, vy: 0, onGround: false, facing: 1, animFrame: 0, health: 100, lastDamageMaterial: 0, oxygen: OXYGEN_MAX_TICKS }, upgrades: { damage: 0, radius: 0, rate: 0, inventorySize: 0 }, buildMaterials: { scaffolding: 0, ladder: 0, rope: 0, torch: 0 }, inventory: [], currency: 0, chunks: [], glowsticks: this.glowsticks, zoom: this.camera.zoom, stats: store.stats, unlockedAchievements: [...store.unlockedAchievements], craftedItems: store.craftedItems, savedAt: Date.now() };
      }
      return {
        version: 1,
        seed: WORLD_SEED,
        player: saveData.player,
        upgrades: saveData.upgrades,
        buildMaterials: saveData.buildMaterials,
        inventory: store.inventory,
        currency: store.currency,
        chunks: saveData.dirtyChunks,
        glowsticks: this.glowsticks,
        zoom: this.camera.zoom,
        stats: store.stats,
        unlockedAchievements: [...store.unlockedAchievements],
        craftedItems: store.craftedItems,
        savedAt: Date.now(),
      };
    }, deterministic);
    // Update lastSaveTime after each autosave
    this.autosave.onSaved(() => {
      useGameStore.getState().setLastSaveTime(Date.now());
    });
    this.autosave.start();

    // Handle collected items
    this.workerHost.onCollectedItems((items) => {
      const store = useGameStore.getState();
      for (const item of items) {
        store.addToInventory(item.mat, item.count);
      }
      if (items.length > 0) {
        store.recordCollected(items);
      }
    });

    // Sync build material counts (worker is the source of truth — placement
    // consumes and purchases add). The store mirror is for display.
    this.workerHost!.onBuildMaterials((mats) => {
      useGameStore.getState().setBuildMaterials(mats);
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

    // Wire the afterFrame callback for custom 2D rendering
    this.setCallbacks({
      afterFrame: (dt) => this.drawFrame(dt),
      onResize: () => this.handleResize(),
    });

    return true;
  }

  private handleResize(): void {
    if (!this.gridPass) return;
    const canvas = this.getCanvas();
    this.camera.width = canvas.width;
    this.camera.height = canvas.height;
    this.forceDirty = true;
  }

  /** Reset player position interpolation state. Call after the player
   *  position is known to jump discontinuously (respawn, world reset, save
   *  load) so the renderer doesn't try to lerp across the gap. */
  private resetInterpolation(): void {
    this.interpInitialized = false;
    this.cameraInitialized = false;
    this.lastTick = -1;
    this.renderAccumulator = 0;
    this.prevPx = 0;
    this.prevPy = 0;
    this.curPx = 0;
    this.curPy = 0;
  }

  /** Set the frame rate limit from the display refresh rate. GameRenderer
   *  manages the limiter state — this delegates to the base class. */
  setFrameRateLimit(refreshRate: number): void {
    super.setFrameRateLimit(refreshRate);
  }

  async stop(): Promise<void> {
    super.stop();
    // Final save before shutdown
    if (this.autosave) {
      try { await this.autosave.saveNow(); } catch {}
      this.autosave.stop();
    }
    this.workerHost?.stop();
    this.backdropHost?.stop();
    this.stickmanPass?.destroy();
    this.backdropPass?.destroy();
    this.bgGridPass?.destroy();
    this.fogPass?.destroy();
    this.lightAccumPass?.destroy();
    this.volumetricPass?.destroy();
    if (this.keydownHandler) window.removeEventListener("keydown", this.keydownHandler);
    this.destroy();
  }

  /**
   * Respawn the player at the surface spawn point with full health.
   * Called from the DeathMenu UI when the player clicks "Respawn".
   * Resets the game-over state, resumes the simulation, and tells the
   * worker to reset the player position.
   */
  respawn(): void {
    const s = useGameStore.getState();
    // Suppress death re-detection until the worker processes the respawn
    // and writes health > 0 back to the SAB. Without this, the next frame
    // reads the stale health=0 from the SAB and re-triggers the death menu.
    this.respawning = true;
    this.resetInterpolation();
    s.setGameOver(false);
    s.setHealth(100);
    s.setOxygen(OXYGEN_MAX_TICKS);
    s.setDeathCause(0);
    s.setDeathQuip("");
    this.workerHost?.respawn();
    this.workerHost?.resume();
    s.setPaused(false);
  }

  /**
   * Reset the entire world: stop the sim worker, delete the save, reset the
   * game store, and restart the worker with a fresh ChunkWorld. The world
   * regenerates from seed (new ore veins, terrain, etc.). Called from the
   * EscapeMenu UI when the player clicks "Reset World".
   */
  async resetWorld(): Promise<void> {
    const s = useGameStore.getState();

    // Stop autosave so it doesn't write the old state back during teardown
    this.autosave?.stop();

    // Stop the current sim worker + backdrop worker
    await this.workerHost?.stop();
    await this.backdropHost?.stop();

    // Delete the saved world so the fresh worker doesn't reload it
    try {
      await deleteSave();
    } catch (e) {
      console.warn("[MiningRenderer] Failed to delete save on reset:", e);
    }

    // Reset all game store state to defaults
    s.setGameOver(false);
    s.setHealth(100);
    s.setOxygen(OXYGEN_MAX_TICKS);
    s.setDeathCause(0);
    s.setDeathQuip("");
    s.setInventory([]);
    s.setUpgrades({ damage: 0, radius: 0, rate: 0, inventorySize: 0 });
    s.setCurrency(0);
    s.setNearSignpost(false);
    s.setPaused(false);
    s.setBuildMode(false);
    s.setBuildMaterials({ scaffolding: 0, ladder: 0, rope: 0, torch: 0 });
    s.resetStats();
    s.resetAchievements();
    s.resetCraftedItems();
    this.lastStatsTick = -1;

    // Clear bombs + explosions + glowsticks + enemies
    this.bombs = [];
    this.explosions = [];
    this.glowsticks = [];
    this.enemies = [];
    this.enemySpawnTimer = 0;

    // Suppress death/health detection until the new worker writes its first frame
    this.respawning = true;
    this.simReady = false;
    this.resetInterpolation();

    // Restart the sim worker with a fresh ChunkWorld
    this.workerHost = new MiningWorkerHost();
    await this.workerHost.start();
    this.gridReader = this.workerHost.getReader();
    this.workerHost.onCollectedItems((items) => {
      const store = useGameStore.getState();
      for (const item of items) {
        store.addToInventory(item.mat, item.count);
      }
      if (items.length > 0) {
        store.recordCollected(items);
      }
    });

    // Restart the backdrop worker
    this.backdropHost = new BackdropWorkerHost();
    await this.backdropHost.start();

    // Resume the worker — it starts paused (see mining-worker.ts init) to
    // prevent simulating at the default spawn before save data is loaded.
    // resetWorld deletes the save, so there's nothing to load — resume now.
    this.workerHost.resume();

    // Restart autosave
    if (this.autosave) {
      this.autosave.start();
    }
  }

  private drawFrame(dt: number): void {
    const device = this.getDevice();
    const context = this.getContext();
    const canvas = this.getCanvas();
    if (!device || !context || !this.input || !this.gridReader ||
        !this.gridPass || !this.backdropPass || !this.stickmanPass || !this.workerHost ||
        !this.backdropHost || !this.lightAccumPass || !this.volumetricPass) return;

    // --- Write input to worker ---
    this.writeInputToWorker();

    // --- Read active grid origin and upload grid atomically ---
    // The worker writes the grid BEFORE the origin (see mining-worker.ts).
    // To avoid a race condition where we upload a new grid but use an old
    // origin (or vice versa), we read the origin before AND after the grid
    // upload. If the origin changed, the worker wrote during the upload.
    // Since the worker writes grid → origin, a new origin means the grid is
    // also new (already in the SAB). Re-read and re-upload the grid to ensure
    // the GPU texture matches the new origin.
    const originXBefore = this.gridReader.getStat(STATS.ORIGIN_X);
    const originYBefore = this.gridReader.getStat(STATS.ORIGIN_Y);

    // --- Read active grid + background grid from SAB and upload to GPU ---
    this.gridPass.updateGrid(this.gridReader.getGrid());
    this.gridPass.updateUniforms();
    this.bgGridPass!.updateGrid(this.gridReader.getBackgroundGrid());
    this.bgGridPass!.updateUniforms();

    let originX = originXBefore;
    let originY = originYBefore;

    const originXAfter = this.gridReader.getStat(STATS.ORIGIN_X);
    const originYAfter = this.gridReader.getStat(STATS.ORIGIN_Y);
    if (originXAfter !== originXBefore || originYAfter !== originYBefore) {
      // The worker wrote during the upload. The new origin is correct, and
      // the grid in the SAB is now the new grid (worker writes grid before
      // origin). Re-upload to ensure the GPU texture matches the new origin.
      originX = originXAfter;
      originY = originYAfter;
      this.gridPass.updateGrid(this.gridReader.getGrid());
      this.bgGridPass!.updateGrid(this.gridReader.getBackgroundGrid());
    }

    // --- Read player state ---
    // Read the tick BEFORE the player position. The sim writes position →
    // tick (mining-worker.ts:250-263), so if the tick just changed, the
    // position we read right after is from the new tick. Reading tick first
    // avoids a race where we get a new tick but stale position.
    const tick = this.gridReader.getStat(STATS.TICK);
    const px = this.workerHost.getPlayerF32(PLAYER.PX);
    const py = this.workerHost.getPlayerF32(PLAYER.PY);
    const facing = this.workerHost.getPlayerI32(PLAYER.FACING);
    const animFrame = this.workerHost.getPlayerI32(PLAYER.ANIM_FRAME);
    const health = this.workerHost.getPlayerI32(PLAYER.HEALTH);
    const deathCause = this.workerHost.getPlayerI32(PLAYER.DEATH_CAUSE);
    const oxygen = this.workerHost.getPlayerI32(PLAYER.OXYGEN);
    const onGround = this.workerHost.getPlayerI32(PLAYER.ON_GROUND) !== 0;
    const vx = this.workerHost.getPlayerF32(PLAYER.VX);
    const vy = this.workerHost.getPlayerF32(PLAYER.VY);

    // --- Render-side player position interpolation ---
    // The sim writes a new player position to the SAB at TICK_RATE (30Hz).
    // The renderer runs at the display framerate (~60Hz), so without
    // interpolation the player snaps forward in 0.6-cell stair-steps every
    // tick — visible as "teleportation" when zoomed in. We track the
    // previous and current sim-tick positions and lerp between them using a
    // wall-clock accumulator, so the rendered player moves smoothly.
    if (tick !== this.lastTick) {
      if (this.interpInitialized) {
        this.prevPx = this.curPx;
        this.prevPy = this.curPy;
        this.curPx = px;
        this.curPy = py;
        // Teleport detection: if the position jumped too far for normal
        // movement (respawn / world reset / save load), snap instead of
        // lerping across the gap.
        const ddx = this.curPx - this.prevPx;
        const ddy = this.curPy - this.prevPy;
        if (ddx * ddx + ddy * ddy > TELEPORT_SNAP_R2) {
          this.prevPx = this.curPx;
          this.prevPy = this.curPy;
        }
      } else {
        // First tick: seed prev = cur so we render a stationary player
        // until the next tick arrives (no previous position to lerp from).
        this.prevPx = px;
        this.prevPy = py;
        this.curPx = px;
        this.curPy = py;
        this.interpInitialized = true;
      }
      this.lastTick = tick;
      this.renderAccumulator = 0;
    }
    // Advance the accumulator by wall-clock dt. Clamped to TICK_MS so a long
    // frame (e.g. tab throttled) doesn't overshoot past the current sim
    // position.
    this.renderAccumulator = Math.min(TICK_MS, this.renderAccumulator + dt * 1000);
    const alpha = this.renderAccumulator / TICK_MS;
    const interpPx = this.prevPx + (this.curPx - this.prevPx) * alpha;
    const interpPy = this.prevPy + (this.curPy - this.prevPy) * alpha;

    // --- Update backdrop window + upload backdrop grid ---
    // The backdrop uses the same chunk origin as the foreground.
    const fgOriginCx = Math.floor(originX / CHUNK_W);
    const fgOriginCy = Math.floor(originY / CHUNK_H);
    this.backdropHost.updateWindowIfNeeded(fgOriginCx, fgOriginCy);
    this.backdropPass.updateGrid(this.backdropHost.getGrid());

    // Convert the interpolated player world coords to active-grid-local
    // coords. The grid texture and stickman shader both work in local coords.
    const localPx = interpPx - originX;
    const localPy = interpPy - originY;

    // Track the camera in WORLD coords — this is continuous across chunk
    // boundary crossings (the active grid origin shifts by CHUNK_W, which
    // would make a local-space target jump by a full chunk). The camera
    // lerps toward the interpolated player position; we convert to local
    // below. Using the interpolated position keeps the camera in lockstep
    // with the smoothed player (no relative teleportation).
    // Snap the camera to the target on the first frame (after construction,
    // hot reload, respawn, or save load) instead of lerping from (0,0) —
    // which would visibly tween from the top-left corner.
    if (!this.cameraInitialized) {
      this.camera.x = interpPx;
      this.camera.y = interpPy;
      this.cameraInitialized = true;
    } else {
      updateCamera(this.camera, interpPx, interpPy);
    }
    // Apply queued zoom steps from "=" / "-" keybinds. Each step multiplies
    // (or divides) the zoom by ZOOM_STEP_FACTOR; clamped to [ZOOM_MIN, ZOOM_MAX].
    if (this.input.zoomDelta !== 0) {
      this.camera.zoom = Math.max(
        ZOOM_MIN,
        Math.min(ZOOM_MAX, this.camera.zoom * Math.pow(ZOOM_STEP_FACTOR, this.input.zoomDelta)),
      );
      this.input.zoomDelta = 0;
    }
    // Sync player health + oxygen + depth to store (needed for depth uniform)
    const s = useGameStore.getState();
    // Update teleport cooldown (3s cooldown)
    if (this.lastTeleportTime > 0) {
      const elapsed = Date.now() - this.lastTeleportTime;
      const cd = Math.min(1, elapsed / 3000);
      if (s.teleportCooldown !== cd) s.setTeleportCooldown(cd);
    }
    // Sync player facing direction
    if (s.playerFacing !== facing) s.setPlayerFacing(facing);
    // Sync player speed (cells/sec = vx * 60 ticks/sec)
    const speed = Math.sqrt(vx * vx + vy * vy) * 60;
    if (Math.abs(s.playerSpeed - speed) > 0.5) s.setPlayerSpeed(speed);
    // Sync glowstick count
    if (s.glowstickCount !== this.glowsticks.length) s.setGlowstickCount(this.glowsticks.length);
    // Sync bomb count
    if (s.bombCount !== this.bombs.length) s.setBombCount(this.bombs.length);
    // Sync zoom level
    if (s.zoom !== this.camera.zoom) s.setZoom(this.camera.zoom);
    // Sync on-ground state
    if (s.onGround !== onGround) s.setOnGround(onGround);
    if (s.health !== health) {
      // Detect damage (health decreased) and spawn floating damage number
      if (health < s.health && !this.respawning) {
        const damage = Math.ceil(s.health - health);
        const screen = worldToScreen(this.camera, px, py);
        const dpr = window.devicePixelRatio || 1;
        s.spawnFloatingText(
          screen.x / dpr + (Math.random() - 0.5) * 30,
          screen.y / dpr - 20,
          `-${damage}`,
          "#f44336",
        );
        // Trigger screen shake scaled by damage
        s.triggerScreenShake(damage);
      }
      s.setHealth(health);
    }
    if (s.oxygen !== oxygen) s.setOxygen(oxygen);
    const depth = Math.floor(py / 128);
    if (s.depth !== depth) s.setDepth(depth);
    // Cell depth below the surface (for lighting — ambient drops with actual depth)
    const surfaceY = surfaceHeightAt(px, WORLD_SEED);
    const depthCells = Math.max(0, py - surfaceY);
    // Track stats: max depth + tick count (only when sim is running, not paused)
    if (!s.paused && !s.gameOver) {
      s.recordDepth(Math.floor(depthCells));
      const tick = this.gridReader.getStat(STATS.TICK);
      const lastTick = this.lastStatsTick;
      if (lastTick >= 0 && tick > lastTick) {
        s.recordTicks(tick - lastTick);
      }
      this.lastStatsTick = tick;
    }
    // Achievement check — runs every 1 second (not every frame). Checks all
    // locked achievements against the current game state and unlocks any that
    // pass their check function. The store sets recentAchievement for the toast.
    this.achievementCheckTimer += dt;
    if (this.achievementCheckTimer >= 1) {
      this.achievementCheckTimer = 0;
      useGameStore.getState().checkAndUnlockAchievements();
    }
    const loadedChunks = this.gridReader.getStat(STATS.LOADED_CHUNKS);
    if (s.loadedChunks !== loadedChunks) s.setLoadedChunks(loadedChunks);

    // Signpost proximity check — player must be near the surface spawn point
    // (within SIGNPOST_RADIUS cells horizontally and near the surface vertically)
    const dx = Math.abs(px - this.signpostX);
    const nearSign = dx <= SIGNPOST_RADIUS && depth === 0;
    if (s.nearSignpost !== nearSign) s.setNearSignpost(nearSign);

    // Wait for the worker to write its first frame before doing any death
    // detection. The SAB starts zeroed (health=0), so without this guard the
    // death menu would fire on init / hot-reload before the worker runs.
    if (!this.simReady) {
      if (health > 0 || this.gridReader.getStat(STATS.TICK) > 0) this.simReady = true;
    }

    // Death detection — when health reaches 0, pause the simulation and
    // show the death menu. Only triggers once (guarded by gameOver flag).
    // The quip is picked once here so it doesn't rotate on re-renders.
    // The respawning flag suppresses re-detection after clicking Respawn
    // until the worker writes health > 0 back to the SAB.
    if (this.respawning) {
      if (health > 0) this.respawning = false;
    } else if (this.simReady && health <= 0 && !s.gameOver && !s.paused) {
      s.setDeathCause(deathCause);
      s.setDeathQuip(pickDeathQuip(deathCause));
      s.setGameOver(true);
      s.recordDeath(deathCause);
      this.workerHost?.pause();
    }

    // Convert camera world coords → active-grid-local coords for the
    // render passes (grid texture + stickman shader work in local coords).
    const camLocalX = this.camera.x - originX;
    const camLocalY = this.camera.y - originY;

    this.gridPass.updateCamera(
      camLocalX, camLocalY, this.camera.zoom,
      canvas.width, canvas.height,
      depth,
    );
    // Background grid uses the same camera as the foreground (same resolution,
    // same world-space position — the bg grid is at the same active-grid coords).
    this.bgGridPass!.updateCamera(
      camLocalX, camLocalY, this.camera.zoom,
      canvas.width, canvas.height,
      depth,
    );
    // Backdrop camera: use the backdrop's stable origin (which is shifted
    // immediately when the foreground origin changes, so it stays aligned).
    // The backdrop grid content is also shifted to match, so the camera
    // and grid are always in sync.
    const bdOriginX = this.backdropHost.getOriginX();
    const bdOriginY = this.backdropHost.getOriginY();
    const bdCamX = this.camera.x * BACKDROP_PARALLAX - bdOriginX;
    const bdCamY = this.camera.y * BACKDROP_PARALLAX - bdOriginY;
    this.backdropPass.updateCamera(
      bdCamX, bdCamY, this.camera.zoom,
      canvas.width, canvas.height,
    );
    // Update backdrop uniforms with origin Y + surface Y for sky gradient.
    // The backdrop is full-res, so worldY = originY + coords.y (no scaling).
    // Use the base (noise-free) surface Y so the horizon doesn't shift as the
    // player walks through rolling hills.
    this.backdropPass.updateUniforms(bdOriginY, BASE_SURFACE_Y);

    // --- Update stickman (in local coords) ---
    this.stickmanPass.update(
      localPx, localPy, facing, animFrame,
      camLocalX, camLocalY, this.camera.zoom,
      canvas.width, canvas.height,
      health, onGround, vx, vy,
    );

    // --- Update fog-of-war pass ---
    this.fogPass!.updateGrid(this.gridReader.getExploredGrid());
    // Pass the grid texture view so the fog shader can check if a cell is air
    // (matId==0) and skip fogging it — this makes the fog boundary follow the
    // actual terrain surface per-cell, not a single global surfaceY that shifts
    // as the player moves horizontally.
    this.fogPass!.setGridView(this.gridPass.getGridView());
    this.fogPass!.updateCamera(
      camLocalX, camLocalY, this.camera.zoom,
      canvas.width, canvas.height,
      depth,
    );

    // --- Update light accumulation pass ---
    // LightAccumPass: explosions only (sharp brief flashes)
    // VolumetricLightPass: ambient + headlamp + world lights + glowsticks
    //   ALL persistent light goes through the volumetric pass so it diffuses
    //   through air/water/solid. Only explosions stay sharp (they're brief).
    const { count: workerLightCount, lights: workerLights } = this.gridReader.getLightRegion();

    const rendererLights: RendererLight[] = [];
    for (const exp of this.explosions) {
      const progress = exp.age / exp.maxAge;
      rendererLights.push(createExplosionLight(exp.x, exp.y, progress));
    }
    this.lightAccumPass!.updateLights(workerLights, 0, rendererLights, originX, originY);
    this.lightAccumPass!.updateAmbient(9999);

    // Volumetric pass: ambient + headlamp + world lights + glowsticks
    // High intensity compensates for diffusion dimming over 8 iterations.
    // Inject only into air/water cells (shader handles this) so light follows
    // tunnel geometry instead of being a flat circle.
    const volRendererLights: VolRendererLight[] = [];
    // Headlamp only activates underground — above ground the sky ambient
    // provides plenty of light, and the headlamp circle looks odd against
    // the bright sky.
    if (useGameStore.getState().headlampOn && depthCells > 0) {
      volRendererLights.push({
        x: interpPx, y: interpPy,
        color: HEADLAMP_COLOR,
        intensity: 6.0,
        radius: 20,
      });
    }
    for (const gs of this.glowsticks) {
      volRendererLights.push({
        x: gs.x, y: gs.y,
        color: gs.color,
        intensity: GLOWSTICK_INTENSITY,
        radius: GLOWSTICK_RADIUS,
      });
    }
    this.volumetricPass!.updateLights(workerLights, workerLightCount, volRendererLights, originX, originY);
    // Use the base (noise-free) surface Y for volumetric ambient. The actual
    // surface varies by ±8 cells with terrain noise; using the player's exact
    // surfaceY would shift ambient strength for ALL solid cells as the player
    // walks, causing visible flickering in the overworld.
    this.volumetricPass!.updateUniforms(originX, originY, BASE_SURFACE_Y);

    // --- Dirty check: skip rendering if nothing changed since last frame ---
    // When the player is idle (no movement, no mining, no camera change), the
    // grid, lighting, and camera are identical to the previous frame. Skipping
    // the grid uploads + 6 render passes saves ~50% CPU/GPU when idle.
    const headlampOn = useGameStore.getState().headlampOn;
    const dirty = this.forceDirty ||
      tick !== this.lastRenderedTick ||
      originX !== this.lastRenderedOriginX ||
      originY !== this.lastRenderedOriginY ||
      this.camera.x !== this.lastRenderedCamX ||
      this.camera.y !== this.lastRenderedCamY ||
      this.camera.zoom !== this.lastRenderedCamZoom ||
      health !== this.lastRenderedHealth ||
      this.explosions.length !== this.lastRenderedExplosions ||
      this.glowsticks.length !== this.lastRenderedGlowsticks ||
      headlampOn !== this.lastRenderedHeadlamp;

    if (!dirty) {
      // Nothing changed — skip all render work. GameRenderer handles the
      // next rAF cycle.
      return;
    }

    // Update dirty-tracking state
    this.forceDirty = false;
    this.lastRenderedTick = tick;
    this.lastRenderedOriginX = originX;
    this.lastRenderedOriginY = originY;
    this.lastRenderedCamX = this.camera.x;
    this.lastRenderedCamY = this.camera.y;
    this.lastRenderedCamZoom = this.camera.zoom;
    this.lastRenderedHealth = health;
    this.lastRenderedExplosions = this.explosions.length;
    this.lastRenderedGlowsticks = this.glowsticks.length;
    this.lastRenderedHeadlamp = headlampOn;

    // --- Render ---
    const commandEncoder = device.createCommandEncoder();

    if (this.disableFogAndShadows) {
      // Debug mode (F1): skip the lighting passes and clear the light texture
      // to full white + the volumetric texture to black so the scene renders
      // fully lit (finalColor * (1 + 0) = finalColor) with no shadow gradients.
      const lightClear = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.lightAccumPass!.getLightTextureView()!,
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      lightClear.end();
      const volClear = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.volumetricPass!.getVolumetricTextureView()!,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      volClear.end();
    } else {
      // 1. Light accumulation pass (renders to the light texture)
      this.lightAccumPass!.render(commandEncoder);

      // 2. Volumetric light pass (render-pass-based diffusion through air/water/solid)
      this.volumetricPass!.setGridView(this.gridPass!.getGridView());
      this.volumetricPass!.compute(commandEncoder);
    }

    // Wire the light textures into all material passes
    const lightView = this.lightAccumPass!.getLightTextureView();
    const volView = this.volumetricPass!.getVolumetricTextureView();
    this.backdropPass.setLightTexture(lightView);
    this.bgGridPass!.setLightTexture(lightView);
    this.gridPass.setLightTexture(lightView);
    this.stickmanPass.setLightTexture(lightView);
    this.backdropPass.setVolumetricTexture(volView);
    this.bgGridPass!.setVolumetricTexture(volView);
    this.gridPass.setVolumetricTexture(volView);
    this.stickmanPass.setVolumetricTexture(volView);

    // 2. Main scene pass (renders to the canvas)
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.02, g: 0.02, b: 0.05, a: 1.0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });

    // Render backdrop first (opaque, fills the background)
    this.backdropPass.render(passEncoder);
    // Then background grid (build materials — scaffolding/ladders/ropes with masks)
    this.bgGridPass!.render(passEncoder);
    // Then foreground grid + player on top
    this.gridPass.render(passEncoder);
    this.stickmanPass.render(passEncoder);
    // Fog-of-war overlay last: solid black over unexplored cells, transparent
    // over explored cells (let the light texture do the actual lighting).
    // Skipped in debug mode (F1) so the whole map is visible.
    if (!this.disableFogAndShadows) {
      this.fogPass!.render(passEncoder);
    }

    passEncoder.end();
    device.queue.submit([commandEncoder.finish()]);
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

    // Right-click edge detection: throw a bomb towards the cursor
    const mouseRightNow = this.input.mouseRight;
    if (mouseRightNow && !this.prevMouseRight) {
      this.tryThrowBomb(world.x, world.y);
    }
    this.prevMouseRight = mouseRightNow;

    // F key edge detection: place a torch via raycast toward the cursor
    if (this.input.fPressed) {
      this.input.fPressed = false;
      this.workerHost?.placeTorch(world.x, world.y);
    }

    // G key edge detection: throw a rainbow glowstick toward the cursor
    if (this.input.gPressed) {
      this.input.gPressed = false;
      this.tryThrowGlowstick(world.x, world.y);
    }

    // F1 key edge detection: toggle fog-of-war + shadows (debug)
    if (this.input.f1Pressed) {
      this.input.f1Pressed = false;
      this.disableFogAndShadows = !this.disableFogAndShadows;
      this.forceDirty = true;
      console.log(`[DownDraft] Fog-of-war + shadows ${this.disableFogAndShadows ? "disabled" : "enabled"} (F1)`);
    }

    // Update active bombs (physics + collision + explosion)
    this.updateBombs();
    // Update active glowsticks (physics + settle + expire)
    this.updateGlowsticks();
    // Update enemies (spawn, chase, contact damage, bomb death)
    this.updateEnemies();

    // Sync current inventory to the worker so collect() can enforce max size
    const store = useGameStore.getState();
    this.workerHost.setInventory(store.inventory);
    // Sync upgrades to the worker so mining uses current stats
    this.workerHost.setUpgrades(store.upgrades);
    // Build mode: when active, left-click places the selected material
    // (handled in the worker via world.place) instead of mining.
    this.workerHost.writeBuildInput(store.buildMode, store.getSelectedBuildMatId());
    // Noclip (dev cheat): written every frame so toggling it on/off is
    // immediate. The worker reads it from the SAB each sim tick.
    this.workerHost.writeNoclip(store.noclip);
  }

  /** Throw a bomb from the player towards the target world coords. */
  private tryThrowBomb(targetX: number, targetY: number): void {
    const now = performance.now();
    if (now - this.lastBombTime < BOMB_COOLDOWN_MS) return;
    if (this.bombs.length >= MAX_BOMBS) return;
    this.lastBombTime = now;

    // Read player position from SAB
    const px = this.workerHost!.getPlayerF32(PLAYER.PX);
    const py = this.workerHost!.getPlayerF32(PLAYER.PY);

    // Direction from player center to target
    let dx = targetX - px;
    let dy = targetY - py;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) {
      // Target is essentially at the player's position (e.g. mouse hasn't
      // moved from center yet). Throw in the direction the player is facing
      // so the bomb goes forward instead of straight up or in a random
      // direction.
      const facing = this.workerHost!.getPlayerI32(PLAYER.FACING);
      dx = facing;
      dy = -1; // slight upward angle
      dist = Math.sqrt(dx * dx + dy * dy);
    }

    // Velocity: scale by BOMB_SPEED, with a minimum arc
    const speed = BOMB_SPEED;
    this.bombs.push({
      x: px,
      y: py - 2, // start slightly above player center
      vx: (dx / dist) * speed,
      vy: (dy / dist) * speed - 0.3, // slight upward arc
      ticks: 0,
    });
    useGameStore.getState().recordBombThrown();
  }

  /** Update all active bombs: move, check collision, explode on impact. */
  private updateBombs(): void {
    if (this.bombs.length === 0) {
      // Still age explosion flashes
      this.ageExplosions();
      return;
    }

    const grid = this.gridReader?.getGrid();
    const bgGrid = this.gridReader?.getBackgroundGrid();
    const originX = this.gridReader?.getStat(STATS.ORIGIN_X) ?? 0;
    const originY = this.gridReader?.getStat(STATS.ORIGIN_Y) ?? 0;
    if (!grid) return;

    const surviving: Bomb[] = [];
    for (const bomb of this.bombs) {
      bomb.ticks++;
      bomb.vy += BOMB_GRAVITY;
      bomb.x += bomb.vx;
      bomb.y += bomb.vy;

      // Check if bomb hit a solid cell or expired
      let exploded = false;
      if (bomb.ticks >= BOMB_MAX_TICKS) {
        exploded = true;
      } else {
        // Convert world coords to active grid coords
        const ax = Math.floor(bomb.x - originX);
        const ay = Math.floor(bomb.y - originY);
        if (ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H) {
          const idx = ay * ACTIVE_GRID_W + ax;
          // Check foreground grid for solid terrain
          const packed = grid[idx];
          if (packed !== 0) {
            const mat = packed & 0xff;
            const def = MATERIALS[mat];
            if (def?.solid && mat !== Material.Wall) {
              exploded = true; // hit solid terrain
            }
          }
          // Also check background grid for build materials (scaffolding is solid)
          if (!exploded && bgGrid) {
            const bgPacked = bgGrid[idx];
            if (bgPacked !== 0) {
              const bgMat = bgPacked & 0xff;
              const bgDef = MATERIALS[bgMat];
              if (bgDef?.solid) {
                exploded = true; // hit scaffolding/platform
              }
            }
          }
        } else {
          exploded = true; // out of bounds
        }
      }

      if (exploded) {
        // Tell the worker to explode at the bomb's world position
        this.workerHost?.explode(bomb.x, bomb.y, BOMB_RADIUS);
        // Add a visual explosion flash
        this.explosions.push({ x: bomb.x, y: bomb.y, age: 0, maxAge: 0.5 });
        // Screen shake from explosion (stronger if close to player)
        const px = this.workerHost!.getPlayerF32(PLAYER.PX);
        const py = this.workerHost!.getPlayerF32(PLAYER.PY);
        const dist = Math.sqrt((bomb.x - px) ** 2 + (bomb.y - py) ** 2);
        if (dist < 100) {
          useGameStore.getState().triggerScreenShake(40 * (1 - dist / 100));
        }
      } else {
        surviving.push(bomb);
      }
    }
    this.bombs = surviving;
    this.ageExplosions();
  }

  /** Age and remove expired explosion flashes. */
  private ageExplosions(): void {
    if (this.explosions.length === 0) return;
    const dt = 1 / 60; // approximate
    this.explosions = this.explosions.filter((e) => {
      e.age += dt;
      return e.age < e.maxAge;
    });
  }

  /** Throw a rainbow glowstick from the player towards the target world coords. */
  private tryThrowGlowstick(targetX: number, targetY: number): void {
    if (this.glowsticks.length >= MAX_GLOWSTICKS) return;

    const px = this.workerHost!.getPlayerF32(PLAYER.PX);
    const py = this.workerHost!.getPlayerF32(PLAYER.PY);

    let dx = targetX - px;
    let dy = targetY - py;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) {
      const facing = this.workerHost!.getPlayerI32(PLAYER.FACING);
      dx = facing;
      dy = -1;
      dist = Math.sqrt(dx * dx + dy * dy);
    }

    // Random rainbow color (HSV with full saturation, random hue)
    const hue = Math.random() * 360;
    const rgb = hsvToRgb(hue, 1.0, 1.0);

    this.glowsticks.push({
      x: px,
      y: py - 2,
      vx: (dx / dist) * GLOWSTICK_SPEED,
      vy: (dy / dist) * GLOWSTICK_SPEED - 0.2,
      ticks: 0,
      settled: false,
      bornAt: Date.now(),
      color: rgb,
    });
    useGameStore.getState().recordGlowstickThrown();
  }

  /** Update all active glowsticks: move with gravity, settle on collision,
   *  expire after GLOWSTICK_LIFETIME_MS (1 hour real time). */
  private updateGlowsticks(): void {
    if (this.glowsticks.length === 0) return;
    const grid = this.gridReader?.getGrid();
    const bgGrid = this.gridReader?.getBackgroundGrid();
    const originX = this.gridReader?.getStat(STATS.ORIGIN_X) ?? 0;
    const originY = this.gridReader?.getStat(STATS.ORIGIN_Y) ?? 0;
    const now = Date.now();

    const surviving: SavedGlowstick[] = [];
    for (const gs of this.glowsticks) {
      // Expire after 1 hour real time
      if (now - gs.bornAt > GLOWSTICK_LIFETIME_MS) continue;

      if (gs.settled) {
        // Check if the cell below is still solid — if the terrain was mined/
        // destroyed, resume falling
        const ax = Math.floor(gs.x - originX);
        const ay = Math.floor(gs.y - originY) + 1; // cell below
        if (ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H && grid) {
          const belowIdx = ay * ACTIVE_GRID_W + ax;
          let stillSupported = false;
          const belowPacked = grid[belowIdx];
          if (belowPacked !== 0) {
            const mat = belowPacked & 0xff;
            const def = MATERIALS[mat];
            if (def?.solid) stillSupported = true;
          }
          if (!stillSupported && bgGrid) {
            const bgBelow = bgGrid[belowIdx];
            if (bgBelow !== 0) {
              const bgMat = bgBelow & 0xff;
              const bgDef = MATERIALS[bgMat];
              if (bgDef?.solid) stillSupported = true;
            }
          }
          if (!stillSupported) {
            // Terrain below was destroyed — resume falling
            gs.settled = false;
            gs.vx = 0;
            gs.vy = 0;
            gs.ticks = 0;
          }
        }
      }

      if (!gs.settled) {
        gs.ticks++;
        gs.vy += GLOWSTICK_GRAVITY;
        gs.x += gs.vx;
        gs.y += gs.vy;

        // Check collision with terrain
        if (gs.ticks >= GLOWSTICK_MAX_TICKS) {
          gs.settled = true;
          gs.vx = 0;
          gs.vy = 0;
        } else {
          const ax = Math.floor(gs.x - originX);
          const ay = Math.floor(gs.y - originY);
          if (ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H && grid) {
            const idx = ay * ACTIVE_GRID_W + ax;
            let hit = false;
            const packed = grid[idx];
            if (packed !== 0) {
              const mat = packed & 0xff;
              const def = MATERIALS[mat];
              if (def?.solid) hit = true;
            }
            if (!hit && bgGrid) {
              const bgPacked = bgGrid[idx];
              if (bgPacked !== 0) {
                const bgMat = bgPacked & 0xff;
                const bgDef = MATERIALS[bgMat];
                if (bgDef?.solid) hit = true;
              }
            }
            if (hit) {
              gs.settled = true;
              gs.vx = 0;
              gs.vy = 0;
            }
          } else {
            // Out of bounds — settle it (it'll resume lighting if the player
            // moves close enough for the grid to cover it again)
            gs.settled = true;
            gs.vx = 0;
            gs.vy = 0;
          }
        }
      }
      surviving.push(gs);
    }
    this.glowsticks = surviving;
  }

  /** Pick an enemy type appropriate for the current depth. */
  private pickEnemyType(depthMeters: number): EnemyType {
    if (depthMeters < 500) return "cave-bat";
    if (depthMeters < 1500) return "rock-golem";
    return "lava-imp";
  }

  /** Try to spawn an enemy in a dark cave near the player. */
  private trySpawnEnemy(): void {
    if (this.enemies.length >= MAX_ENEMIES) return;
    if (!this.workerHost || !this.gridReader) return;

    const px = this.workerHost.getPlayerF32(PLAYER.PX);
    const py = this.workerHost.getPlayerF32(PLAYER.PY);
    const surfaceY = this.signpostY; // approximate surface
    const depthMeters = Math.max(0, Math.floor(py - surfaceY));
    if (depthMeters < ENEMY_SPAWN_DEPTH) return;

    const grid = this.gridReader.getGrid();
    const originX = this.gridReader.getStat(STATS.ORIGIN_X);
    const originY = this.gridReader.getStat(STATS.ORIGIN_Y);

    // Try to find a dark air cell within 15-40 cells of the player
    for (let attempt = 0; attempt < 20; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 15 + Math.random() * 25;
      const wx = Math.floor(px + Math.cos(angle) * dist);
      const wy = Math.floor(py + Math.sin(angle) * dist);
      const ax = wx - originX;
      const ay = wy - originY;
      if (ax < 1 || ax >= ACTIVE_GRID_W - 1 || ay < 1 || ay >= ACTIVE_GRID_H - 1) continue;
      const idx = ay * ACTIVE_GRID_W + ax;
      if (grid[idx] !== 0) continue; // not air
      // Check it's not too close to another enemy
      let tooClose = false;
      for (const e of this.enemies) {
        if (Math.abs(e.x - wx) < 8 && Math.abs(e.y - wy) < 8) { tooClose = true; break; }
      }
      if (tooClose) continue;

      const type = this.pickEnemyType(depthMeters);
      let stats: { health: number; damage: number; speed: number; color: string; size: number; name: string };
      if (type === "cave-bat") {
        stats = { health: 15, damage: 0.3, speed: 0.15, color: "#6b4a2a", size: 8, name: "Cave Bat" };
      } else if (type === "rock-golem") {
        stats = { health: 40, damage: 0.8, speed: 0.08, color: "#8a7a6a", size: 12, name: "Rock Golem" };
      } else {
        stats = { health: 25, damage: 1.2, speed: 0.12, color: "#ff5722", size: 10, name: "Lava Imp" };
      }
      this.enemies.push({
        x: wx, y: wy, vx: 0, vy: 0,
        health: stats.health, maxHealth: stats.health,
        type, damagePerTick: stats.damage, speed: stats.speed,
        color: stats.color, size: stats.size, name: stats.name,
        contactCooldown: 0,
      });
      return; // spawned one, done
    }
  }

  /** Update all enemies: spawn, chase player, contact damage, bomb death. */
  private updateEnemies(): void {
    if (!this.workerHost) return;
    const px = this.workerHost.getPlayerF32(PLAYER.PX);
    const py = this.workerHost.getPlayerF32(PLAYER.PY);
    const grid = this.gridReader?.getGrid();
    const originX = this.gridReader?.getStat(STATS.ORIGIN_X) ?? 0;
    const originY = this.gridReader?.getStat(STATS.ORIGIN_Y) ?? 0;

    // Spawn timer
    this.enemySpawnTimer++;
    if (this.enemySpawnTimer >= ENEMY_SPAWN_INTERVAL) {
      this.enemySpawnTimer = 0;
      this.trySpawnEnemy();
    }

    if (this.enemies.length === 0) return;

    const surviving: Enemy[] = [];
    for (const enemy of this.enemies) {
      // Check bomb proximity — enemies die in explosions
      let killedByBomb = false;
      for (const exp of this.explosions) {
        const dist = Math.sqrt((enemy.x - exp.x) ** 2 + (enemy.y - exp.y) ** 2);
        if (dist < BOMB_RADIUS + 2) {
          killedByBomb = true;
          break;
        }
      }
      if (killedByBomb) continue;

      // Chase the player — simple direct movement through air cells
      const dx = px - enemy.x;
      const dy = py - enemy.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 0.1) {
        // Apply velocity toward player
        enemy.vx = (dx / dist) * enemy.speed;
        enemy.vy = (dy / dist) * enemy.speed;
      }

      // Gravity for ground enemies (rock-golem), bats/imps float
      if (enemy.type === "rock-golem") {
        enemy.vy += 0.02;
      }

      // Move with collision check against terrain
      const newX = enemy.x + enemy.vx;
      const newY = enemy.y + enemy.vy;
      const ax = Math.floor(newX - originX);
      const ay = Math.floor(newY - originY);
      let blocked = false;
      if (ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H && grid) {
        const packed = grid[ay * ACTIVE_GRID_W + ax];
        if (packed !== 0) {
          const mat = packed & 0xff;
          const def = MATERIALS[mat];
          if (def?.solid) blocked = true;
        }
      } else {
        blocked = true; // out of bounds
      }

      if (!blocked) {
        enemy.x = newX;
        enemy.y = newY;
      } else {
        // Try to go around — just move in X or Y only
        const axX = Math.floor(newX - originX);
        const ayX = Math.floor(enemy.y - originY);
        let blockedX = false;
        if (axX >= 0 && axX < ACTIVE_GRID_W && ayX >= 0 && ayX < ACTIVE_GRID_H && grid) {
          const packed = grid[ayX * ACTIVE_GRID_W + axX];
          if (packed !== 0 && MATERIALS[packed & 0xff]?.solid) blockedX = true;
        }
        if (!blockedX) enemy.x = newX;
        const axY = Math.floor(enemy.x - originX);
        const ayY = Math.floor(newY - originY);
        let blockedY = false;
        if (axY >= 0 && axY < ACTIVE_GRID_W && ayY >= 0 && ayY < ACTIVE_GRID_H && grid) {
          const packed = grid[ayY * ACTIVE_GRID_W + axY];
          if (packed !== 0 && MATERIALS[packed & 0xff]?.solid) blockedY = true;
        }
        if (!blockedY) enemy.y = newY;
      }

      // Despawn if too far from player (> 80 cells)
      if (dist > 80) continue;

      // Contact damage
      if (dist < 2.5) {
        if (enemy.contactCooldown <= 0) {
          this.workerHost.damagePlayer(enemy.damagePerTick, 255); // 255 = enemy attack
          enemy.contactCooldown = ENEMY_CONTACT_COOLDOWN;
        }
      }
      if (enemy.contactCooldown > 0) enemy.contactCooldown--;

      surviving.push(enemy);
    }
    this.enemies = surviving;
  }

  /** Get active enemies for rendering (world coords + display info). */
  getEnemies(): { x: number; y: number; color: string; size: number; health: number; maxHealth: number; name: string }[] {
    return this.enemies.map((e) => ({
      x: e.x, y: e.y, color: e.color, size: e.size,
      health: e.health, maxHealth: e.maxHealth, name: e.name,
    }));
  }

  /** Get active bombs for rendering (world coords). */
  getBombs(): { x: number; y: number }[] {
    return this.bombs.map((b) => ({ x: b.x, y: b.y }));
  }

  /** Get active glowsticks for rendering (world coords + color). */
  getGlowsticks(): { x: number; y: number; color: [number, number, number] }[] {
    return this.glowsticks.map((g) => ({ x: g.x, y: g.y, color: g.color }));
  }

  /** Get active explosion flashes for rendering (world coords + progress). */
  getExplosions(): { x: number; y: number; progress: number }[] {
    return this.explosions.map((e) => ({
      x: e.x,
      y: e.y,
      progress: e.age / e.maxAge,
    }));
  }

  /**
   * Buy `qty` of a build material at the signpost shop. Checks + deducts
   * currency (renderer-side) and tells the worker to add the materials (worker
   * is the source of truth for counts; it emits the updated counts back).
   * Returns true on success, false if not enough gold.
   */
  buyBuildMaterial(type: BuildMaterialType, qty: number): boolean {
    const s = useGameStore.getState();
    if (!s.buyBuildMaterial(type, qty)) return false;
    this.workerHost?.addBuildMaterial(type, qty);
    return true;
  }

  /**
   * Purchase one level of an upgrade at the signpost shop. Checks + deducts
   * currency (store-side) and syncs the new upgrade levels to the worker
   * (which uses them for mining damage/radius/rate/inventory calculations).
   * Returns true on success, false if not enough gold or already maxed.
   */
  purchaseUpgrade(config: UpgradeConfig): boolean {
    const s = useGameStore.getState();
    if (!s.purchaseUpgrade(config)) return false;
    this.workerHost?.setUpgrades(useGameStore.getState().upgrades);
    return true;
  }
}
