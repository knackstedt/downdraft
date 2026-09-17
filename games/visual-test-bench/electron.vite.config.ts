import { createDowndraftViteConfig } from "@downdraft/app/vite";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "visual-test-bench",
  html: {
    title: "Downdraft Visual Test Bench",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "dom", id: "root" },
    ],
  },
});
