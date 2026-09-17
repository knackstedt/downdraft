// ============================================================================
// native-entry.ts — Bun-native entry point for andrews-sandbox
//
// SDL window + wgpu-native via startNativeGame. Boots the WebGPURenderer +
// entity sim worker with the minimal wiring needed to run; the PixiJS
// worker UI, plugin host, VR, and game controllers are desktop-only for now.
//
// Run: draft dev --native  (or: bun run src/native-entry.ts)
// ============================================================================

import { startNativeGame } from "@downdraft/platform-native";
import { SimWebWorker, type SimWebWorkerConfig } from "./engine/sim-web-worker";
import { WebGPURenderer } from "./engine/webgpu-renderer";
import { useGameStore } from "./stores/game-store";

let sim: SimWebWorker | null = null;

await startNativeGame({
  title: "Andrews Sandbox — Native",
  renderer: (surface) => new WebGPURenderer(surface),
  onReady: async ({ renderer }) => {
    // Spawn + init the entity sim worker.
    sim = new SimWebWorker();
    const config: SimWebWorkerConfig = { seed: 12345, isDev: true };
    await sim.start(config);

    // Wire the sim/input SABs into the renderer.
    (renderer as WebGPURenderer).setSimReader(sim.getSimBuffer());
    (renderer as WebGPURenderer).setInputWriter(sim.getInputBuffer());
    (renderer as any).setupInputListeners?.();

    const gs = useGameStore.getState();
    gs.setRenderer(renderer);
    gs.setReady(true);
    gs.setSimReady(true);
    gs.setIsDev(true);
  },
  onDispose: () => {
    try { sim?.stop?.(); } catch {}
    sim = null;
  },
}).catch((e) => {
  console.error("[native-entry] Fatal:", e);
  process.exit(1);
});
