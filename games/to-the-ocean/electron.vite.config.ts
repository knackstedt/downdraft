import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";

const repoRoot = resolve(__dirname, "../..");

// @to-the-ocean game plugin aliases — game-owned, depend on engine.
// Registered here (not in the engine Vite config) so the engine stays
// decoupled from any specific game's plugin layout.
const toTheOceanAliases = [
  { find: /^@to-the-ocean\/library-boats$/, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/boats/src/index.ts") },
  { find: /^@to-the-ocean\/library-boats\//, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/boats/src") + "/" },
  { find: /^@to-the-ocean\/module-buoyancy$/, replacement: resolve(repoRoot, "games/to-the-ocean/modules/buoyancy/src/index.ts") },
  { find: /^@to-the-ocean\/module-buoyancy\//, replacement: resolve(repoRoot, "games/to-the-ocean/modules/buoyancy/src") + "/" },
  { find: /^@to-the-ocean\/module-collision$/, replacement: resolve(repoRoot, "games/to-the-ocean/modules/collision/src/index.ts") },
  { find: /^@to-the-ocean\/module-collision\//, replacement: resolve(repoRoot, "games/to-the-ocean/modules/collision/src") + "/" },
  { find: /^@to-the-ocean\/module-crafting$/, replacement: resolve(repoRoot, "games/to-the-ocean/modules/crafting/src/index.ts") },
  { find: /^@to-the-ocean\/module-crafting\//, replacement: resolve(repoRoot, "games/to-the-ocean/modules/crafting/src") + "/" },
  { find: /^@to-the-ocean\/library-economy$/, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/economy/src/index.ts") },
  { find: /^@to-the-ocean\/library-economy\//, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/economy/src") + "/" },
  { find: /^@to-the-ocean\/library-fishing$/, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/fishing/src/index.ts") },
  { find: /^@to-the-ocean\/library-fishing\//, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/fishing/src") + "/" },
  { find: /^@to-the-ocean\/module-inventory$/, replacement: resolve(repoRoot, "games/to-the-ocean/modules/inventory/src/index.ts") },
  { find: /^@to-the-ocean\/module-inventory\//, replacement: resolve(repoRoot, "games/to-the-ocean/modules/inventory/src") + "/" },
  { find: /^@to-the-ocean\/library-items$/, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/items/src/index.ts") },
  { find: /^@to-the-ocean\/library-items\//, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/items/src") + "/" },
  { find: /^@to-the-ocean\/library-survival$/, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/survival/src/index.ts") },
  { find: /^@to-the-ocean\/library-survival\//, replacement: resolve(repoRoot, "games/to-the-ocean/libraries/survival/src") + "/" },
  { find: /^@to-the-ocean\/module-wildlife$/, replacement: resolve(repoRoot, "games/to-the-ocean/modules/wildlife/src/index.ts") },
  { find: /^@to-the-ocean\/module-wildlife\//, replacement: resolve(repoRoot, "games/to-the-ocean/modules/wildlife/src") + "/" },
  { find: /^@to-the-ocean\/util\//, replacement: resolve(repoRoot, "games/to-the-ocean/src/util") + "/" },
];

export default createDowndraftViteConfig({
  root: __dirname,
  game: "to-the-ocean",
  rendererAliases: toTheOceanAliases,
  // to-the-ocean has a sim worker — simPaths trigger worker swap (with ack).
  // Append our own plugin dir to the engine defaults.
  simPaths: [
    "simulation/",
    "shared/",
    "packages/core/",
    "packages/modules/",
    "packages/libraries/",
    "games/to-the-ocean/libraries/",
    "games/to-the-ocean/modules/",
  ],
  // These plugin dirs are sim-side only — exclude from renderer HMR to avoid
  // spurious full reloads.
  excludePaths: [
    "packages/modules/electron-osr/src/main/",
    "simulation/ecs/ecs-",
    "games/to-the-ocean/modules/wildlife/src/",
    "games/to-the-ocean/modules/buoyancy/src/",
    "games/to-the-ocean/modules/collision/src/",
  ],
  html: {
    title: "To The Ocean",
    layers: [
      { type: "canvas", id: "game-canvas" },
      { type: "canvas", id: "pixi-ui-canvas" },
      { type: "dom", id: "root" },
    ],
  },
  workerPlugins: [react()],
});
