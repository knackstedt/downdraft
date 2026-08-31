// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Migrated from Solid-in-worker UI to @pixi/react in PixiJS worker.
// The UI is now rendered in a Web Worker on an OffscreenCanvas via
// @downdraft/library-pixi-ui. State flows through:
//   - UiStatsSAB (per-frame scalars: health, oxygen, depth, menu visibility)
//   - postMessage events (structured data: inventory, achievements, snapshots)
//   - postAction (worker→main side effects: pause, save, craft, teleport)
// ============================================================================

import { startGame, type GameSimWorker } from "@downdraft/app/renderer";
import { PixiUiHost } from "@downdraft/library-pixi-ui";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/module-devtools";
import { MINING_STATS_LAYOUT, type WorkerToMainAction } from "./pixi/bridge-protocol";
import { MiningRenderer } from "./renderer/mining-renderer";
import { PLAYER, STATS, WORLD_SEED } from "./shared/constants";
import { allocateMiningSimBuffer } from "./shared/sim-buffer";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

let pixiHost: PixiUiHost | null = null;
let statsRafId = 0;
let snapshotCounter = 0;

/**
 * MiningGameSim — adapter that satisfies the GameSimWorker interface.
 * The mining-rpg renderer manages its own worker internally.
 */
class MiningGameSim implements GameSimWorker {
  private sab: SharedArrayBuffer;
  constructor() { this.sab = allocateMiningSimBuffer(); }
  async start(_config: unknown): Promise<void> { /* no-op */ }
  onEvent(_cb: (msg: any) => void): void { /* no-op */ }
  getSimBuffer(): SharedArrayBuffer { return this.sab; }
  getInputBuffer(): SharedArrayBuffer { return this.sab; }
}

