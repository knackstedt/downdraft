import { downdraft, getCanvas, getOverlay } from "@downdraft/app/renderer";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
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

  const renderer = new FallingSandRenderer(canvas, deterministic);
  const ok = await renderer.init();
  if (!ok) {
    console.error("FallingSandRenderer init failed");
    return;
  }

  useGameStore.getState().setRenderer(renderer);

  setInterval(() => {
    useGameStore.getState().setFPS(renderer.getFPS());
  }, 500);

  renderer.start();
}

bootstrap().catch((e) => {
  console.error("[main] Fatal:", e);
});
