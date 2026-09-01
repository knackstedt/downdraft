// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Migrated from React DOM overlay to PixiJS-in-worker UI (@downdraft/library-pixi-ui).
// The UI scene runs in a Web Worker on an OffscreenCanvas stacked above the
// game canvas. State flows through three channels:
//   1. UiStatsSAB — per-frame scalars (host.writeStats each frame)
//   2. postEvent  — structured data (saves list)
//   3. onAction   — worker→main side-effect requests (buttons, sliders)
//
// Note: The falling-sand renderer creates and manages its own SandWorkerHost
// internally (in renderer.init()). The FallingSandSimAdapter below satisfies
// the GameSimWorker interface required by startGame() without spawning a
// duplicate worker — its start() is a no-op and the SABs it exposes are never
// used by the renderer (which has its own). The real simulation lifecycle is
// owned by the renderer.
// ============================================================================

import { captureCanvasThumbnail, createMcpHarness, startGame, type GameSimWorker } from "@downdraft/app/renderer";
import {
    createPixiUiMcpTools,
    getEffectiveFontScale,
    loadUserFontScale,
    PixiUiHost,
    saveUserFontScale,
    type PixiUiAction,
} from "@downdraft/library-pixi-ui";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/module-devtools";
import { FALLING_SAND_STATS_LAYOUT } from "./pixi/bridge-protocol";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
import { allocateSimBuffer, NUM_LAYERS, PLAYER } from "./shared/sim-buffer";
import { useGameStore, type FieldType } from "./stores/game-store";
import {
    autosave, deleteSave, listSaves, loadAutosave, loadGame, saveGame,
} from "./stores/save-system";
import "./styles/globals.css";

// --- GameSimWorker adapter ---
// The falling-sand renderer creates and manages its own SandWorkerHost
// internally in renderer.init(). This adapter satisfies the GameSimWorker
// interface required by startGame() without spawning a duplicate worker.
class FallingSandSimAdapter implements GameSimWorker {
  private sab: SharedArrayBuffer;

  constructor() {
    this.sab = allocateSimBuffer();
  }

  async start(_config: unknown): Promise<void> {
    // No-op: the FallingSandRenderer creates and starts its own SandWorkerHost
    // internally during renderer.init(). This adapter exists only to satisfy
    // the GameSimWorker interface for startGame().
  }

  onEvent(_cb: (msg: any) => void): void {
    // The falling-sand sim does not emit events to the renderer.
  }

  getSimBuffer(): SharedArrayBuffer { return this.sab; }
  getInputBuffer(): SharedArrayBuffer { return this.sab; }
}

// Track handles for hot-reload dispose.
let autosaveInterval: ReturnType<typeof setInterval> | null = null;
let pixiHost: PixiUiHost | null = null;
let statsRafId = 0;
let mouseMoveHandler: ((e: MouseEvent) => void) | null = null;

// Mouse position tracking (for brush circle in the pixi overlay).
let mouseX = 0;
let mouseY = 0;
let mouseValid = false;

