import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import { type IDevToolsDataRenderer } from "@downdraft/plugin-devtools";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { MiningDevToolsBridge } from "./devtools/devtools-bridge";
import { MiningRenderer } from "./renderer/mining-renderer";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

async function bootstrap() {
  const root = createRoot(getOverlay(0));
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  const canvas = getCanvas(0);
  const deterministic = downdraft?.deterministic === true;

  const renderer = new MiningRenderer(canvas, deterministic);
  const ok = await renderer.init();
  if (!ok) {
    console.error("MiningRenderer init failed");
    return;
  }

  useGameStore.getState().setRenderer(renderer);

  const dataRenderer: IDevToolsDataRenderer = {
    getFPS: () => renderer.getFPS(),
  };
  const devtoolsBridge = new MiningDevToolsBridge(renderer);
  devtoolsBridge.init(dataRenderer);

  const fpsInterval = setInterval(() => {
    useGameStore.getState().setFPS(renderer.getFPS());
  }, 500);

  renderer.start();

  // Hot reload: dispose the old renderer before re-running bootstrap.
  if (import.meta.hot) {
    import.meta.hot.dispose(async () => {
      clearInterval(fpsInterval);
      await renderer.stop();
    });
  }
}

bootstrap().catch((e) => {
  console.error("[main] Fatal:", e);
});
