// ============================================================================
// host — main-thread host for the Solid-in-worker UI.
//
// Spawns the UI worker, allocates the three SharedArrayBuffers (domSab,
// uiStatsSab, minimapSab), sets up the undertow MainThreadHost, and bridges
// events between the MiningRenderer and the worker.
//
// The host is created by main.tsx (replacing the React createRoot path).
// It owns:
//   - The undertow MainThreadHost (drains DOM op requests from the worker)
//   - The UiStatsSAB (written each frame from the renderer's per-frame data)
//   - The minimap SAB (written each frame with pre-rendered minimap pixels)
//   - A rAF loop that drains the undertow host + writes UiStatsSAB + posts
//     renderer snapshots to the worker
//   - A message handler for worker→main actions (pause, teleport, save, etc.)
// ============================================================================

import { MainThreadHost } from "@downdraft/library-undertow";
import type { MiningRenderer } from "../renderer/mining-renderer";
import { PLAYER, STATS } from "../shared/constants";
import type { useGameStore } from "../stores/game-store";
import type { RendererSnapshotEvent, WorkerToMainAction } from "./bridge-protocol";
import { MINIMAP_SIZE } from "./stores/game-store";
import {
    allocateUiStatsSab,
    writeUiStats,
} from "./ui-stats-sab";
// The worker entry is built as a separate Rollup chunk (see electron.vite.config.ts
// solidWorkerEntryPlugin). We load it via a URL relative to the current module.
// In production, this resolves to /assets/solid-worker-[hash].js.
// In dev, Vite serves the module directly.

// NPC X positions — must match the VillageOverlay's NPCS array offsets.
// Used to sample surface heights for the renderer snapshot.
const NPC_OFFSETS = [-22, 16, -32, 28];

export interface SolidHostOptions {
  renderer: MiningRenderer;
  reactStore: typeof useGameStore;
}

export class SolidHost {
  private worker: Worker | null = null;
  private domHost: MainThreadHost | null = null;
  private uiStatsSab: SharedArrayBuffer;
  private minimapSab: SharedArrayBuffer;
  private renderer: MiningRenderer;
  private reactStore: typeof useGameStore;
  private rafId = 0;
  private snapshotTimer = 0;
  private disposed = false;

  constructor(opts: SolidHostOptions) {
    this.renderer = opts.renderer;
    this.reactStore = opts.reactStore;
    this.uiStatsSab = allocateUiStatsSab();
    // 160×160 RGBA pixels = 102400 bytes
    this.minimapSab = new SharedArrayBuffer(MINIMAP_SIZE * MINIMAP_SIZE * 4);
  }

  /** Start the host: spawn the worker, send init, begin rAF loop. */
  async start(): Promise<void> {
    // --- Spawn the UI worker ---
    // The worker entry is built as a separate Rollup chunk by the solidWorkerPlugin
    // in electron.vite.config.ts. The placeholder __SOLID_WORKER_URL__ is replaced
    // with the actual asset URL at build time. In dev, we fall back to the
    // Vite dev server URL.
    const workerUrl =
      typeof __SOLID_WORKER_URL__ !== "undefined"
        ? __SOLID_WORKER_URL__
        : new URL("./worker-entry.ts", import.meta.url).href;
    this.worker = new Worker(workerUrl, {
      type: "module",
    });

    // --- Set up the undertow MainThreadHost ---
    this.domHost = new MainThreadHost({
      document: globalThis.document,
      window: globalThis.window,
    });

    // --- Wire worker→main actions ---
    this.worker.onmessage = (e: MessageEvent<WorkerToMainAction>) => {
      this.handleWorkerAction(e.data);
    };

    // --- Send init message with the three SABs ---
    this.worker.postMessage({
      kind: "init",
      domSab: this.domHost.sab,
      uiStatsSab: this.uiStatsSab,
      minimapSab: this.minimapSab,
    });

    // --- Subscribe to React store changes → forward event-driven data to worker ---
    this.subscribeToReactStore();

    // --- Start the rAF loop: drain undertow + write UiStatsSAB + snapshots ---
    this.rafId = requestAnimationFrame(() => this.tick());
  }

