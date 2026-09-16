// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// Game UI is engine-native imui (`createGameUi` renderer module, mounted in
// onReady). State flows directly through the zustand store — no UiStatsSAB,
// postEvent, or postAction bridge.
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
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/module-devtools";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
import { NUM_LAYERS, PLAYER } from "./shared/sim-buffer";
import { useGameStore } from "./stores/game-store";
import { createFallingSandSaveSystem, type FallingSandSaveSystem } from "./stores/save-system";
import "./styles/globals.css";
import { createFallingSandUi } from "./ui/game-ui";

// Save lifecycle handle — created in onReady, stopped in onDispose.
let saves: FallingSandSaveSystem | null = null;

startGame({
  // --- Renderer + renderer-owned sim ---
  renderer: (canvas) => {
    const deterministic = (window as any).downdraft?.deterministic === true;
    return new FallingSandRenderer(canvas, deterministic);
  },
  // The renderer spawns + starts its own SandWorkerHost in init(); expose it
  // to the game context (SABs + event routing) without a duplicate worker.
  simFromRenderer: (r: FallingSandRenderer) => r.getWorkerHost() ?? undefined,

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

    // Engine-native game UI (imui) mounted on the renderer.
    renderer.useRendererModule(createFallingSandUi({
      onSave: () => handleSave(),
      onLoad: (id) => handleLoad(id),
      onDeleteSave: (id) => handleDelete(id),
      onRefreshSaves: () => refreshSaves(),
    }));

    // MCP automation tools (standard set).
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
    ];
    createMcpHarness({
      serverName: "downdraft-falling-sand-automation",
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

  },

  // --- Cleanup (hot-reload dispose) ---
  onDispose: () => {
    saves?.stop();
    saves = null;
  },

  // --- FPS polling ---
  onFpsUpdate: (fps) => useGameStore.getState().setFPS(fps),
}).catch((e) => {
  console.error("[main] Fatal:", e);
});

// ── Helpers ──

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
