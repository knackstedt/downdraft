// DORMANT — Electron path retired; native-entry / dev-shell is the entry.
import { createDowndraftViteConfig } from "@downdraft/engine/app/vite";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "pixi-ui-demo",
  html: {
    title: "PixiUI Demo",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "canvas", id: "pixi-ui-canvas" },
      { type: "dom", id: "root" },
    ],
  },
});
