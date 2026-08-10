import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { downdraft } from "@downdraft/app/renderer";
import { FallingSandRenderer } from "./renderer/falling-sand-renderer";
import { useGameStore } from "./stores/game-store";
import "./styles/globals.css";

async function bootstrap() {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    console.error("No canvas element found");
    return;
  }

  const deterministic = downdraft?.deterministic === true;

  const renderer = new FallingSandRenderer(canvas, deterministic);
  const ok = await renderer.init();
  if (!ok) {
    console.error("FallingSandRenderer init failed");
    return;
  }

  setInterval(() => {
    useGameStore.getState().setFPS(renderer.getFPS());
  }, 500);

  renderer.start();
}

bootstrap().catch((e) => {
  console.error("[main] Fatal:", e);
});
