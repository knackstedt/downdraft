// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// PixiJS-in-worker UI (@downdraft/library-pixi-ui). The UI scene runs in a
// Web Worker on an OffscreenCanvas stacked above the game canvas. State flows
// through three channels:
//   1. UiStatsSAB — per-frame scalars (bridge stats loop)
//   2. postEvent  — structured data (saves list)
//   3. onAction   — worker→main side-effect requests (buttons, sliders)
//
// The renderer owns the sim: FallingSandRenderer creates + starts its own
// SandWorkerHost inside init(), and `simFromRenderer` exposes it to
// startGame()'s context (no fake GameSimWorker adapter needed).
// ============================================================================

import {
    captureCanvasThumbnail,
    createMcpHarness,
    createStandardAutomationTools,
    startGame,
} from "@downdraft/app/renderer";
import {
    createPixiUiBridge,
    createPixiUiMcpTools,
    getEffectiveFontScale,
    loadUserFontScale,
    saveUserFontScale,
    type PixiUiAction,
    type PixiUiBridge,
} from "@downdraft/library-pixi-ui";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/module-devtools";
import { FALLING_SAND_STATS_LAYOUT } from "./pixi/bridge-protocol";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
import { NUM_LAYERS, PLAYER } from "./shared/sim-buffer";
import { useGameStore, type FieldType } from "./stores/game-store";
import { createFallingSandSaveSystem, type FallingSandSaveSystem } from "./stores/save-system";
import "./styles/globals.css";

// Save lifecycle handle — created in onReady, stopped in onDispose.
let saves: FallingSandSaveSystem | null = null;
let savesUnsub: (() => void) | null = null;
let bridgeRef: PixiUiBridge | null = null;

startGame({
  // --- Renderer + renderer-owned sim ---
  renderer: (canvas) => {
    const deterministic = (window as any).downdraft?.deterministic === true;
    return new FallingSandRenderer(canvas, deterministic);
  },
  // The renderer spawns + starts its own SandWorkerHost in init(); expose it
  // to the game context (SABs + event routing) without a duplicate worker.
  simFromRenderer: (r: FallingSandRenderer) => r.getWorkerHost() ?? undefined,

  // --- UI (PixiJS-in-worker via the batteries-included bridge) ---
  ui: () => createPixiUiBridge({
    statsLayout: FALLING_SAND_STATS_LAYOUT,
    sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href,
    passThrough: true, // interactive UI + game-canvas painting
    fontScale: getEffectiveFontScale(loadUserFontScale()),
    trackPointer: true, // merges mouseX/mouseY/mouseValid into stats (brush circle)
    onAction: (action: PixiUiAction) => {
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
          useGameStore.getState().renderer?.clearAll();
          break;
        case "setFontScale": {
          const a = action as any;
          const scale = getEffectiveFontScale(a.scale);
          uiBridge()?.host.setFontScale(scale);
          saveUserFontScale(a.scale);
          break;
        }
      }
    },
    getStats: () => {
      const s = useGameStore.getState();
      const r = s.renderer;
      const gridW = r?.getGridW() ?? 1;
      const gridH = r?.getGridH() ?? 1;
      const canvas = r?.getCanvas();
      const canvasW = canvas?.width ?? window.innerWidth;
      const canvasH = canvas?.height ?? window.innerHeight;
      return {
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
        gridW,
        gridH,
        canvasW,
        canvasH,
      };
    },
  }),

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
  // The renderer creates + starts its own SandWorkerHost internally, so
  // startGame() must not start a sim — there is no `sim` factory.
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

    // Wire renderer to the game store.
    useGameStore.getState().setRenderer(renderer);

    // MCP automation tools (standard set + pixi-ui tools).
    const bridge = ctx.ui as PixiUiBridge | undefined;
    bridgeRef = bridge ?? null;
    const tools = [
      ...createStandardAutomationTools({
        canvas: () => renderer.getCanvas(),
        getUiState: () => {
          const s = useGameStore.getState();
          return {
            paused: s.paused,
            showSettings: s.showSettings,
            showSaves: s.showSaves,
            selectedMaterial: s.selectedMaterial,
            brushMode: s.brushMode,
            brushRadius: s.brushRadius,
            ready: s.ready,
            simReady: s.simReady,
          };
        },
      }),
      ...(bridge ? createPixiUiMcpTools(bridge.host) : []),
    ];
    createMcpHarness({
      serverName: "downdraft-falling-sand-pixi-automation",
      tools,
    });

    // --- Save lifecycle (autosave interval + restore-on-start) ---
    saves = createFallingSandSaveSystem({
      snapshot: () => {
        const r = useGameStore.getState().renderer;
        return r ? r.snapshotGrids() : null;
      },
      restore: async (e) => {
        const r = useGameStore.getState().renderer;
        if (r) await r.loadSave(e.grids, e.fields, e.gridW, e.gridH);
      },
      deterministic,
    });
    const restored = await saves.start();
    if (restored) console.log("[autosave] Restored last session");

    // --- Forward saves list changes to the worker scene ---
    let lastSavesLen = -1;
    savesUnsub = useGameStore.subscribe((s) => {
      if (s.saves.length !== lastSavesLen) {
        lastSavesLen = s.saves.length;
        bridge?.postEvent({
          kind: "setSaves",
          saves: s.saves.map((sv) => ({
            id: sv.id, name: sv.name, timestamp: sv.timestamp,
            thumbnailUrl: sv.thumbnailUrl, gridW: sv.gridW, gridH: sv.gridH,
          })),
        });
      }
    });
  },

  // --- Cleanup (hot-reload dispose) ---
  onDispose: () => {
    saves?.stop();
    saves = null;
    savesUnsub?.();
    savesUnsub = null;
    bridgeRef = null; // startGame() already disposed ctx.ui
  },

  // --- FPS polling ---
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
}).catch((e) => {
  console.error("[main] Fatal:", e);
});

// ── Helpers ──

function uiBridge(): PixiUiBridge | null {
  // ctx.ui is set by startGame before onReady; the action handler can fire
  // later, so resolve lazily through a module-scope reference set in onReady.
  return bridgeRef;
}

async function refreshSaves(): Promise<void> {
  if (!saves) return;
  try {
    const list = await saves.listSaves();
    useGameStore.getState().setSaves(list);
  } catch (e) {
    console.error("Failed to list saves:", e);
  }
}

async function handleSave(): Promise<void> {
  const r = useGameStore.getState().renderer;
  if (!r || !saves) return;
  try {
    const canvas = r.getCanvas();
    const thumb = await captureCanvasThumbnail(canvas);
    const { grids, fields, gridW, gridH } = r.snapshotGrids();
    const name = `Save ${new Date().toLocaleString()}`;
    await saves.saveGame(name, thumb, { gridW, gridH, grids, fields });
    await refreshSaves();
  } catch (e) {
    console.error("[save] Failed:", e);
  }
}

async function handleLoad(id: string): Promise<void> {
  if (!saves) return;
  try {
    await saves.loadAndRestore(id);
  } catch (e) {
    console.error("Failed to load:", e);
  }
}

async function handleDelete(id: string): Promise<void> {
  if (!saves) return;
  try {
    await saves.deleteSave(id);
    await refreshSaves();
  } catch (e) {
    console.error("Failed to delete save:", e);
  }
}