  /** Subscribe to React store changes and forward event-driven fields to the worker. */
  private subscribeToReactStore(): void {
    const store = this.reactStore;
    let prev = store.getState();

    // Forward collected items (inventory changes from the sim worker)
    store.subscribe((state) => {
      // Inventory changed → forward as "collected" event
      if (state.inventory !== prev.inventory) {
        // The renderer already added items to the React store.
        // Forward the full inventory so the worker can sync.
        this.postEvent({ kind: "setInventory", inventory: state.inventory });
      }
      // Currency changed
      if (state.currency !== prev.currency) {
        // Forward via a synthetic event — the worker store doesn't have a
        // direct "currency changed" event, so we use saveLoaded's currency field
        // via a dedicated sync. Actually, the worker store handles currency
        // locally (sellAll adds to currency). We only need to sync when the
        // renderer changes it (e.g. sellAll from the React side).
        // The sellAll action is forwarded via handleWorkerAction, so the
        // worker store already updates currency. Skip here.
      }
      // Build materials changed
      if (state.buildMaterials !== prev.buildMaterials) {
        this.postEvent({ kind: "buildMaterials", mats: state.buildMaterials });
      }
      // Save loaded (welcomeBack message appears)
      if (state.welcomeBack !== prev.welcomeBack && state.welcomeBack) {
        this.postEvent({
          kind: "saveLoaded",
          inventory: state.inventory,
          upgrades: state.upgrades,
          currency: state.currency,
          buildMaterials: state.buildMaterials,
          health: state.health,
          stats: state.stats,
          unlockedAchievements: [...state.unlockedAchievements],
          craftedItems: state.craftedItems,
          welcomeBack: state.welcomeBack,
        });
      }
      // Last save time changed
      if (state.lastSaveTime !== prev.lastSaveTime) {
        this.postEvent({ kind: "savedAt", time: state.lastSaveTime });
      }
      // Achievement unlocked
      if (state.recentAchievement !== prev.recentAchievement && state.recentAchievement) {
        this.postEvent({ kind: "achievement", id: state.recentAchievement.id });
      }
      // Death
      if (state.gameOver !== prev.gameOver && state.gameOver) {
        this.postEvent({
          kind: "death",
          cause: state.deathCause,
          quip: state.deathQuip,
        });
      }
      // Floating text (damage numbers, gold gains)
      // The renderer calls store.spawnFloatingText which is a function —
      // we can't detect it via subscribe. Instead, we patch the store method below.
      // Screen shake — same: store.triggerScreenShake is a function call.
      // Both are patched in patchReactStoreForForwarding().

      prev = state;
    });

    // Patch spawnFloatingText + triggerScreenShake to forward to the worker
    this.patchReactStoreForForwarding();
  }

  /** Patch the React store's effect methods to also forward to the worker. */
  private patchReactStoreForForwarding(): void {
    const store = this.reactStore;
    const origSpawn = store.getState().spawnFloatingText;
    const origShake = store.getState().triggerScreenShake;
    const self = this;

    // We can't permanently patch zustand methods (they're recreated on set),
    // but spawnFloatingText/triggerScreenShake are stable functions in the
    // store definition. We override them by wrapping the store's set call.
    // Actually, zustand methods are stable — they're defined once in the
    // create() factory and don't change. So we can safely wrap them.
    const s = store.getState();
    const origSpawnFn = s.spawnFloatingText.bind(s);
    const origShakeFn = s.triggerScreenShake.bind(s);

    // Override via store.setState (zustand allows patching methods)
    store.setState({
      spawnFloatingText: (x: number, y: number, text: string, color: string) => {
        origSpawnFn(x, y, text, color);
        self.postEvent({ kind: "floatingText", x, y, text, color });
      },
      triggerScreenShake: (intensity: number) => {
        origShakeFn(intensity);
        self.postEvent({ kind: "screenShake", intensity });
      },
    } as any);
  }

