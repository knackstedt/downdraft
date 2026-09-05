// ============================================================================
// BlockheadsRenderer — main render orchestrator
//
// Manages the WebGPU device, the sim worker host, the block grid render pass,
// the stickman render pass, the camera, and input. Renders the active grid
// + blockhead characters each frame.
// ============================================================================

import { GameRenderer } from "@downdraft/core";
import { getBlockDef } from "../shared/block-registry";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W,
    BLOCK_AIR,
    CHUNK_H, CHUNK_W, TICK_RATE
} from "../shared/constants";
import { CROP_LOOKUP } from "../shared/crops";
import { getItemDef } from "../shared/items";
import type { MapRegionData } from "../shared/map-buffer";
import { RENDER_TICK_SENTINEL } from "../shared/render-buffer";
import { SimBufferReader } from "../shared/sim-buffer";
import { isTreeBlock } from "../shared/tree-species";
import { BlockheadsWorkerHost } from "../simulation/blockheads-worker-host";
import { GridBuilderWorkerHost } from "../simulation/grid-builder-worker-host";
import { BlockGridPass3D } from "./block-grid-pass-3d";
import { Camera } from "./camera";
import { CharacterPass, type CharacterGender } from "./character-pass";
import { CropSpritePass } from "./crop-sprite-pass";
import { DropPass, type DropRenderData } from "./drop-pass";
import {
    createInputHandler, type BlockheadsInputState,
} from "./input-handler";
import { invert, raycastGridSlab, rayToZ0, unprojectScreen } from "./matrix";
import { SkyPass } from "./sky-pass";
import { StickmanPass } from "./stickman-pass";
import { TaskMarkerPass, type MarkerData } from "./task-marker-pass";

// The hotbar is the first 9 slots of the inventory. Each slot maps to a
// placeable block ID (from the item's placeBlock property); empty slots
// map to BLOCK_AIR. Updated from the inventory via setHotbarFromInventory().
const EMPTY_HOTBAR: number[] = new Array(9).fill(BLOCK_AIR);

export class BlockheadsRenderer extends GameRenderer {
  // Cached sim-SAB origin (read atomically with the sim tick). Used ONLY for
  // computing the player's continuous world position from the blockhead's
  // active-grid coords in the sim SAB. The blockhead position in the sim SAB
  // is relative to the sim SAB origin, so this is the correct origin for
  // world-position interpolation.
  private cachedOriginCx = 0;
  private cachedOriginCy = 0;
  // Render-SAB origin (read alongside the render build tick). This is the
  // origin that matches the grid data currently on the GPU. Used for all
  // world→active-grid conversions (camera, shader texture origin, stickman
  // local position, input raycast→world). Using the render origin instead of
  // the sim origin eliminates the chunk-boundary flash: when the sim origin
  // advances (player crossed a boundary) but the grid-builder hasn't
  // published the matching grid data yet, the camera stays at the old
  // active-grid position — matching the old grid data on the GPU — instead
  // of jumping one chunk ahead.
  private renderOriginCx = 0;
  private renderOriginCy = 0;
  private debugNoShadows = false;
  private inputInterval = 0; // separate interval for input processing (works even when render loop is paused)
  // Tracks whether the rAF render loop is active (set by start/stop).
  // Used by the input interval to skip updateInput() when the rAF loop
  // already calls it every frame.
  private _rendering = false;

  // Hotbar: block IDs for the first 9 inventory slots (updated from inventory)
  private hotbarBlocks: number[] = [...EMPTY_HOTBAR];
  // Hotbar: item IDs for the first 9 inventory slots (for useItem / display).
  private hotbarItems: (string | null)[] = new Array(9).fill(null);

  // Render passes
  blockGridPass: BlockGridPass3D | null = null;
  private stickmanPass: StickmanPass | null = null;
  private characterPass: CharacterPass | null = null;
  private characterGender: CharacterGender = "male";
  // Per-blockhead gender (keyed by blockhead id). Falls back to
  // `characterGender` for ids not in the map. The C key toggles the active
  // blockhead's gender here; the worker doesn't track gender (cosmetic only).
  private bhGenders: Map<number, CharacterGender> = new Map();
  // Index of the directly-controlled blockhead (WASD/mouse). Tab cycles this.
  // The renderer writes it to the SAB input region each frame; the worker
  // reads it and routes direct input to this blockhead.
  private activeBhIndex = 0;
  // Cached player position (active-grid coords) + movement state for the
  // character render pass. Set during the update phase, consumed during the
  // render phase.
  private _charLocalX = 0;
  private _charLocalY = 0;
  private _charVx = 0;
  private _charWallClimbing = false;
  // Render list for all blockheads (populated each frame in the update phase,
  // consumed in the render pass). The active blockhead uses the interpolated
  // position; others use their raw SAB position converted to active-grid coords.
  private _charRenderList: {
    localX: number; localY: number; vx: number; wallClimbing: boolean;
    gender: CharacterGender; id: number; isActive: boolean;
  }[] = [];
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

  // --- Player position rendering (velocity advance + error decay) ---
  //
  // The sim runs at 30Hz via setTimeout, which has jitter — sometimes it
  // batches 1 tick per iteration, sometimes 2. This makes alpha-based lerp
  // and hard snapping both fail:
  //   - Alpha lerp: when 2 ticks batch, position delta is 2x but the window
  //     is 1 tick → rendered speed doubles then stalls.
  //   - Hard snap: when 2 ticks batch, the rendered position is 1 tick
  //     behind the sim → the 0.35-block snap is visible (33px at 96 zoom).
  //
  // Solution: advance at the sim's velocity (constant, confirmed by
  // diagnostics) and exponentially decay the position error toward zero.
  // The error is computed at each tick arrival (simPos - renderPos) and
  // decays by 15% per frame, converging in ~10 frames (167ms at 60Hz).
  // The max per-frame correction is 0.35 * 0.15 = 0.05 blocks (5px) —
  // invisible. At steady state (tickDelta=1), the error is ~0, so there's
  // no correction and no speed variation.
  //
  // Everything is tracked in WORLD coords (active-grid pos + origin *
  // CHUNK_W) so chunk-boundary crossings don't cause jumps.
  private lastTick = -1;
  // Raw sim velocity (blocks/tick) from the SAB.
  private simVelX = 0;
  private simVelY = 0;
  // Rendered world position (advanced by velocity, corrected by error decay).
  // Used by camera + character rendering + map centering.
  private interpWorldX = 0;
  private interpWorldY = 0;
  // Position error (simPos - renderPos) at last tick arrival, decaying.
  private posErrorX = 0;
  private posErrorY = 0;
  // --- Diagnostics ---
  private tickDelta = 1;
  private tickArrivalTimes: number[] = [];

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
  // Frame profiling: accumulate frame times and log every 5s.
  private frameTimes: number[] = [];
  private frameProfilerTimer = 0;
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

