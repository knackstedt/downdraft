import react from "@vitejs/plugin-react";
import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "mining-rpg",
  html: {
    title: "Mining RPG",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "canvas", id: "pixi-ui-canvas", layer: 1 },
      { type: "dom", id: "root" },
    ],
  },
  workerPlugins: [react()],
});
