import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";

const repoRoot = resolve(__dirname, "../..");

// @andrews-sandbox game library/module aliases — game-owned, depend on engine.
// Registered here (not in the engine Vite config) so the engine stays
// decoupled from any specific game's plugin layout.
const andrewsSandboxAliases = [
  { find: "@sandbox/shared", replacement: resolve(repoRoot, "games/andrews-sandbox/src/shared") },
  { find: /^@andrews-sandbox\/library-props$/, replacement: resolve(repoRoot, "games/andrews-sandbox/libraries/props/src/index.ts") },
  { find: /^@andrews-sandbox\/library-props\//, replacement: resolve(repoRoot, "games/andrews-sandbox/libraries/props/src") + "/" },
  { find: /^@andrews-sandbox\/library-paint$/, replacement: resolve(repoRoot, "games/andrews-sandbox/libraries/paint/src/index.ts") },
  { find: /^@andrews-sandbox\/library-paint\//, replacement: resolve(repoRoot, "games/andrews-sandbox/libraries/paint/src") + "/" },
  { find: /^@andrews-sandbox\/library-content$/, replacement: resolve(repoRoot, "games/andrews-sandbox/libraries/content/src/index.ts") },
  { find: /^@andrews-sandbox\/library-content\//, replacement: resolve(repoRoot, "games/andrews-sandbox/libraries/content/src") + "/" },
  { find: /^@andrews-sandbox\/module-spawn$/, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/spawn/src/index.ts") },
  { find: /^@andrews-sandbox\/module-spawn\//, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/spawn/src") + "/" },
  { find: /^@andrews-sandbox\/module-physics-props$/, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/physics-props/src/index.ts") },
  { find: /^@andrews-sandbox\/module-physics-props\//, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/physics-props/src") + "/" },
  { find: /^@andrews-sandbox\/module-weapons$/, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/weapons/src/index.ts") },
  { find: /^@andrews-sandbox\/module-weapons\//, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/weapons/src") + "/" },
  { find: /^@andrews-sandbox\/module-paint$/, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/paint/src/index.ts") },
  { find: /^@andrews-sandbox\/module-paint\//, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/paint/src") + "/" },
  { find: /^@andrews-sandbox\/module-content$/, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/content/src/index.ts") },
  { find: /^@andrews-sandbox\/module-content\//, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/content/src") + "/" },
  { find: /^@andrews-sandbox\/module-vr$/, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/vr/src/index.ts") },
  { find: /^@andrews-sandbox\/module-vr\//, replacement: resolve(repoRoot, "games/andrews-sandbox/modules/vr/src") + "/" },
];

export default createDowndraftViteConfig({
  root: __dirname,
  game: "andrews-sandbox",
  rendererAliases: andrewsSandboxAliases,
  // Disable asset baking — @downdraft/asset-bake is not installed and Kenney
  // GLBs are public-domain, use only KHR_materials_unlit/KHR_texture_transform
  // (no Draco/meshopt), so they can be served directly without baking.
  assetBake: false,
  // andrews-sandbox has a sim worker — simPaths trigger worker swap (with ack).
  simPaths: [
    "shared/",
    "packages/core/",
    "packages/modules/",
    "packages/libraries/",
    "games/andrews-sandbox/libraries/",
    "games/andrews-sandbox/modules/",
  ],
  // Sim-side only modules — exclude from renderer HMR to avoid spurious reloads.
  excludePaths: [
    "games/andrews-sandbox/modules/physics-props/src/",
    "games/andrews-sandbox/modules/spawn/src/spawn-system.ts",
  ],
  html: {
    title: "Andrew's Sandbox",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "canvas", id: "pixi-ui-canvas", attrs: { "data-dd-layer": "1" } },
      { type: "dom", id: "root" },
    ],
  },
  workerPlugins: [react()],
});
