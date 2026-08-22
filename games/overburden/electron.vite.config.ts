import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "overburden",
  html: {
    title: "Overburden",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "dom", id: "root" },
    ],
  },
  simPaths: [],
  rendererPaths: [],
  excludePaths: [],
});
