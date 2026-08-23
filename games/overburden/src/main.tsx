import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { setupBlockheadsMcp } from "./mcp/setup";
import { BlockheadsRenderer } from "./renderer/blockheads-renderer";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

async function bootstrap(): Promise<void> {
  const root = createRoot(getOverlay(0));
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  const canvas = getCanvas(0);
  const deterministic = downdraft?.deterministic === true;

  const renderer = new BlockheadsRenderer(canvas);
  const ok = await renderer.init();
  if (!ok) {
    console.error("BlockheadsRenderer init failed");
    return;
  }

  useGameStore.getState().setRenderer(renderer);

  // Register MCP automation tools (capture_screenshot for e2e tests)
  setupBlockheadsMcp(() => useGameStore.getState().renderer as BlockheadsRenderer | null);

  // FPS polling for the UI
  const fpsInterval = setInterval(() => {
    useGameStore.getState().setFps(renderer.getFPS());
  }, 500);

  renderer.start();

  // In deterministic mode, pause the render loop. The simulation still ticks;
  // frames are only rendered on demand via captureScreenshot / renderOneFrame.
  // This saves CPU when running under SwiftShader software WebGPU.
  if (deterministic) {
    renderer.stop();
    console.log("[Renderer] Deterministic mode: render loop paused (on-demand rendering only)");
  }

  // Hot reload: dispose the old renderer before re-running bootstrap.
  if (import.meta.hot) {
    import.meta.hot.dispose(async () => {
      clearInterval(fpsInterval);
      await renderer.shutdown();
    });
  }

  // In deterministic mode, auto-start the game (skip title screen) for e2e tests.
  if (deterministic) {
    useGameStore.getState().setDeterministic(true);
    useGameStore.getState().setShowTitleScreen(false);
  }
}

bootstrap().catch((e) => {
  console.error("[main] Fatal:", e);
});