  /** Per-frame tick: drain undertow, write UiStatsSAB, post renderer snapshot. */
  private targetFrameTime = 0;
  private limiterActive = false;
  private tick(): void {
    if (this.disposed) return;

    // Always drain DOM ops promptly (low cost, keeps UI responsive)
    this.domHost?.drain();

    // 2. Write per-frame scalars to the UiStatsSAB
    const r = this.renderer;
    const playerPos = r.getPlayerPos();
    const cam = r.getCamera();
    const grid = r.getGridReader();
    const tick = grid?.getStat(STATS.TICK) ?? 0;
    const origin = r.getActiveGridOrigin();
    const hovered = r.getHoveredCell();
    const mouse = r.getMouseScreenPos();

    writeUiStats(this.uiStatsSab, {
      fps: r.getFPS(),
      health: this.readPlayerI32(PLAYER.HEALTH),
      oxygen: this.readPlayerI32(PLAYER.OXYGEN),
      depth: Math.floor(playerPos.y / 128),
      loadedChunks: grid?.getStat(STATS.LOADED_CHUNKS) ?? 0,
      activeChunks: grid?.getStat(STATS.LOADED_CHUNKS) ?? 0,
      nearSignpost: this.reactStore.getState().nearSignpost,
      onGround: this.readPlayerI32(PLAYER.ON_GROUND) !== 0,
      playerFacing: this.readPlayerI32(PLAYER.FACING),
      playerX: playerPos.x,
      playerY: playerPos.y,
      playerVx: this.readPlayerF32(PLAYER.VX),
      playerVy: this.readPlayerF32(PLAYER.VY),
      deathCause: this.readPlayerI32(PLAYER.DEATH_CAUSE),
      simReady: tick > 0,
      tick,
      gameOver: this.reactStore.getState().gameOver,
      zoom: cam.zoom,
      glowstickCount: this.reactStore.getState().glowstickCount,
      bombCount: this.reactStore.getState().bombCount,
      teleportCooldown: this.reactStore.getState().teleportCooldown,
      playerSpeed: this.reactStore.getState().playerSpeed,
    });

    // 3. Render the minimap pixels into the minimap SAB (throttled to ~30fps)
    this.snapshotTimer++;
    if (this.snapshotTimer >= 2) {
      this.snapshotTimer = 0;
      this.renderMinimap();
      this.postRendererSnapshot(cam, playerPos, origin, hovered, mouse);
    }

    // 4. Drain again — the worker may have pushed DOM ops (fire-and-forget
    // setProperty/setAttribute calls from Solid reactivity) while we were
    // writing the UiStatsSAB and minimap. Draining again here ensures those
    // ops are applied to the real DOM in the SAME frame rather than waiting
    // for the next frame or the armRequestWait MessageChannel macrotask.
    this.domHost?.drain();

    this.rafId = requestAnimationFrame(() => this.tick());
  }

  /** Read a player I32 from the renderer's worker host. */
  private readPlayerI32(slot: number): number {
    const host = (this.renderer as any).getWorkerHost?.();
    return host?.getPlayerI32?.(slot) ?? 0;
  }

  /** Read a player F32 from the renderer's worker host. */
  private readPlayerF32(slot: number): number {
    const host = (this.renderer as any).getWorkerHost?.();
    return host?.getPlayerF32?.(slot) ?? 0;
  }

