import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "falling-sand",
  html: {
    title: "Falling Sand",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "canvas", id: "pixi-ui-canvas" },
      { type: "dom", id: "root" },
    ],
  },
  simPaths: [],
  rendererPaths: [],
  excludePaths: [],
});
