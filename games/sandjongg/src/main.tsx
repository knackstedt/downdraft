// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// The shared GameModule (renderer, sim, UI, onReady) lives in game-module.ts
// and is reused by mobile.tsx. This entry point adds desktop-only features:
// devtools, MCP, and deterministic mode.
// ============================================================================

import { startGame } from "@downdraft/app/renderer";
import { createSimStatsPanelExtension, createSimStatsProvider } from "@downdraft/module-devtools";
import { sandjonggModule } from "./game-module";
import { setupSandjonggMcp } from "./mcp/setup";
import { useGameStore } from "./stores/game-store";

startGame({
  ...sandjonggModule,

  // ── DevTools (desktop-only) ──
  devtools: {
    createSimStatsProvider: (renderer) => createSimStatsProvider({
      getWorkerHost: () => renderer.getWorkerHost(),
      getStorePaused: () => useGameStore.getState().paused,
      setStorePaused: (paused) => useGameStore.getState().setPaused(paused),
      clearSim: () => renderer.getWorkerHost()?.requestClearSand(),
      getExtra: () => {
        const store = useGameStore.getState();
        return {
          grid: `${renderer.getGridW()}x${renderer.getGridH()}`,
          renderFPS: renderer.getFPS(),
          score: store.score,
          level: store.level,
          tilesLeft: store.tilesLeft,
          combo: store.combo,
        };
      },
    }),
    panels: [
      createSimStatsPanelExtension({
        extraRows: (stats) => {
          const extra = stats.extra as any;
          if (!extra) return [];
          return [
            ["Grid", extra.grid ?? "—"],
            ["Render FPS", String(extra.renderFPS ?? "—")],
            ["Score", String(extra.score ?? "—")],
            ["Level", String(extra.level ?? "—")],
            ["Tiles Left", String(extra.tilesLeft ?? "—")],
            ["Combo", String(extra.combo ?? "—")],
          ] as [string, string][];
        },
      }),
    ],
  },

  // ── MCP (desktop-only) ──
  mcp: () => setupSandjonggMcp(() => useGameStore.getState().renderer),

  // ── Deterministic mode: skip the main menu and boot straight in ──
  onDeterministic: (ctx) => {
    // E2E / deterministic mode: skip the main menu and boot straight into
    // the default sandjongg mode so existing smoke tests keep working. The
    // worker has already generated level 1 in sandjongg mode at init.
    // In deterministic mode, skip high score load (per-mode loads happen on
    // mode select in save-load.ts).
    useGameStore.setState({ showMainMenu: false, mode: "sandjongg" });
  },
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
