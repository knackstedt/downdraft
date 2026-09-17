// ============================================================================
// native-entry.ts — Bun-native entry point for sandjongg
//
// SDL window + wgpu-native via startNativeGame; the renderer spawns its own
// SandjonggWorkerHost in init() and the imui UI renders onto the game canvas.
// The tile overlay canvas is a VirtualCanvas (Canvas2D → FreeType/stb).
//
// Run: draft dev --native  (or: bun run src/native-entry.ts)
// ============================================================================

import { startNativeGame } from "@downdraft/platform-native";
import { AutosaveManager } from "@downdraft/app/renderer";
import { SandjonggRenderer } from "./renderer/sandjongg-renderer";
import { refreshSaveAvailability } from "./save-load";
import { autosave, saveHighScore } from "./save-system";
import { useGameStore } from "./stores/game-store";
import { createSandjonggUi } from "./ui/game-ui";

let autosaveManager: AutosaveManager | null = null;
let hasSeenTiles = false;
let advanceTimer: ReturnType<typeof setTimeout> | null = null;
let advanceRetryTimer: ReturnType<typeof setTimeout> | null = null;

function clearAdvanceTimers(): void {
  if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
  if (advanceRetryTimer) { clearTimeout(advanceRetryTimer); advanceRetryTimer = null; }
}

await startNativeGame({
  title: "Sandjongg — Native",
  renderer: (surface) => {
    const tileCanvas = document.createElement("canvas") as any;
    tileCanvas.id = "sandjongg-tile-canvas";
    return new SandjonggRenderer(surface, tileCanvas);
  },
  onReady: ({ renderer }) => {
    useGameStore.getState().setRenderer(renderer);
    renderer.useRendererModule(createSandjonggUi());

    // Auto-advance to next level when the board is cleared (same logic as
    // game-module.tsx — see that file for the rationale).
    useGameStore.subscribe((s) => {
      if (s.tilesLeft > 0) hasSeenTiles = true;
      const shouldAdvance =
        s.tilesLeft === 0 && s.level > 0 && hasSeenTiles &&
        !s.showMainMenu && !s.showPauseMenu &&
        !s._pendingAdvance && !s._pendingNewGame && !s._pendingModeChange;
      if (shouldAdvance) {
        if (!advanceTimer) {
          advanceTimer = setTimeout(() => {
            advanceTimer = null;
            const cur = useGameStore.getState();
            if (cur.tilesLeft === 0 && !cur.showMainMenu && !cur.showPauseMenu) {
              cur.requestAdvance(cur.level + 1);
            }
          }, 2000);
        }
        if (!advanceRetryTimer) {
          advanceRetryTimer = setTimeout(() => {
            advanceRetryTimer = null;
            const cur = useGameStore.getState();
            if (cur.tilesLeft === 0) {
              console.warn("[sandjongg] auto-advance retry: tilesLeft still 0 after 6s");
              cur.requestAdvance(cur.level + 1);
            }
          }, 6000);
        }
      } else {
        clearAdvanceTimers();
      }
    });

    // Autosave (loading is deferred to the main menu's continue flow).
    autosaveManager = new AutosaveManager({
      deterministic: false,
      intervalMs: 3000,
      shouldSave: () => {
        const s = useGameStore.getState();
        if (s.paused || s.showMainMenu || s.showPauseMenu) return false;
        if (s.tilesLeft === 0 || s._pendingAdvance || s._pendingNewGame || s._pendingModeChange) return false;
        return true;
      },
      save: async () => {
        const s = useGameStore.getState();
        const { grid, fields, gridW, gridH } = renderer.snapshotGrid();
        const board = await renderer.getWorkerHost()?.getBoardState();
        if (s.highScore > 0) saveHighScore(s.mode, s.highScore);
        await autosave({
          gridW, gridH, grid, fields,
          score: s.score, level: s.level, combo: s.combo, highScore: s.highScore,
          board: board ?? null, mode: s.mode, tileset: s.tileset, tileTheme: s.tileTheme,
        });
      },
    });
    autosaveManager.start();

    // Startup: show the main menu and pause the sim.
    useGameStore.setState({ showMainMenu: true });
    renderer.getWorkerHost()?.pause();
    useGameStore.getState().setPaused(true);
    void refreshSaveAvailability();
  },
  onDispose: () => {
    autosaveManager?.stop();
    autosaveManager = null;
    clearAdvanceTimers();
    hasSeenTiles = false;
  },
}).catch((e) => {
  console.error("[native-entry] Fatal:", e);
  process.exit(1);
});