  // --- Map mode (zoomed-out overview) ---
  // Cached map region snapshot (downsampled explored chunks + stations).
  // Refreshed periodically from the worker via getMapRegion(). The map
  // overlay (components/map-overview.tsx) reads this via getMapRegionData().
  private mapRegion: MapRegionData | null = null;
  private mapRegionDirty = false;
  private mapRegionTimer = 0; // setInterval handle
  private mapRegionFetching = false;
  // Last game-canvas opacity we wrote (avoids per-frame style writes).
  private lastCanvasOpacity = 1;
  // Stashed zoom level for the M-key map toggle (restored on toggle-back / Esc).
  private stashedZoom = 0;
  private inMapToggleMode = false;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas, {
      mode: "2d",
      clearColor: { r: 0.1, g: 0.1, b: 0.18, a: 1.0 },
    });
    // 2D mode with viewportCount=0: we do custom rendering in afterFrame
    this.setViewportCount(0);
    this.camera = new Camera(canvas.width, canvas.height);
    // Ensure the game canvas is at full opacity — the map overlay (on the
    // pixi-ui canvas above) covers it with an opaque background, so the 3D
    // canvas never needs to fade. Reset here in case a hot-reload left it
    // at a non-1 value from a previous version of the crossfade code.
    canvas.style.opacity = "1";
  }

  getFPS(): number {
    return super.getFPS();
  }

  getCanvas(): HTMLCanvasElement {
    return super.getCanvas();
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
   * Update the hotbar from the inventory slot-array snapshot.
   * The hotbar is the first 9 slots of the inventory. Each slot's block ID
   * is resolved from the item's placeBlock property; empty slots → BLOCK_AIR.
   */
  setHotbarFromInventory(inventory: ({ itemId: string; count: number } | null)[]): void {
    const slots: number[] = new Array(9).fill(BLOCK_AIR);
    const items: (string | null)[] = new Array(9).fill(null);
    for (let i = 0; i < 9; i++) {
      const s = inventory[i];
      if (s && s.count > 0) {
        items[i] = s.itemId;
        const def = getItemDef(s.itemId);
        if (def && def.placeBlock > 0) slots[i] = def.placeBlock;
      }
    }
    this.hotbarBlocks = slots;
    this.hotbarItems = items;
  }

  /** Get the current hotbar block IDs (for UI display). */
  getHotbarBlocks(): number[] {
    return this.hotbarBlocks;
  }

  /** Get the current hotbar item IDs (for useItem / UI). */
  getHotbarItems(): (string | null)[] {
    return this.hotbarItems;
  }

  /**
   * Use the active hotbar item (G key). Currently only the spawn egg has a
   * use action; other items are no-ops. Delegates to the worker's useItem RPC.
   */
  useActiveHotbarItem(): void {
    const slot = this.input?.selectedSlot ?? 0;
    const itemId = this.hotbarItems[slot];
    if (!itemId) return;
    const host = this.workerHost;
    if (!host) return;
    host.useItem(itemId, this.activeBhIndex).then((result) => {
      if (!result.ok) {
        console.warn(`[Overburden] useItem(${itemId}) failed: ${result.error ?? "unknown"}`);
      }
    }).catch(() => { /* worker not ready — ignore */ });
  }

  /** Expose camera for debug overlays (chunk grid, etc.). */
  getCamera(): Camera {
    return this.camera;
  }

  /** Switch the active character model gender (male/female). */
  setCharacterGender(gender: CharacterGender): void {
    this.characterGender = gender;
    const id = this.getActiveBhId();
    if (id >= 0) this.bhGenders.set(id, gender);
    // setGender on the pass is now per-render-call; no global set needed.
  }

  /** Get the active character gender. */
  getCharacterGender(): CharacterGender {
    const id = this.getActiveBhId();
    if (id >= 0 && this.bhGenders.has(id)) return this.bhGenders.get(id)!;
    return this.characterGender;
  }

  /** Get the gender for a specific blockhead id (falls back to default). */
  getBhGender(id: number): CharacterGender {
    return this.bhGenders.get(id) ?? this.characterGender;
  }

  /** Toggle the active character's gender. */
  toggleCharacterGender(): CharacterGender {
    const cur = this.getCharacterGender();
    const next: CharacterGender = cur === "male" ? "female" : "male";
    this.setCharacterGender(next);
    return next;
  }

  /** Get the active blockhead index. */
  getActiveBhIndex(): number {
    return this.activeBhIndex;
  }

  /** Set the active blockhead index (clamped to alive blockheads). */
  setActiveBhIndex(i: number): void {
    const count = this.simReader?.getBlockheadCount() ?? 0;
    this.activeBhIndex = Math.max(0, Math.min(i, Math.max(0, count - 1)));
  }

  /** Cycle the active blockhead index forward (Tab) or backward (Shift+Tab). */
  cycleActiveBh(reverse: boolean = false): number {
    const count = this.simReader?.getBlockheadCount() ?? 0;
    if (count <= 1) { this.activeBhIndex = 0; return 0; }
    if (reverse) {
      this.activeBhIndex = (this.activeBhIndex - 1 + count) % count;
    } else {
      this.activeBhIndex = (this.activeBhIndex + 1) % count;
    }
    return this.activeBhIndex;
  }

  /** Get the active blockhead's id (from the SAB), or -1 if none. */
  private getActiveBhId(): number {
    if (!this.simReader) return -1;
    const count = this.simReader.getBlockheadCount();
    if (this.activeBhIndex >= count) return -1;
    const bh = this.simReader.getBlockhead(this.activeBhIndex);
    return bh[14]; // id is at offset 14
  }

  /** Active grid origin + size in active-grid coords (for debug overlay). */
  getActiveGridOrigin(): { x: number; y: number; w: number; h: number } {
    return { x: 0, y: 0, w: ACTIVE_GRID_W, h: ACTIVE_GRID_H };
  }

  /** Render origin chunk coords (for world↔active-grid conversion in overlays). */
  getRenderOrigin(): { cx: number; cy: number } {
    return { cx: this.renderOriginCx, cy: this.renderOriginCy };
  }

  /** Interpolated player world position (for the map overlay marker). */
  getPlayerWorld(): { x: number; y: number } {
    return { x: this.interpWorldX, y: this.interpWorldY };
  }

  /** Camera center in world block coords (for the 2D map overlay alignment). */
  getCamWorld(): { x: number; y: number } {
    return { x: this.camWorldX, y: this.camWorldY };
  }

  /**
   * Diagnostics for debugging player movement speed issues.
   *
   * Key values to watch:
   * - `simTickRate`: observed sim ticks/sec. Should be ~30.
   * - `simVelX/Y`: raw sim velocity (blocks/tick) from the SAB. Should be
   *   ~±0.35 at max walk speed.
   * - `simSpeed`: |simVel| in blocks/tick.
   * - `tickDelta`: how many sim ticks were in the last observed batch.
   *   Should be 1. If 2+, the sim is batching (setTimeout jitter).
   * - `renderSpeed`: current rendered speed in blocks/second
   *   (= simSpeed * TICK_RATE). Should be ~10.5 at max walk.
   */
  getInterpDiagnostics(): {
    simTickRate: number;
    simVelX: number;
    simVelY: number;
    simSpeed: number;
    renderSpeed: number;
    tickDelta: number;
    interpWorldX: number;
    interpWorldY: number;
    lastTick: number;
  } {
    let simTickRate = 0;
    if (this.tickArrivalTimes.length >= 2) {
      const span = this.tickArrivalTimes[this.tickArrivalTimes.length - 1] - this.tickArrivalTimes[0];
      simTickRate = ((this.tickArrivalTimes.length - 1) / span) * 1000;
    }
    const simSpeed = Math.sqrt(this.simVelX * this.simVelX + this.simVelY * this.simVelY);
    return {
      simTickRate,
      simVelX: this.simVelX,
      simVelY: this.simVelY,
      simSpeed,
      renderSpeed: simSpeed * TICK_RATE,
      tickDelta: this.tickDelta,
      interpWorldX: this.interpWorldX,
      interpWorldY: this.interpWorldY,
      lastTick: this.lastTick,
    };
  }

  /** Player facing direction (1 = right, -1 = left) for the map marker. */
  getPlayerFacing(): number {
    if (!this.simReader) return 1;
    return this.simReader.blockheads[4] > 0 ? 1 : -1;
  }

  /**
   * Task markers in WORLD coords (converted from the active-grid coords
   * stored in _taskMarkers using the render origin). The map overlay draws
   * these so task targets remain visible when zoomed out.
   */
  getTaskMarkersWorld(): { wx: number; wy: number; action: "mine" | "move" }[] {
    const ox = this.renderOriginCx * CHUNK_W;
    const oy = this.renderOriginCy * CHUNK_H;
    return this._taskMarkers.map((m) => ({
      wx: m.gridX + ox,
      wy: m.gridY + oy,
      action: m.action,
    }));
  }

  /** Map-mode opacity in [0,1] (delegates to camera.getMapOpacity()). */
  getMapOpacity(): number {
    return this.camera.getMapOpacity();
  }

  /**
   * Current sky color (horizon/bottom) based on daylight level.
   * Returns [r, g, b] in 0-255 for the 2D map background.
   */
  getSkyColor(): [number, number, number] {
    const daylight = this.simReader ? this.simReader.getDaylight() : 15;
    const t = daylight / 15;
    const dayBottom = [0.6, 0.8, 1.0];
    const nightBottom = [0.05, 0.05, 0.12];
    const duskBottom = [0.8, 0.4, 0.2];
    let r: number, g: number, b: number;
    if (t < 0.3) {
      const s = t / 0.3;
      r = nightBottom[0] + (duskBottom[0] - nightBottom[0]) * s;
      g = nightBottom[1] + (duskBottom[1] - nightBottom[1]) * s;
      b = nightBottom[2] + (duskBottom[2] - nightBottom[2]) * s;
    } else if (t < 0.6) {
      const s = (t - 0.3) / 0.3;
      r = duskBottom[0] + (dayBottom[0] - duskBottom[0]) * s;
      g = duskBottom[1] + (dayBottom[1] - duskBottom[1]) * s;
      b = duskBottom[2] + (dayBottom[2] - duskBottom[2]) * s;
    } else {
      r = dayBottom[0]; g = dayBottom[1]; b = dayBottom[2];
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  /** Cached map region snapshot (null if not yet fetched). */
  getMapRegionData(): MapRegionData | null {
    return this.mapRegion;
  }

  /** True when the map region has been updated since the last read. */
  isMapRegionDirty(): boolean {
    return this.mapRegionDirty;
  }

  /** Clear the dirty flag (call after consuming the region data). */
  clearMapRegionDirty(): void {
    this.mapRegionDirty = false;
  }

  /**
   * Kick off an async map-region fetch from the worker. No-op if a fetch is
   * already in flight or the worker isn't ready. The result is cached in
   * this.mapRegion and the dirty flag is set.
   */
  refreshMapRegion(): void {
    if (this.mapRegionFetching || !this.workerHost) return;
    this.mapRegionFetching = true;
    const centerCx = Math.floor(this.interpWorldX / CHUNK_W);
    this.workerHost.getMapRegion(centerCx)
      .then((region) => {
        if (region) {
          this.mapRegion = region;
          this.mapRegionDirty = true;
        }
      })
      .catch((e) => {
        console.warn("[Renderer] getMapRegion failed:", e);
      })
      .finally(() => {
        this.mapRegionFetching = false;
      });
  }

  /**
   * M-key handler: snap between full map view and the previous zoom level.
   * When entering map mode, stash the current zoom and set it to MIN_ZOOM
   * (full region), recenter on the player, and detach the camera so it
   * doesn't snap back. When leaving, restore the stashed zoom + reattach.
   */
  toggleMapMode(): void {
    if (this.inMapToggleMode) {
      this.exitMapMode();
      return;
    }
    // Enter map mode.
    this.stashedZoom = this.camera.zoom;
    this.inMapToggleMode = true;
    // Recenter on the player in world coords, then convert to active-grid.
    this.camWorldX = this.interpWorldX + 0.5;
    this.camWorldY = this.interpWorldY + 0.975;
    this.camWorldInit = true;
    this.camera.x = this.camWorldX - this.renderOriginCx * CHUNK_W;
    this.camera.y = this.camWorldY - this.renderOriginCy * CHUNK_H;
    this.camera.detached = true;
    this.camera.zoom = Camera.MIN_ZOOM;
    // Force an immediate region refresh so the map shows current data.
    this.refreshMapRegion();
  }

  /**
   * Esc handler: exit map mode if active (restore stashed zoom + reattach
   * camera to the player). No-op if not in map-toggle mode, so Esc still
   * works as the pause hotkey in normal play.
   */
  exitMapMode(): void {
    if (!this.inMapToggleMode) return;
    this.camera.zoom = this.stashedZoom || 96;
    this.camera.reattach(
      this.interpWorldX - this.renderOriginCx * CHUNK_W,
      this.interpWorldY - this.renderOriginCy * CHUNK_H,
    );
    this.inMapToggleMode = false;
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
    const ok = await super.init();
    if (!ok) return false;

    const device = this.getDevice()!;
    const format = this.getFormat();
    const canvas = this.getCanvas();

    // Camera uses CSS pixel dimensions (not device pixels) so zoom=96
    // means 96 CSS pixels per block regardless of devicePixelRatio.
    const dpr = this.dpr || window.devicePixelRatio || 1;
    this.camera.resize(canvas.width / dpr, canvas.height / dpr);

    // Create render passes (3D block grid with depth buffer)
    this.blockGridPass = new BlockGridPass3D(device, format);
    this.blockGridPass.init();

    this.stickmanPass = new StickmanPass(device, format);
    this.stickmanPass.init();

    // Initialize the character pass (rigged FBX models via ModelRenderer).
    // Non-blocking: if this fails, we fall back to the stickman box.
    this.characterPass = new CharacterPass();
    try {
      await this.characterPass.init(device, format);
      await this.characterPass.loadGender("male");
      await this.characterPass.loadGender("female");
      this.characterPass.setGender("male");
    } catch (e) {
      console.warn("[Renderer] CharacterPass init failed, falling back to stickman box:", e);
      this.characterPass?.destroy();
      this.characterPass = null;
    }

    this.skyPass = new SkyPass(device, format);
    this.skyPass.init();

    this.taskMarkerPass = new TaskMarkerPass(device, format);
    this.taskMarkerPass.init();

    this.dropPass = new DropPass(device, format);
    this.dropPass.init();
    // Async-load the fruit spritesheet (non-blocking; falls back to solid
    // colors until the texture is ready).
    this.dropPass.loadFruitTexture();

    this.cropSpritePass = new CropSpritePass(device, format);
    this.cropSpritePass.init();

    // Share the block grid's volumetric light + fog-of-war textures so crop
    // sprites (bushes, mushrooms, crops) and world drops are lit by the same
    // per-cell light field as the surrounding blocks — day/night darkening,
    // torch glow, and unexplored-cell black-out.
    const lightView = this.blockGridPass.getLightView();
    const exploredView = this.blockGridPass.getExploredView();
    if (lightView && exploredView) {
      this.cropSpritePass.setLightTextures(lightView, exploredView);
      this.dropPass.setLightTextures(lightView, exploredView);
    }

    // Start the sim worker
    this.workerHost = new BlockheadsWorkerHost();
    this.simReader = new SimBufferReader(this.workerHost.getSimBuffer() as ArrayBufferLike);
    await this.workerHost.start();
    this.simReady = this.workerHost.isReady();

    // Start the grid-builder worker — offloads instance data + texture
    // padding from the render thread. It reads the sim SAB and writes
    // pre-built data to the render SAB.
    this.gridBuilderHost = new GridBuilderWorkerHost();
    await this.gridBuilderHost.startWithSimSab(this.workerHost.getSimBuffer());

    // Set initial camera to center of active grid, at surface level.
    // The active grid is centered at SURFACE_Y in world coords, so the surface
    // is at active grid Y = ACTIVE_GRID_H/2 = 224.
    this.camera.setCenter(ACTIVE_GRID_W / 2, ACTIVE_GRID_H / 2);

    // Set up input handlers
    this.input = createInputHandler(canvas);
    // Wire the C-key gender toggle to the character pass + game store
    this.input.onToggleGender = () => {
      const gender = this.toggleCharacterGender();
      console.log(`[Overburden] Character gender: ${gender}`);
    };
    // Wire M-key map toggle: snap to full map (min zoom) or restore.
    this.input.onToggleMap = () => this.toggleMapMode();
    // Wire Esc: exit map mode if active (no-op otherwise).
    this.input.onExitMap = () => this.exitMapMode();
    // Wire Tab: cycle the active blockhead (which one receives WASD/mouse).
    this.input.onCycleActiveBh = (reverse: boolean) => {
      const idx = this.cycleActiveBh(reverse);
      console.log(`[Overburden] Active blockhead: index ${idx}`);
    };
    // Wire G: use the active hotbar item (e.g. spawn egg).
    this.input.onUseItem = () => this.useActiveHotbarItem();

    // Map-region poll: refresh the cached map snapshot every 2s so the
    // zoomed-out overview stays current as the player explores. The fetch
    // is async and no-op if the worker isn't ready; the overlay reads the
    // cache via getMapRegionData().
    this.mapRegionTimer = setInterval(() => this.refreshMapRegion(), 2000) as unknown as number;

    // Wire the afterFrame callback for custom 2D rendering
    this.setCallbacks({
      afterFrame: (dt: number) => this.drawFrame(dt),
      onResize: () => this.handleResize(),
    });

    return true;
  }

  private handleResize(): void {
    const canvas = this.getCanvas();
    const dpr = this.dpr || window.devicePixelRatio || 1;
    this.camera.resize(canvas.width / dpr, canvas.height / dpr);
  }

  start(): void {
    this._rendering = true;
    super.start();
    // Start a separate input processing interval so input keeps flowing
    // to the sim worker even when the render loop is paused (deterministic mode).
    // The worker runs its own loop and needs fresh input every frame.
    // In normal mode, the rAF loop already calls updateInput() every frame,
    // so the interval skips to avoid double raycasts (matrix invert + DDA).
    if (!this.inputInterval) {
      this.inputInterval = setInterval(() => {
        if (this._rendering) return; // rAF loop handles it
        this.updateInput();
      }, 16) as unknown as number;
    }
  }

  stop(): void {
    this._rendering = false;
    super.stop();
    // NOTE: do NOT clear the input interval here — the sim worker still needs
    // input even when rendering is paused (deterministic mode).
  }

  renderOneFrame(): void {
    if (this._rendering) return;
    const device = this.getDevice();
    const context = this.getContext();
    if (!device || !context || !this.blockGridPass) return;
    // Render a single frame on demand (deterministic mode). We call
    // drawFrame() directly with a zero dt — the sim state is already
    // advanced by the worker; we just need to render the current state.
    this.drawFrame(0);
  }

  async captureScreenshot(): Promise<Blob | null> {
    if (!this._rendering) {
      this.renderOneFrame();
    }
    const canvas = this.getCanvas();
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  async shutdown(): Promise<void> {
    super.stop();
    this._rendering = false;
    if (this.inputInterval) clearInterval(this.inputInterval);
    this.inputInterval = 0;
    if (this.mapRegionTimer) clearInterval(this.mapRegionTimer);
    this.mapRegionTimer = 0;
    this.stickmanPass?.destroy();
    this.characterPass?.destroy();
    this.characterPass = null;
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
    this.destroy();
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
    this.hotbarBlocks = [...EMPTY_HOTBAR];
    this.hotbarItems = new Array(9).fill(null);
    // Clear drops display (worker already cleared the drop array)
    this.cachedDropData = [];
    this.lastDropTick = RENDER_TICK_SENTINEL;
    if (this.dropPass && this.blockGridPass) {
      this.dropPass.updateInstances([]);
      this.dropPass.updateCamera(this.blockGridPass.getViewProj(), this.camera.canvasW, this.camera.canvasH);
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
    this.renderOriginCx = 0;
    this.renderOriginCy = 0;
    this.camWorldInit = false;
    this.lastTick = -1;
    this.tickDelta = 1;
    this.simVelX = 0;
    this.simVelY = 0;
    this.interpWorldX = 0;
    this.interpWorldY = 0;
    this.posErrorX = 0;
    this.posErrorY = 0;
    this.tickArrivalTimes.length = 0;
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
   * Check if a click position (active-grid float coords) hits a world drop.
   * Drops are rendered as ~0.6-block quads centered at their position, so
   * we use a 0.5-block radius hit test. Returns the drop's position if hit,
   * or null if no drop is near the click.
   */
  private hitTestDrops(clickX: number, clickY: number): { x: number; y: number } | null {
    const radius = 0.5;
    const r2 = radius * radius;
    for (const d of this.cachedDropData) {
      const dx = d.x - clickX;
      const dy = d.y - clickY;
      if (dx * dx + dy * dy < r2) {
        return { x: d.x, y: d.y };
      }
    }
    return null;
  }

  /**
   * Check if a cell (active-grid int coords) is adjacent to any solid block
   * in the foreground or background layer. "Adjacent" means any of the 4
   * orthogonal neighbors (N, S, E, W) has a non-air block. This is used to
   * determine if an empty cell is potentially reachable (has ground or a
   * wall nearby to stand on / climb).
   */
  private isAdjacentToSolid(
    ax: number, ay: number,
    fg: Uint16Array, bg: Uint16Array,
  ): boolean {
    const W = ACTIVE_GRID_W;
    const H = ACTIVE_GRID_H;
    const neighbors = [
      [ax, ay - 1], // N
      [ax, ay + 1], // S
      [ax - 1, ay], // W
      [ax + 1, ay], // E
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const idx = ny * W + nx;
      if ((fg[idx] & 0xFF) !== BLOCK_AIR) return true;
      if ((bg[idx] & 0xFF) !== BLOCK_AIR) return true;
    }
    return false;
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

    // Handle zoom — dynamic zoom with scroll wheel. Multiple wheel events can
    // fire between frames (free-spin wheels, trackpads), so zoomDelta
    // accumulates per event. Apply the full magnitude in one zoomAt call
    // (1.2^N) rather than just the sign — otherwise fast scrolling discards
    // all but one tick per frame and zoom feels laggy/unresponsive.
    if (this.input.zoomDelta !== 0) {
      const steps = this.input.zoomDelta;
      const factor = steps > 0 ? Math.pow(1.2, steps) : 1 / Math.pow(1.2, -steps);
      this.camera.zoomAt(this.input.mouseX, this.input.mouseY, factor);
      this.input.zoomDelta = 0;
    }

    // Handle camera panning (middle-mouse drag).
    // Panning detaches the camera from the player. The camera stays
    // detached after releasing the mouse until the user re-attaches it.
    // Uses the render origin (matches the grid data on the GPU) for
    // world↔active-grid conversion so panning stays consistent with
    // what the user sees.
    if (this.input.panning) {
      if (!this.camera.isPanning()) {
        this.camera.startPan(this.input.panStartX, this.input.panStartY);
        this.camera.detached = true;
      }
      this.camera.updatePan(this.input.mouseX, this.input.mouseY);
      // Sync world position from active-grid position after pan update
      this.camWorldX = this.camera.x + this.renderOriginCx * CHUNK_W;
      this.camWorldY = this.camera.y + this.renderOriginCy * CHUNK_H;
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
        this.camera.x = this.camWorldX - this.renderOriginCx * CHUNK_W;
        this.camera.y = this.camWorldY - this.renderOriginCy * CHUNK_H;
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
      const worldX = ax + this.renderOriginCx * CHUNK_W;
      const worldY = ay + this.renderOriginCy * CHUNK_H;
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
      const ax = Math.floor(clickGrid.x);
      const ay = Math.floor(clickGrid.y);
      const worldX = ax + this.renderOriginCx * 64;
      const worldY = ay + this.renderOriginCy * 64;
      const isRightClick = this.input.taskClickButton === 2;

      const host = this.workerHost;
      if (host) {
        // Use a labeled block so we can skip the cell-based task queueing
        // when a drop was clicked (or when the cell is unreachable).
        taskClick: {
          // 1) Drop hit check (left-click only): if the click is near a world
          //    drop, queue COLLECT_ITEM at the drop's world coords. The auto-
          //    pickup logic in the worker handles the actual collection when the
          //    blockhead gets close enough.
          if (!isRightClick) {
            const dropHit = this.hitTestDrops(clickGrid.x, clickGrid.y);
            if (dropHit) {
              const dx = Math.floor(dropHit.x + this.renderOriginCx * 64);
              const dy = Math.floor(dropHit.y + this.renderOriginCy * 64);
              host.queueTask("COLLECT_ITEM", { targetX: dx, targetY: dy }, this.activeBhIndex).then((r) => {
                if (r.duplicate) host.cancelTask("COLLECT_ITEM", dx, dy, this.activeBhIndex);
              });
              break taskClick;
            }
          }

          // 2) Determine task type for the clicked cell.
          //    Right-click → MOVE_TO (always).
          //    Left-click → MINE_BLOCK if the cell has a block, else MOVE_TO if
          //    the empty cell is adjacent to solid (fg or bg), else ignore.
          let taskType: "MINE_BLOCK" | "MOVE_TO";
          if (isRightClick) {
            taskType = "MOVE_TO";
          } else {
            const fg = this.simReader!.foreground;
            const bg = this.simReader!.background;
            const cellIdx = ay * ACTIVE_GRID_W + ax;
            const inBounds = ax >= 0 && ax < ACTIVE_GRID_W && ay >= 0 && ay < ACTIVE_GRID_H;
            const fgId = inBounds ? (fg[cellIdx] & 0xFF) : BLOCK_AIR;
            const bgId = inBounds ? (bg[cellIdx] & 0xFF) : BLOCK_AIR;
            if (fgId !== BLOCK_AIR || bgId !== BLOCK_AIR) {
              taskType = "MINE_BLOCK";
            } else if (inBounds && this.isAdjacentToSolid(ax, ay, fg, bg)) {
              taskType = "MOVE_TO";
            } else {
              // Empty cell not adjacent to solid — can't navigate there
              break taskClick;
            }
          }

          // Toggle: if a task already exists at this position, cancel it.
          // Otherwise, queue a new one. The marker sync interval (in app.tsx)
          // will pick up the change from getTasks().
          host.queueTask(taskType, { targetX: worldX, targetY: worldY }, this.activeBhIndex).then((result) => {
            if (result.duplicate) {
              host.cancelTask(taskType, worldX, worldY, this.activeBhIndex);
            }
          });
        }
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
      inpF[15] = this.camera.zoom;
      inpF[16] = this.camera.canvasW;
      inpF[17] = this.camera.canvasH;
      inpF[18] = this.camWorldX;
      inpF[19] = this.camWorldY;
      inp[20] = this.activeBhIndex;
      return;
    }

    // Write input to SAB
    const inp = this.simReader.inputInt32;
    const inpF = this.simReader.inputF32;
    // Convert active grid coords to world coords for the worker.
    // Uses the render origin (matches the grid data the user sees) so
    // mining/placing targets the cell the user clicked on, even during
    // the brief window where the sim origin has advanced but the
    // grid-builder hasn't published the matching grid data yet.
    const worldX = grid.x + this.renderOriginCx * 64;
    const worldY = grid.y + this.renderOriginCy * 64;
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
    // Camera zoom + canvas size (for grid-builder view culling)
    inpF[15] = this.camera.zoom;
    inpF[16] = this.camera.canvasW;
    inpF[17] = this.camera.canvasH;
    // Camera world position (origin-independent) for grid-builder culling.
    // The grid-builder converts this to sim-origin active-grid coords using
    // the sim SAB origin, avoiding the render-origin/sim-origin mismatch
    // that caused terrain flashing during chunk-boundary crossings.
    inpF[18] = this.camWorldX;
    inpF[19] = this.camWorldY;
    inp[20] = this.activeBhIndex;
  }

  private drawFrame(dt: number): void {
    const device = this.getDevice();
    const context = this.getContext();
    const canvas = this.getCanvas();
    if (!device || !context || !this.blockGridPass) return;

    const frameStart = performance.now();

    // --- Map-mode cross-fade ---
    // Advance the animated map opacity toward its target (0 = pure 3D,
    // 1 = pure 2D map). The target flips when zoom crosses MAP_FADE_THRESHOLD;
    // the actual opacity tweens over MAP_FADE_DURATION seconds so the
    // crossfade plays as a smooth animation, not a static blend at rest.
    //
    // The 3D canvas stays at opacity 1 — the map overlay (on the pixi-ui
    // canvas at z-index 50) has an opaque full-screen background and fades
    // in as a unit, covering the 3D scene. This avoids the compositing gap
    // that occurs when both layers are semi-transparent on separate canvases
    // (which would show the page background through the crossfade).
    this.camera.update(dt);

    // --- Render SAB: check for new grid-builder build + cache render origin ---
    // This MUST happen before processCameraInput() and camera positioning so
    // that renderOriginCx/Cy (the origin matching the grid data on the GPU) is
    // available for all world→active-grid conversions this frame. The grid
    // data upload (writeTexture/writeBuffer) is also queued here — it just
    // copies into the GPU command queue, so doing it early is fine.
    //
    // Using the render origin (not the sim SAB origin) for camera/shader/
    // stickman/input positioning eliminates the chunk-boundary flash: when
    // the sim origin advances (player crossed a boundary) but the
    // grid-builder hasn't published the matching grid data yet, the camera
    // stays at the old active-grid position — matching the old grid data on
    // the GPU — instead of jumping one chunk ahead.
    if (this.gridBuilderHost) {
      const renderReader = this.gridBuilderHost.getReader();
      const buildTick = renderReader.getBuildTick();
      if (buildTick !== this.lastBuildTick) {
        this.lastBuildTick = buildTick;
        // Cache the render origin (matches the grid data in this build).
        // Safe to read after getBuildTick() returned an advanced tick — the
        // atomic tick load (acquire) orders these reads after the writer's
        // release store.
        this.renderOriginCx = renderReader.getOriginCx();
        this.renderOriginCy = renderReader.getOriginCy();
        this.blockGridPass.updateGridFromBuffer(renderReader);
        this.blockGridPass.updateLightFromBuffer(renderReader);
        this.blockGridPass.updateExploredFromBuffer(renderReader);
      }
    }

    // Process camera-related input (zoom, pan, detached WASD) early so the
    // camera position + viewProj matrix reflect the current frame's input
    // when the raycast runs later.
    this.processCameraInput();

    // --- Player position: advance at sim velocity + decay position error ---
    // See the field-level docs above. This approach is immune to sim tick
    // batching because the advancement rate is driven by the sim velocity
    // (constant) × render dt, not by the position delta between ticks.
    // The error decay smoothly corrects drift without visible snapping.
    if (this.simReader) {
      const tick = this.simReader.getTick();
      if (tick !== this.lastTick) {
        this.cachedOriginCx = this.simReader.getOriginCx();
        this.cachedOriginCy = this.simReader.getOriginCy();
        this.tickDelta = this.lastTick < 0 ? 1 : Math.max(1, tick - this.lastTick);
        this.lastTick = tick;
        this.tickArrivalTimes.push(performance.now());
        if (this.tickArrivalTimes.length > 60) this.tickArrivalTimes.shift();

        const bhCount = this.simReader.getBlockheadCount();
        if (this.activeBhIndex >= bhCount) this.activeBhIndex = Math.max(0, bhCount - 1);
        if (bhCount > 0) {
          const bh = this.simReader.getBlockhead(this.activeBhIndex);
          const worldX = bh[0] + this.cachedOriginCx * CHUNK_W;
          const worldY = bh[1] + this.cachedOriginCy * CHUNK_H;
          this.simVelX = bh[2];
          this.simVelY = bh[3];
          if (this.lastTick > 0) {
            // Compute position error (simPos - renderPos).
            // Teleport detection: if error is huge, snap directly.
            const errX = worldX - this.interpWorldX;
            const errY = worldY - this.interpWorldY;
            if (errX * errX + errY * errY > 256) { // >16 blocks
              this.interpWorldX = worldX;
              this.interpWorldY = worldY;
              this.posErrorX = 0;
              this.posErrorY = 0;
            } else {
              this.posErrorX = errX;
              this.posErrorY = errY;
            }
          } else {
            // First tick: initialize to sim position.
            this.interpWorldX = worldX;
            this.interpWorldY = worldY;
            this.posErrorX = 0;
            this.posErrorY = 0;
          }
        }
      }

      // Advance at sim velocity (constant speed, immune to tick batching).
      // simVelX is blocks/tick; dt * TICK_RATE converts to blocks/frame.
      this.interpWorldX += this.simVelX * dt * TICK_RATE;
      this.interpWorldY += this.simVelY * dt * TICK_RATE;

      // Exponentially decay position error toward 0.
      // 15% per frame → converges in ~10 frames (167ms at 60Hz).
      // Max per-frame correction: 0.35 blocks * 0.15 = 0.05 blocks (5px) — invisible.
      const CORRECTION = 0.15;
      this.interpWorldX += this.posErrorX * CORRECTION;
      this.interpWorldY += this.posErrorY * CORRECTION;
      this.posErrorX *= (1 - CORRECTION);
      this.posErrorY *= (1 - CORRECTION);
    }

    // --- Camera position ---
    // When attached: camera follows the interpolated player world position.
    // When detached: camera stays at a fixed world position (tracked in world
    // coords so chunk-origin shifts don't cause teleportation). Each frame
    // we convert the world position to active-grid coords for rendering.
    // Uses the render origin (matches the grid data on the GPU) so the
    // camera stays aligned with the displayed grid during chunk-boundary
    // crossings.
    if (this.simReader) {
      const originCx = this.renderOriginCx;
      const originCy = this.renderOriginCy;

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
    const dpr = this.dpr || window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    if (this.camera.canvasW !== w || this.camera.canvasH !== h) {
      this.camera.resize(w, h);
    }

    // Read daylight from SAB (0-15, from day/night cycle)
    const daylight = this.simReader ? this.simReader.getDaylight() : 15;
    const daylightNorm = daylight / 15; // 0..1 for shader

    // Origin for texture stability (uses the render origin to stay consistent
    // with the grid data on the GPU — the shader adds this to gridCoords to
    // produce world-aligned UVs for stable procedural texturing across
    // chunk-boundary crossings).
    const originX = this.renderOriginCx * CHUNK_W;
    const originY = this.renderOriginCy * CHUNK_H;

    // Ensure depth texture matches canvas size (device pixels, not CSS)
    this.blockGridPass.ensureDepthTexture(canvas.width, canvas.height);

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

    // Update player render pass (character or stickman fallback) with 3D
    // perspective, using the smoothed interpolated position for the active
    // blockhead and raw SAB positions for the others.
    if (this.simReader) {
      const bhCount = this.simReader.getBlockheadCount();
      if (this.activeBhIndex >= bhCount) this.activeBhIndex = Math.max(0, bhCount - 1);
      if (bhCount > 0) {
        // Build the render list for all blockheads.
        this._charRenderList.length = 0;
        for (let i = 0; i < bhCount; i++) {
          const bh = this.simReader.getBlockhead(i);
          const id = bh[14];
          let localX: number, localY: number;
          if (i === this.activeBhIndex) {
            // Active: use the interpolated world position for smoothness.
            localX = this.interpWorldX - this.renderOriginCx * CHUNK_W;
            localY = this.interpWorldY - this.renderOriginCy * CHUNK_H;
            // Cache for the stickman fallback + any code reading these.
            this._charLocalX = localX;
            this._charLocalY = localY;
            this._charVx = bh[2];
            this._charWallClimbing = bh[15] !== 0;
          } else {
            // Non-active: raw SAB position → active-grid coords via sim origin.
            localX = bh[0] + (this.cachedOriginCx - this.renderOriginCx) * CHUNK_W;
            localY = bh[1] + (this.cachedOriginCy - this.renderOriginCy) * CHUNK_H;
          }
          this._charRenderList.push({
            localX, localY,
            vx: bh[2],
            wallClimbing: bh[15] !== 0,
            gender: this.getBhGender(id),
            id,
            isActive: i === this.activeBhIndex,
          });
        }

        // Stickman fallback: only render the active blockhead as a stickman
        // (the stickman pass is a single-instance fallback when CharacterPass
        // fails to init). Non-active blockheads are skipped in stickman mode.
        if (!this.characterPass && this.stickmanPass) {
          const active = this._charRenderList[this.activeBhIndex];
          if (active) {
            const bh = this.simReader.getBlockhead(this.activeBhIndex);
            this.stickmanPass.update3D(
              active.localX, active.localY,
              bh[4], bh[6],
              this.blockGridPass.getViewProj(),
              this.camera.canvasW, this.camera.canvasH,
              bh[7], bh[5] !== 0, bh[2],
            );
          }
        }
      }
    }

    // Update sky pass with current daylight level
    if (this.skyPass) {
      this.skyPass.update(this.camera.canvasW, this.camera.canvasH, daylight);
    }

    // Update task markers — only rebuild instance data when markers change
    // or the grid build tick advances (z-position depends on grid content).
    // Camera uniforms update every frame (separate call, only writes 80 bytes).
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
        this.taskMarkerPass.updateInstances(this.cachedMarkerData);
      }
      this.taskMarkerPass.updateCamera(
        this.blockGridPass.getViewProj(),
        this.camera.canvasW,
        this.camera.canvasH,
      );
    }

    // Update drop pass — only rebuild instance data when sim tick changes
    // (drops move at 30Hz, not render framerate). Camera uniforms update
    // every frame (separate call, only writes 84 bytes).
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
        this.dropPass.updateInstances(this.cachedDropData);
      }
      this.dropPass.updateCamera(
        this.blockGridPass.getViewProj(),
        this.camera.canvasW,
        this.camera.canvasH,
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
      const encoder = device.createCommandEncoder();
      const currentTexture = context.getCurrentTexture();
      if (!currentTexture) {
        // Surface not ready (e.g. mid-resize) — skip this frame
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
      // Render player character(s) (or stickman box fallback) with depth testing.
      // All blockheads render; the active one uses the interpolated position.
      // Each blockhead needs a separate uniform slot in the ModelRenderer
      // (instance index) — otherwise queue.writeBuffer overwrites the previous
      // instance's uniforms before the render pass executes.
      if (this.simReader && this.simReader.getBlockheadCount() > 0) {
        if (this.characterPass) {
          this.characterPass.beginFrame(
            this.blockGridPass.getViewProj(),
            [this.camera.x, this.camera.y, 0],
            daylightNorm,
          );
          // Ensure enough instances are allocated per gender.
          // Count how many blockheads use each gender.
          const genderCounts: Map<string, number> = new Map();
          for (const c of this._charRenderList) {
            genderCounts.set(c.gender, (genderCounts.get(c.gender) ?? 0) + 1);
          }
          // Allocate instances via CharacterPass (which delegates to
          // ModelRenderer.allocateInstance). Instance 0 is the original upload;
          // instances 1+ are allocated on demand.
          this.characterPass.ensureInstances(genderCounts);
          // Build per-gender render-order index → instance index mapping.
          const genderCounters: Map<string, number> = new Map();
          for (let i = 0; i < this._charRenderList.length; i++) {
            const c = this._charRenderList[i];
            const idx = genderCounters.get(c.gender) ?? 0;
            genderCounters.set(c.gender, idx + 1);
            this.characterPass.render(
              pass, c.localX, c.localY, c.vx, c.wallClimbing, c.gender, idx,
            );
          }
        } else {
          this.stickmanPass?.render(pass);
        }
      }
      // Render water (transparent, depth-tested but no depth-write) after
      // characters so the player is visible behind water.
      this.blockGridPass.renderWater(pass);
      // Render task markers on top (no depth, alpha blended)
      this.taskMarkerPass?.render(pass);
      // Render crop sprites (2D billboarded quads, no depth, on top of terrain)
      this.cropSpritePass?.render(pass);
      // Render world drops (spinning item quads, no depth, on top)
      this.dropPass?.render(pass);
      pass.end();
      device.queue.submit([encoder.finish()]);
    } catch (err) {
      // Canvas resize or surface invalidation — skip this frame.
      // The ResizeObserver will fire and reconfigure things; the next
      // frame should render normally.
      console.warn(`[Renderer] Frame skipped (surface invalid): ${(err as Error).message}`);
    }

    // Frame profiling: accumulate + log every 5s
    const frameMs = performance.now() - frameStart;
    this.frameTimes.push(frameMs);
    const now = performance.now();
    if (now - this.frameProfilerTimer >= 5000) {
      this.frameProfilerTimer = now;
      const times = this.frameTimes;
      const count = times.length;
      const avg = times.reduce((a, b) => a + b, 0) / count;
      const max = Math.max(...times);
      const min = Math.min(...times);
      const fps = (1000 / avg).toFixed(1);
      console.warn(
        `[Renderer Profiling] ${count} frames over 5s: avg=${avg.toFixed(2)}ms min=${min.toFixed(2)}ms max=${max.toFixed(2)}ms (~${fps}fps)`,
      );
      this.frameTimes = [];
    }
  }
}