startGame({
  // --- Renderer + Sim ---
  renderer: (canvas) => {
    const deterministic = (window as any).downdraft?.deterministic === true;
    return new FallingSandRenderer(canvas, deterministic);
  },
  sim: () => new FallingSandSimAdapter(),
  simConfig: {},

  // --- UI (PixiJS-in-worker, mounted in onReady) ---
  mountUI: () => { /* pixi-ui handles UI — no DOM overlay needed */ },

  // --- DevTools ---
  devtools: {
    createSimStatsProvider: (renderer) => createSimStatsProvider({
      getWorkerHost: () => renderer.getWorkerHost(),
      getStorePaused: () => useGameStore.getState().paused,
      setStorePaused: (paused) => useGameStore.getState().setPaused(paused),
      clearSim: () => renderer.clearAll(),
      getExtra: () => {
        const host = renderer.getWorkerHost();
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
          grid: `${renderer.getGridW()}x${renderer.getGridH()}`,
          layers: NUM_LAYERS,
          renderFPS: renderer.getFPS(),
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
            ["Grid", extra.grid ?? "—"],
            ["Layers", String(extra.layers ?? "—")],
            ["Render FPS", String(extra.renderFPS ?? "—")],
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

  // --- Renderer init ---
  // Override onInit so startGame() does NOT call sim.start() (the adapter is
  // a no-op). The renderer creates + starts its own SandWorkerHost internally.
  onInit: async (ctx) => {
    const ok = await ctx.renderer.init();
    if (!ok) {
      console.error("FallingSandRenderer initialization failed");
      return false;
    }
    return true;
  },

  // --- Post-init wiring ---
  onReady: async (ctx) => {
    const { renderer, deterministic } = ctx;

    // Wire renderer to the game store (was onRendererInit in bootstrapGame).
    useGameStore.getState().setRenderer(renderer);

    // --- Start the PixiJS UI overlay ---
    pixiHost = new PixiUiHost({
      backend: "webgl2",
      statsLayout: FALLING_SAND_STATS_LAYOUT,
      sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href,
      passThrough: true, // interactive UI + game-canvas painting
      canvasLayer: 1,
      canvasId: "pixi-ui-canvas",
      fontScale: getEffectiveFontScale(loadUserFontScale()),
    });

    // Handle worker→main actions (buttons, sliders, save/load/clear).
    pixiHost.onAction = (action: PixiUiAction) => {
      const s = useGameStore.getState();
      switch (action.kind) {
        case "selectMaterial":
          s.setSelectedMaterial((action as any).mat);
          break;
        case "setBrushMode":
          s.setBrushMode((action as any).mode === 0 ? "material" : "field");
          break;
        case "setFieldType": {
          const types: FieldType[] = ["gravity", "temperature", "windX", "windY"];
          s.setFieldType(types[(action as any).fieldType] ?? "gravity");
          break;
        }
        case "setFieldValue": {
          const a = action as any;
          if (a.field === "gravity") s.setFieldGravity(a.value);
          else if (a.field === "temperature") s.setFieldTemperature(a.value);
          else if (a.field === "windX") s.setFieldWindX(a.value);
          else if (a.field === "windY") s.setFieldWindY(a.value);
          break;
        }
        case "setBrushRadius":
          s.setBrushRadius((action as any).radius);
          break;
        case "setShowFieldOverlay":
          s.setShowFieldOverlay((action as any).show);
          break;
        case "setSettings": {
          const a = action as any;
          s.setSettings({
            ...(a.impulseChance !== undefined ? { horizontalImpulseChance: a.impulseChance } : {}),
            ...(a.impulseStrength !== undefined ? { horizontalImpulseStrength: a.impulseStrength } : {}),
          });
          break;
        }
        case "togglePanel": {
          const a = action as any;
          if (a.panel === "settings") s.setShowSettings(!s.showSettings);
          else if (a.panel === "saves") {
            const next = !s.showSaves;
            s.setShowSaves(next);
            if (next) refreshSaves();
          }
          break;
        }
        case "save":
          handleSave();
          break;
        case "load":
          handleLoad((action as any).id);
          break;
        case "deleteSave":
          handleDelete((action as any).id);
          break;
        case "clear":
          renderer.clearAll();
          break;
        case "setFontScale": {
          const a = action as any;
          const scale = getEffectiveFontScale(a.scale);
          pixiHost?.setFontScale(scale);
          saveUserFontScale(a.scale);
          break;
        }
      }
    };

    try {
      await pixiHost.start();
      console.log("[main] PixiUI overlay started");
    } catch (e) {
      console.error("[main] PixiUI overlay failed to start:", e);
    }

    // Register MCP automation tools for e2e testing.
    if (pixiHost) {
      const tools = createPixiUiMcpTools(pixiHost);
      createMcpHarness({
        serverName: "downdraft-falling-sand-pixi-automation",
        tools,
      });
    }

    // --- Mouse position tracking (for brush circle) ---
    mouseMoveHandler = (e: MouseEvent) => {
      const canvas = renderer.getCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const onCanvas = e.clientX >= rect.left && e.clientX <= rect.right &&
                       e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (onCanvas) {
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
        mouseValid = true;
      } else {
        mouseValid = false;
      }
    };
    window.addEventListener("mousemove", mouseMoveHandler);

    // --- Per-frame stats loop (writes UiStatsSAB from the game store) ---
    const statsLoop = () => {
      const s = useGameStore.getState();
      const r = s.renderer;
      const gridW = r?.getGridW() ?? 1;
      const gridH = r?.getGridH() ?? 1;
      const canvas = r?.getCanvas();
      const canvasW = canvas?.width ?? window.innerWidth;
      const canvasH = canvas?.height ?? window.innerHeight;

      pixiHost?.writeStats({
        fps: s.fps ?? 0,
        health: s.health,
        paused: s.paused ? 1 : 0,
        selectedMaterial: s.selectedMaterial,
        brushMode: s.brushMode === "material" ? 0 : 1,
        fieldType: ["gravity", "temperature", "windX", "windY"].indexOf(s.fieldType),
        fieldGravity: s.fieldGravity,
        fieldTemperature: s.fieldTemperature,
        fieldWindX: s.fieldWindX,
        fieldWindY: s.fieldWindY,
        showFieldOverlay: s.showFieldOverlay ? 1 : 0,
        brushRadius: s.brushRadius,
        showSettings: s.showSettings ? 1 : 0,
        showSaves: s.showSaves ? 1 : 0,
        impulseChance: s.settings.horizontalImpulseChance,
        impulseStrength: s.settings.horizontalImpulseStrength,
        inspectorValid: s.inspector.valid ? 1 : 0,
        inspectorGx: s.inspector.gx,
        inspectorGy: s.inspector.gy,
        inspectorMat: s.inspector.mat,
        inspectorLifetime: s.inspector.lifetime,
        inspectorShade: s.inspector.shade,
        inspectorGravity: s.inspector.gravity,
        inspectorTemperature: s.inspector.temperature,
        inspectorWindX: s.inspector.windX,
        inspectorWindY: s.inspector.windY,
        mouseX,
        mouseY,
        mouseValid: mouseValid ? 1 : 0,
        gridW,
        gridH,
        canvasW,
        canvasH,
      });
      statsRafId = requestAnimationFrame(statsLoop);
    };
    statsRafId = requestAnimationFrame(statsLoop);

    // --- Subscribe to store saves changes → forward to worker ---
    let lastSavesLen = -1;
    useGameStore.subscribe((s) => {
      if (s.saves.length !== lastSavesLen) {
        lastSavesLen = s.saves.length;
        pixiHost?.postEvent({
          kind: "setSaves",
          saves: s.saves.map((sv) => ({
            id: sv.id, name: sv.name, timestamp: sv.timestamp,
            thumbnailUrl: sv.thumbnailUrl, gridW: sv.gridW, gridH: sv.gridH,
          })),
        });
      }
    });

    // --- Autosave (skip in deterministic/test mode) ---
    if (!deterministic) {
      // Load previous session
      try {
        const saved = await loadAutosave();
        if (saved) {
          await renderer.loadSave(saved.grids, saved.fields, saved.gridW, saved.gridH);
          console.log("[autosave] Restored last session");
        }
      } catch {
        console.log("[autosave] No autosave found, starting fresh");
      }

      // Set up autosave interval (every 3s, matching bootstrap default)
      autosaveInterval = setInterval(async () => {
        const r = useGameStore.getState().renderer;
        if (!r) return;
        const { grids, fields, gridW, gridH } = r.snapshotGrids();
        await autosave({ gridW, gridH, grids, fields });
      }, 3000);
    }
  },

  // --- Cleanup (hot-reload dispose) ---
  onDispose: () => {
    if (autosaveInterval) {
      clearInterval(autosaveInterval);
      autosaveInterval = null;
    }
    if (statsRafId) {
      cancelAnimationFrame(statsRafId);
      statsRafId = 0;
    }
    if (mouseMoveHandler) {
      window.removeEventListener("mousemove", mouseMoveHandler);
      mouseMoveHandler = null;
    }
    if (pixiHost) {
      pixiHost.dispose();
      pixiHost = null;
    }
  },

  // --- FPS polling ---
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
}).catch((e) => {
  console.error("[main] Fatal:", e);
});

// ── Save/load helpers (called from onAction) ──

async function refreshSaves(): Promise<void> {
  try {
    const list = await listSaves();
    useGameStore.getState().setSaves(list);
  } catch (e) {
    console.error("Failed to list saves:", e);
  }
}

async function handleSave(): Promise<void> {
  const r = useGameStore.getState().renderer;
  if (!r) return;
  try {
    const canvas = r.getCanvas();
    const thumb = await captureCanvasThumbnail(canvas);
    const { grids, fields, gridW, gridH } = r.snapshotGrids();
    const name = `Save ${new Date().toLocaleString()}`;
    await saveGame(name, thumb, { gridW, gridH, grids, fields });
    await refreshSaves();
  } catch (e) {
    console.error("[save] Failed:", e);
  }
}

async function handleLoad(id: string): Promise<void> {
  const r = useGameStore.getState().renderer;
  if (!r) return;
  try {
    const entry = await loadGame(id);
    if (!entry) return;
    await r.loadSave(entry.grids, entry.fields, entry.gridW, entry.gridH);
  } catch (e) {
    console.error("Failed to load:", e);
  }
}

async function handleDelete(id: string): Promise<void> {
  try {
    await deleteSave(id);
    await refreshSaves();
  } catch (e) {
    console.error("Failed to delete save:", e);
  }
}
