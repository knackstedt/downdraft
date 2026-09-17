import { createDowndraftViteConfig } from "@downdraft/app/vite";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "falling-sand",
  html: {
    title: "Falling Sand",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "dom", id: "root" },
    ],
  },
  simPaths: [],
  rendererPaths: [],
  excludePaths: [],
});
