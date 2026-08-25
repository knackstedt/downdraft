import { bootstrapGame } from "@downdraft/app/renderer";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { setupBlockheadsMcp } from "./mcp/setup";
import { BlockheadsRenderer } from "./renderer/blockheads-renderer";
import { getSeasonInfo } from "./simulation/season-system";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

bootstrapGame({
  // --- UI (React) ---
  mountUI: (overlay) => {
    const root = createRoot(overlay);
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  },

  // --- Renderer ---
  createRenderer: (canvas) => new BlockheadsRenderer(canvas),
  initRenderer: (renderer) => renderer.init(),
  onRendererInit: (renderer) => {
    useGameStore.getState().setRenderer(renderer);
  },

  // --- MCP ---
  mcp: () => setupBlockheadsMcp(() => useGameStore.getState().renderer as BlockheadsRenderer | null),

  // --- FPS + season polling ---
  onFpsUpdate: (fps) => {
    if (useGameStore.getState().fps !== fps) {
      useGameStore.getState().setFps(fps);
    }
    // Poll the current season from the sim tick (deterministic from tick count)
    const renderer = useGameStore.getState().renderer as BlockheadsRenderer | null;
    const simReader = renderer?.getSimReader();
    if (simReader) {
      const tick = simReader.getTick();
      const info = getSeasonInfo(tick);
      const prev = useGameStore.getState();
      if (prev.season !== info.season || prev.dayInSeason !== info.dayInSeason || prev.year !== info.year) {
        useGameStore.getState().setSeasonInfo(info.season, info.dayInSeason, info.year);
      }
    }
  },

  // --- Hot reload ---
  onHotReloadDispose: async () => {
    const renderer = useGameStore.getState().renderer as BlockheadsRenderer | null;
    if (renderer) await renderer.shutdown();
  },

  // --- Deterministic mode: pause render loop + skip title screen ---
  onDeterministic: (renderer) => {
    // Pause the render loop. The simulation still ticks; frames are only
    // rendered on demand via captureScreenshot / renderOneFrame.
    // This saves CPU when running under SwiftShader software WebGPU.
    renderer.stop();
    console.log("[Renderer] Deterministic mode: render loop paused (on-demand rendering only)");
    useGameStore.getState().setDeterministic(true);
    useGameStore.getState().setShowTitleScreen(false);
  },
}).catch((e) => {
  console.error("[main] Fatal:", e);
});
