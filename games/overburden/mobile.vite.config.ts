import react from "@vitejs/plugin-react";
import { createDowndraftMobileViteConfig } from "../../packages/app/src/vite/mobile-vite-config";

export default createDowndraftMobileViteConfig({
  root: __dirname,
  game: "overburden",
  html: {
    title: "Overburden",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "canvas", id: "pixi-ui-canvas" },
      { type: "dom", id: "root" },
    ],
  },
  workerPlugins: [react()],
});
