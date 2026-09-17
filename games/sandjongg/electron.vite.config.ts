import { createDowndraftViteConfig } from "@downdraft/app/vite";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "sandjongg",
  html: {
    title: "Sandjongg",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "dom", id: "root" },
    ],
  },
  simPaths: [],
  rendererPaths: [],
  excludePaths: [],
});
