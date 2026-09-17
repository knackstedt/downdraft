// ============================================================================
// native-entry.ts — Bun-native entry point for overburden
//
// SDL window + wgpu-native via startNativeGame; the renderer spawns its own
// BlockheadsWorkerHost in init(). The PixiJS worker UI is desktop-only for
// now — native mode runs the sim + renderer without the menu overlay.
//
// Run: draft dev --native  (or: bun run src/native-entry.ts)
// ============================================================================

import { startNativeGame } from "@downdraft/platform-native";
import { BlockheadsRenderer } from "./renderer/blockheads-renderer";
import { useGameStore } from "./stores/game-store";

await startNativeGame({
  title: "Overburden — Native",
  renderer: (surface) => new BlockheadsRenderer(surface),
  onReady: ({ renderer }) => {
    useGameStore.getState().setRenderer(renderer);
    // Skip the title screen — no UI overlay in native mode yet.
    useGameStore.getState().setShowTitleScreen(false);
  },
}).catch((e) => {
  console.error("[native-entry] Fatal:", e);
  process.exit(1);
});
