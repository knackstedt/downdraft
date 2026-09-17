import react from "@vitejs/plugin-react";
import { createDowndraftViteConfig } from "@downdraft/app/vite";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "mining-rpg",
  html: {
    title: "Mining RPG",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "canvas", id: "pixi-ui-canvas" },
      { type: "dom", id: "root" },
    ],
  },
  workerPlugins: [react()],
});