startGame({
  renderer: (canvas) => {
    const deterministic = (globalThis as any).downdraft?.deterministic === true;
    return new MiningRenderer(canvas, deterministic);
  },
  sim: () => new MiningGameSim(),
  simConfig: {},

  mountUI: () => { /* pixi-ui handles UI */ },

  onInit: async (ctx) => {
    const ok = await ctx.renderer.init();
    if (!ok) { console.error("WebGPU initialization failed"); return false; }
    return true;
  },

  onReady: (ctx) => {
    const renderer = ctx.renderer as MiningRenderer;
    useGameStore.getState().setRenderer(renderer);

    // --- Start PixiUI overlay ---
    pixiHost = new PixiUiHost({
      backend: "webgl2",
      statsLayout: MINING_STATS_LAYOUT,
      sceneModuleUrl: new URL("./pixi-scene.tsx", import.meta.url).href,
      passThrough: true,
      canvasLayer: 1,
      canvasId: "pixi-ui-canvas",
    });

    pixiHost.onAction = ((action: any) => {
      const a = action as WorkerToMainAction;
      const s = useGameStore.getState();
      switch (a.kind) {
        case "pause": s.setPaused(true); break;
        case "resume": s.setPaused(false); break;
        case "teleport": (renderer as any).teleport?.(); break;
        case "respawn": (renderer as any).respawn?.(); break;
        case "save": (renderer as any).saveNow?.(); break;
        case "sellAll": s.sellAll(); break;
        case "buyUpgrade": (renderer as any).purchaseUpgrade?.(a.config); break;
        case "craft": s.craft(a.recipe); break;
        case "toggleBuildMode": s.toggleBuildMode(); break;
        case "selectBuild": s.selectBuild(a.type); break;
        case "toggleHeadlamp": s.toggleHeadlamp(); break;
        case "toggleNoclip": s.toggleNoclip(); break;
        case "setZoom": s.setZoom(a.zoom); break;
        case "buyBuildMaterial": (renderer as any).buyBuildMaterial?.(a.type, a.qty); break;
        case "startGame": s.setShowTitleScreen(false); break;
        case "setShowTitleScreen": s.setShowTitleScreen(a.show); break;
        case "deleteSave": (renderer as any).deleteSave?.(); break;
        case "toggleShop": s.toggleShop(); break;
        case "setShowShop": s.setShowShop(a.show); break;
      }
    }) as any;

    pixiHost.start().then(() => {
      console.log("[main] PixiJS UI worker started");
    }).catch((e) => {
      console.error("[main] PixiUI failed:", e);
    });

    // --- Forward store changes to the worker via postMessage ---
    const init = useGameStore.getState();
    let lastInventory = init.inventory;
    let lastBuildMaterials = init.buildMaterials;
    let lastCraftedItems = init.craftedItems;
    let lastAchievements = init.unlockedAchievements;
    let lastRecentAchievement = init.recentAchievement;
    let lastGameOver = init.gameOver;
    let lastSaveTime = init.lastSaveTime;

    useGameStore.subscribe((st) => {
      if (st.inventory !== lastInventory) {
        lastInventory = st.inventory;
        pixiHost?.postEvent({ kind: "setInventory", inventory: st.inventory });
      }
      if (st.buildMaterials !== lastBuildMaterials) {
        lastBuildMaterials = st.buildMaterials;
        pixiHost?.postEvent({ kind: "buildMaterials", mats: st.buildMaterials });
      }
      if (st.craftedItems !== lastCraftedItems) {
        lastCraftedItems = st.craftedItems;
      }
      if (st.unlockedAchievements !== lastAchievements) {
        lastAchievements = st.unlockedAchievements;
      }
      if (st.recentAchievement !== lastRecentAchievement) {
        lastRecentAchievement = st.recentAchievement;
        if (st.recentAchievement) {
          pixiHost?.postEvent({ kind: "achievement", id: st.recentAchievement.id });
        }
      }
      if (st.gameOver !== lastGameOver) {
        lastGameOver = st.gameOver;
        if (st.gameOver) {
          pixiHost?.postEvent({ kind: "death", cause: st.deathCause, quip: st.deathQuip });
        }
      }
      if (st.lastSaveTime !== lastSaveTime) {
        lastSaveTime = st.lastSaveTime;
        pixiHost?.postEvent({ kind: "savedAt", time: st.lastSaveTime });
      }
    });

    // --- Per-frame stats loop: poll renderer → write SAB + post snapshot ---
    const statsLoop = () => {
      if (!pixiHost) return;
      const r = renderer;
      const playerPos = r.getPlayerPos();
      const cam = r.getCamera();
      const grid = r.getGridReader();
      const tick = grid?.getStat(STATS.TICK) ?? 0;
      const store = useGameStore.getState();
      const host = (r as any).getWorkerHost?.();

      pixiHost.writeStats({
        fps: r.getFPS(),
        health: host?.getPlayerI32?.(PLAYER.HEALTH) ?? 0,
        oxygen: host?.getPlayerI32?.(PLAYER.OXYGEN) ?? 0,
        depth: Math.floor(playerPos.y / 128),
        loadedChunks: grid?.getStat(STATS.LOADED_CHUNKS) ?? 0,
        activeChunks: grid?.getStat(STATS.LOADED_CHUNKS) ?? 0,
        nearSignpost: store.nearSignpost ? 1 : 0,
        onGround: (host?.getPlayerI32?.(PLAYER.ON_GROUND) ?? 0) !== 0 ? 1 : 0,
        playerFacing: host?.getPlayerI32?.(PLAYER.FACING) ?? 1,
        playerX: playerPos.x, playerY: playerPos.y,
        playerVx: host?.getPlayerF32?.(PLAYER.VX) ?? 0,
        playerVy: host?.getPlayerF32?.(PLAYER.VY) ?? 0,
        deathCause: host?.getPlayerI32?.(PLAYER.DEATH_CAUSE) ?? 0,
        simReady: tick > 0 ? 1 : 0,
        tick, gameOver: store.gameOver ? 1 : 0,
        zoom: cam.zoom,
        glowstickCount: store.glowstickCount,
        bombCount: store.bombCount,
        teleportCooldown: store.teleportCooldown,
        playerSpeed: store.playerSpeed,
        showTitleScreen: store.showTitleScreen ? 1 : 0,
        showInventory: store.showInventory ? 1 : 0,
        showEscapeMenu: store.showEscapeMenu ? 1 : 0,
        showStats: store.showStats ? 1 : 0,
        showAchievements: store.showAchievements ? 1 : 0,
        showMinimap: store.showMinimap ? 1 : 0,
        showShop: store.showShop ? 1 : 0,
        showHUD: store.showHUD ? 1 : 0,
        showFPS: store.showFPS ? 1 : 0,
        showHelp: store.showHelp ? 1 : 0,
        paused: store.paused ? 1 : 0,
        buildMode: store.buildMode ? 1 : 0,
        headlampOn: store.headlampOn ? 1 : 0,
        noclip: store.noclip ? 1 : 0,
        currency: store.currency,
        digRadius: store.digRadius,
        goldFlashTime: store.goldFlashTime,
        maxInventory: store.getMaxInventory(),
        inventoryCount: store.getInventoryCount(),
        canvasW: ctx.canvas.width,
        canvasH: ctx.canvas.height,
      });

      // Post renderer snapshot every ~30fps (every other frame)
      snapshotCounter++;
      if (snapshotCounter >= 2) {
        snapshotCounter = 0;
        const origin = r.getActiveGridOrigin();
        const hovered = r.getHoveredCell();
        const mouse = r.getMouseScreenPos();
        pixiHost.postEvent({
          kind: "rendererSnapshot",
          camX: cam.x, camY: cam.y, camZoom: cam.zoom,
          camWidth: cam.width, camHeight: cam.height,
          signpostX: 0, signpostY: 0, signpostVisible: false,
          bombs: [], explosions: [], glowsticks: [], enemies: [],
          hoveredMat: hovered?.mat ?? -1, mouseX: mouse.x, mouseY: mouse.y,
          gridOriginX: origin.x, gridOriginY: origin.y,
          gridOriginW: origin.w, gridOriginH: origin.h,
          playerX: playerPos.x, playerY: playerPos.y,
          npcSurfaceYs: [],
        });
      }

      statsRafId = requestAnimationFrame(statsLoop);
    };
    statsRafId = requestAnimationFrame(statsLoop);
  },

  devtools: {
    createSimStatsProvider: (renderer) => createSimStatsProvider({
      getWorkerHost: () => renderer.getWorkerHost(),
      getStorePaused: () => useGameStore.getState().paused,
      setStorePaused: (paused) => useGameStore.getState().setPaused(paused),
      getExtra: () => {
        const host = renderer.getWorkerHost();
        const store = useGameStore.getState();
        const player = host ? {
          px: host.getPlayerF32(PLAYER.PX),
          py: host.getPlayerF32(PLAYER.PY),
          vx: host.getPlayerF32(PLAYER.VX),
          vy: host.getPlayerF32(PLAYER.VY),
          health: host.getPlayerI32(PLAYER.HEALTH),
          onGround: host.getPlayerI32(PLAYER.ON_GROUND) !== 0,
          facing: host.getPlayerI32(PLAYER.FACING),
        } : null;
        return {
          depth: store.depth,
          loadedChunks: store.loadedChunks,
          activeChunks: store.activeChunks,
          frozenChunks: store.loadedChunks - store.activeChunks,
          terrainSeed: WORLD_SEED,
          renderFPS: renderer.getFPS(),
          inventoryCount: store.inventory.reduce((sum, e) => sum + e.count, 0),
          inventoryTypes: store.inventory.length,
          player,
        };
      },
    }),
    panels: [
      createSimStatsPanelExtension({
        extraRows: (stats) => {
          const extra = stats.extra as any;
          if (!extra) return [];
          const rows: [string, string][] = [
            ["Depth", String(extra.depth ?? "—")],
            ["Loaded Chunks", String(extra.loadedChunks ?? "—")],
            ["Active Chunks", String(extra.activeChunks ?? "—")],
            ["Frozen Chunks", String(extra.frozenChunks ?? "—")],
            ["Terrain Seed", String(extra.terrainSeed ?? "—")],
            ["Render FPS", String(extra.renderFPS ?? "—")],
            ["Inventory Items", String(extra.inventoryCount ?? "—")],
            ["Inventory Types", String(extra.inventoryTypes ?? "—")],
          ];
          if (extra.player) {
            const p = extra.player;
            rows.push(
              ["Player Pos", `(${p.px.toFixed(1)}, ${p.py.toFixed(1)})`],
              ["Player Vel", `(${p.vx.toFixed(2)}, ${p.vy.toFixed(2)})`],
              ["Player Health", String(p.health)],
              ["On Ground", p.onGround ? "Yes" : "No"],
              ["Facing", p.facing > 0 ? "Right" : "Left"],
            );
          }
          return rows;
        },
      }),
    ],
  },

  onDisplayInfo: (refreshRate, ctx) => {
    const renderer = ctx.renderer as MiningRenderer;
    renderer.setFrameRateLimit(refreshRate);
  },

  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),

  onDispose: async () => {
    if (statsRafId) cancelAnimationFrame(statsRafId);
    pixiHost?.dispose();
    const renderer = useGameStore.getState().renderer as MiningRenderer | null;
    if (renderer) await renderer.stop();
  },
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