  /** Pre-render the minimap pixels into the minimap SAB. */
  private renderMinimap(): void {
    const reader = this.renderer.getGridReader();
    if (!reader) return;
    const playerPos = this.renderer.getPlayerPos();
    const WORLD_RADIUS = 200;
    const grid = reader.getGrid();
    const explored = reader.getExploredGrid();
    const originX = reader.getStat(/* STATS.ORIGIN_X */ 1);
    const originY = reader.getStat(/* STATS.ORIGIN_Y */ 2);
    const ACTIVE_GRID_W = 256;
    const ACTIVE_GRID_H = 256;

    const worldX0 = Math.floor(playerPos.x) - WORLD_RADIUS;
    const worldY0 = Math.floor(playerPos.y) - WORLD_RADIUS;

    const pixels = new Uint8Array(this.minimapSab);
    // Clear to black (alpha 255)
    pixels.fill(0);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;

    // Sample the grid for each minimap pixel
    for (let my = 0; my < MINIMAP_SIZE; my++) {
      for (let mx = 0; mx < MINIMAP_SIZE; mx++) {
        const wx = Math.floor(worldX0 + (mx / MINIMAP_SIZE) * (WORLD_RADIUS * 2));
        const wy = Math.floor(worldY0 + (my / MINIMAP_SIZE) * (WORLD_RADIUS * 2));
        const lx = wx - originX;
        const ly = wy - originY;
        if (lx < 0 || ly < 0 || lx >= ACTIVE_GRID_W || ly >= ACTIVE_GRID_H) continue;
        const gridIdx = ly * ACTIVE_GRID_W + lx;
        const mat = grid[gridIdx] & 0xff;
        const isExplored = explored[gridIdx] > 0;
        if (!isExplored && mat === 0) continue;

        let rr = 15, gg = 20, bb = 35;
        if (mat === 0) {
          // Air (explored) — dark blue
        } else if (mat === /* Material.Water */ 9 || mat === /* Material.Lava */ 10) {
          if (mat === 10) { rr = 255; gg = 80; bb = 0; }
          else { rr = 40; gg = 80; bb = 180; }
        } else if (mat === /* Material.TinOre */ 16) { rr = 180; gg = 184; bb = 188; }
        else if (mat === /* Material.CopperOre */ 17) { rr = 184; gg = 115; bb = 51; }
        else if (mat === /* Material.IronOre */ 18) { rr = 140; gg = 115; bb = 101; }
        else if (mat === /* Material.GoldOre */ 21) { rr = 230; gg = 200; bb = 51; }
        else if (mat === /* Material.Coal */ 24) { rr = 40; gg = 40; bb = 40; }
        else if (mat === /* Material.Dirt */ 1 || mat === /* Material.Grass */ 2) { rr = 60; gg = 40; bb = 25; }
        else if (mat === /* Material.Stone */ 3 || mat === /* Material.LooseStone */ 12) { rr = 50; gg = 50; bb = 55; }
        else { rr = 45; gg = 45; bb = 50; }

        const pxIdx = (my * MINIMAP_SIZE + mx) * 4;
        pixels[pxIdx] = rr;
        pixels[pxIdx + 1] = gg;
        pixels[pxIdx + 2] = bb;
        pixels[pxIdx + 3] = 255;
      }
    }
  }

