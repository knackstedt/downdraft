// ============================================================================
// native-entry.ts — Bun-native entry point for falling-sand
//
// SDL window + wgpu-native via createNativeHost; the renderer spawns its own
// SandWorkerHost in init() and the imui UI module renders onto the game
// canvas — no Electron, no workers for UI.
//
// Run: draft dev --native  (or: bun run src/native-entry.ts)
// ============================================================================

import { startNativeGame } from "@downdraft/platform-native";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
import { useGameStore } from "./stores/game-store";
import { createFallingSandSaveSystem, type FallingSandSaveSystem } from "./stores/save-system";
import { createFallingSandUi } from "./ui/game-ui";

let saves: FallingSandSaveSystem | null = null;

async function refreshSaves(): Promise<void> {
  if (!saves) return;
  try {
    useGameStore.getState().setSaves(await saves.listSaves());
  } catch (e) {
    console.error("Failed to list saves:", e);
  }
}

await startNativeGame({
  title: "Falling Sand — Native",
  renderer: (surface) => new FallingSandRenderer(surface, false),
  onReady: async ({ renderer }) => {
    useGameStore.getState().setRenderer(renderer);
    useGameStore.getState().setReady(true);

    renderer.useRendererModule(createFallingSandUi({
      onSave: async () => {
        if (!saves) return;
        try {
          const { grids, fields, gridW, gridH } = renderer.snapshotGrids();
          await saves.saveGame(`Save ${new Date().toLocaleString()}`, null, { gridW, gridH, grids, fields });
          await refreshSaves();
        } catch (e) {
          console.error("[save] Failed:", e);
        }
      },
      onLoad: async (id) => { try { await saves?.loadAndRestore(id); } catch (e) { console.error("Failed to load:", e); } },
      onDeleteSave: async (id) => {
        try { await saves?.deleteSave(id); await refreshSaves(); } catch (e) { console.error("Failed to delete:", e); }
      },
      onRefreshSaves: () => refreshSaves(),
    }));

    // Save lifecycle (autosave interval + restore-on-start). Persistence is
    // file-based under native mode.
    saves = createFallingSandSaveSystem({
      snapshot: () => renderer.snapshotGrids(),
      restore: async (e) => renderer.loadSave(e.grids, e.fields, e.gridW, e.gridH),
      deterministic: false,
    });
    const restored = await saves.start();
    if (restored) console.log("[autosave] Restored last session");
  },
  onDispose: () => {
    saves?.stop();
    saves = null;
  },
}).catch((e) => {
  console.error("[native-entry] Fatal:", e);
  process.exit(1);
});
