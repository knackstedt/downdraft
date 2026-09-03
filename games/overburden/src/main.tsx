// ============================================================================
// Renderer Entry Point — declarative GameModule + startGame()
//
// The shared GameModule (renderer, sim, UI, onReady, onDispose) lives in
// game-module.ts and is reused by mobile.tsx. This entry point adds
// desktop-only features: MCP and deterministic mode.
// ============================================================================

import { startGame } from "@downdraft/app/renderer";
import { overburdenModule } from "./game-module";
import { setupBlockheadsMcp } from "./mcp/setup";
import { BlockheadsRenderer } from "./renderer/blockheads-renderer";
import { useGameStore } from "./stores/game-store";

startGame({
  ...overburdenModule,

  // ── MCP (desktop-only) ──
  mcp: () => setupBlockheadsMcp(() => useGameStore.getState().renderer as BlockheadsRenderer | null),

  // ── Deterministic mode: pause the render loop + skip the title screen ──
  onDeterministic: (ctx) => {
    ctx.renderer.stop();
    console.log("[Renderer] Deterministic mode: render loop paused");
    useGameStore.getState().setDeterministic(true);
    useGameStore.getState().setShowTitleScreen(false);
  },
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