  /** Post a renderer snapshot to the worker (camera + entities + hovered cell). */
  private postRendererSnapshot(
    cam: { x: number; y: number; zoom: number; width: number; height: number },
    playerPos: { x: number; y: number },
    origin: { x: number; y: number; w: number; h: number },
    hovered: { mat: number; wx: number; wy: number },
    mouse: { x: number; y: number },
  ): void {
    const sign = this.renderer.getSignpostPos();
    // Sample surface heights at NPC X positions
    const npcSurfaceYs = NPC_OFFSETS.map((off) =>
      this.renderer.getSurfaceHeightAt(sign.x + off),
    );

    // Collect bombs, explosions, glowsticks, enemies from the renderer
    const bombs = ((this.renderer as any).bombs ?? []).map((b: any) => ({
      x: b.x, y: b.y, progress: b.fuse ?? 0,
    }));
    const explosions = ((this.renderer as any).explosions ?? []).map((e: any) => ({
      x: e.x, y: e.y, progress: e.age / (e.maxAge || 1),
    }));
    const glowsticks = ((this.renderer as any).glowsticks ?? []).map((g: any) => ({
      x: g.x, y: g.y, r: g.color[0], g: g.color[1], b: g.color[2],
    }));
    const enemies = ((this.renderer as any).enemies ?? []).map((e: any) => ({
      x: e.x, y: e.y, color: e.color ?? "#f44336", size: e.size ?? 1,
      health: e.health ?? 1, maxHealth: e.maxHealth ?? 1, name: e.name ?? "Enemy",
    }));

    const snap: RendererSnapshotEvent = {
      kind: "rendererSnapshot",
      camX: cam.x,
      camY: cam.y,
      camZoom: cam.zoom,
      camWidth: cam.width,
      camHeight: cam.height,
      signpostX: sign.x,
      signpostY: sign.y,
      signpostVisible: true,
      bombs,
      explosions,
      glowsticks,
      enemies,
      hoveredMat: hovered.mat,
      mouseX: mouse.x,
      mouseY: mouse.y,
      gridOriginX: origin.x,
      gridOriginY: origin.y,
      gridOriginW: origin.w,
      gridOriginH: origin.h,
      playerX: playerPos.x,
      playerY: playerPos.y,
      npcSurfaceYs,
    };
    this.worker?.postMessage(snap);
  }

  /** Handle a worker→main action. */
  private handleWorkerAction(action: WorkerToMainAction): void {
    const r = this.renderer;
    const store = this.reactStore.getState();
    switch (action.kind) {
      case "pause":
        r.pause();
        store.setPaused(true);
        break;
      case "resume":
        (r as any).workerHost?.resume?.();
        store.setPaused(false);
        break;
      case "setInventory":
        store.setInventory(action.inventory);
        break;
      case "teleport":
        (r as any).teleportToSurface?.();
        break;
      case "respawn":
        (r as any).respawn?.();
        break;
      case "save":
        (r as any).saveNow?.();
        break;
      case "sellAll":
        store.sellAll();
        break;
      case "buyUpgrade":
        store.purchaseUpgrade(action.config);
        break;
      case "craft":
        store.craft(action.recipe);
        break;
      case "toggleBuildMode":
        store.toggleBuildMode();
        break;
      case "selectBuild":
        store.selectBuild(action.type);
        break;
      case "toggleHeadlamp":
        store.toggleHeadlamp();
        break;
      case "toggleNoclip":
        store.toggleNoclip();
        break;
      case "setZoom":
        r.resetZoom();
        break;
      case "buyBuildMaterial":
        store.buyBuildMaterial(action.type, action.qty);
        break;
      case "startGame":
        store.setShowTitleScreen(false);
        break;
      case "setShowTitleScreen":
        store.setShowTitleScreen(action.show);
        break;
      case "deleteSave":
        (r as any).autosave?.deleteSave?.();
        break;
      case "toggleShop":
        store.toggleShop();
        break;
      case "setShowShop":
        store.setShowShop(action.show);
        break;
    }
  }

  /** Forward a main→worker event (called by the renderer bridge). */
  postEvent(msg: unknown): void {
    this.worker?.postMessage(msg);
  }

  /** Set the frame rate limit from the display refresh rate. */
  setFrameRateLimit(refreshRate: number): void {
    this.targetFrameTime = refreshRate > 0 ? 1000 / refreshRate : 0;
    if (this.targetFrameTime <= 0) this.limiterActive = false;
  }

  /** Dispose: terminate worker, cancel rAF, dispose undertow host. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.rafId);
    cancelAnimationFrame(this.rafId);
    this.worker?.terminate();
    this.worker = null;
    this.domHost?.dispose();
    this.domHost = null;
  }
}
