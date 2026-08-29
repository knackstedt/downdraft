// Temporary Vite config for testing the SAB polyfill locally.
// Uses the real createDowndraftViteConfig (with React plugin + all aliases)
// but overrides the HTML entry to mobile.tsx and removes COOP/COEP headers
// so SharedArrayBuffer is unavailable and the polyfill activates.
//
// Usage: npx electron-vite dev --config games/sandjongg/vite.polyfill-test.config.ts
// Then open http://localhost:5173 in a WebGPU-capable browser (Chrome/Edge).
//
// Delete this file after testing is complete.

import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "sandjongg",
  html: {
    title: "Sandjongg — SAB Polyfill Test",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "dom", id: "root" },
    ],
    // Use the mobile entry instead of main.tsx — this imports the SAB polyfill
    entry: "/src/mobile.tsx",
  },
  simPaths: [],
  rendererPaths: [],
  excludePaths: [],
  // Override renderer config to remove COOP/COEP headers (so SAB is unavailable)
  rendererPlugins: [
    {
      name: "remove-coop-coep",
      config(config) {
        if (config.server?.headers) {
          delete (config.server.headers as any)["Cross-Origin-Opener-Policy"];
          delete (config.server.headers as any)["Cross-Origin-Embedder-Policy"];
        }
      },
    },
  ],
});
