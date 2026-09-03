import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

const root = resolve("/home/knackstedt/Pivot/source/apophis/downdraft-engine/games/sandjongg");
const repoRoot = resolve(root, "../..");

const coreAliases = [
  { find: /^@downdraft\/core$/, replacement: resolve(repoRoot, "packages/core/src/index.ts") },
  { find: /^@downdraft\/core\//, replacement: resolve(repoRoot, "packages/core/src") + "/" },
];

const rendererAliases = [
  { find: "@renderer", replacement: resolve(root, "src") },
  { find: "@shared", replacement: resolve(root, "src/shared") },
  { find: "@sim", replacement: resolve(root, "src/simulation") },
  ...coreAliases,
  { find: /^@downdraft\/ui$/, replacement: resolve(repoRoot, "packages/ui/src/index.ts") },
  { find: /^@downdraft\/ui\//, replacement: resolve(repoRoot, "packages/ui/src") + "/" },
  { find: /^@downdraft\/shader-graph$/, replacement: resolve(repoRoot, "packages/shader-graph/src/index.ts") },
  { find: /^@downdraft\/shader-graph\//, replacement: resolve(repoRoot, "packages/shader-graph/src") + "/" },
  { find: /^@downdraft\/library-persistence\/browser$/, replacement: resolve(repoRoot, "packages/libraries/persistence/src/browser.ts") },
  { find: /^@downdraft\/library-persistence$/, replacement: resolve(repoRoot, "packages/libraries/persistence/src/browser.ts") },
  { find: /^@downdraft\/library-persistence\//, replacement: resolve(repoRoot, "packages/libraries/persistence/src") + "/" },
  { find: /^@downdraft\/library-postfx$/, replacement: resolve(repoRoot, "packages/libraries/postfx/src/index.ts") },
  { find: /^@downdraft\/library-postfx\//, replacement: resolve(repoRoot, "packages/libraries/postfx/src") + "/" },
  { find: /^@downdraft\/library-sand$/, replacement: resolve(repoRoot, "packages/libraries/sand/src/index.ts") },
  { find: /^@downdraft\/library-sand\//, replacement: resolve(repoRoot, "packages/libraries/sand/src") + "/" },
  { find: /^@downdraft\/library-lighting$/, replacement: resolve(repoRoot, "packages/libraries/lighting/src/index.ts") },
  { find: /^@downdraft\/library-lighting\//, replacement: resolve(repoRoot, "packages/libraries/lighting/src") + "/" },
  { find: /^@downdraft\/library-weatherfx$/, replacement: resolve(repoRoot, "packages/libraries/weatherfx/src/index.ts") },
  { find: /^@downdraft\/library-weatherfx\//, replacement: resolve(repoRoot, "packages/libraries/weatherfx/src") + "/" },
  { find: /^@downdraft\/library-weather$/, replacement: resolve(repoRoot, "packages/libraries/weather/src/index.ts") },
  { find: /^@downdraft\/library-weather\//, replacement: resolve(repoRoot, "packages/libraries/weather/src") + "/" },
  { find: /^@downdraft\/library-imui$/, replacement: resolve(repoRoot, "packages/libraries/imui/src/index.ts") },
  { find: /^@downdraft\/library-imui\//, replacement: resolve(repoRoot, "packages/libraries/imui/src") + "/" },
  { find: /^@downdraft\/library-animation$/, replacement: resolve(repoRoot, "packages/libraries/animation/src/index.ts") },
  { find: /^@downdraft\/library-animation\//, replacement: resolve(repoRoot, "packages/libraries/animation/src") + "/" },
  { find: /^@downdraft\/library-particles$/, replacement: resolve(repoRoot, "packages/libraries/particles/src/index.ts") },
  { find: /^@downdraft\/library-particles\//, replacement: resolve(repoRoot, "packages/libraries/particles/src") + "/" },
  { find: /^@downdraft\/library-entities$/, replacement: resolve(repoRoot, "packages/libraries/entities/src/index.ts") },
  { find: /^@downdraft\/library-entities\//, replacement: resolve(repoRoot, "packages/libraries/entities/src") + "/" },
  { find: /^@downdraft\/library-stickman$/, replacement: resolve(repoRoot, "packages/libraries/stickman/src/index.ts") },
  { find: /^@downdraft\/library-stickman\//, replacement: resolve(repoRoot, "packages/libraries/stickman/src") + "/" },
  { find: /^@downdraft\/library-models$/, replacement: resolve(repoRoot, "packages/libraries/models/src/index.ts") },
  { find: /^@downdraft\/library-models\//, replacement: resolve(repoRoot, "packages/libraries/models/src") + "/" },
  { find: /^@downdraft\/plugin-devtools$/, replacement: resolve(repoRoot, "packages/plugins/devtools/src/index.ts") },
  { find: /^@downdraft\/plugin-devtools\//, replacement: resolve(repoRoot, "packages/plugins/devtools/src") + "/" },
  { find: /^@downdraft\/plugin-terrain$/, replacement: resolve(repoRoot, "packages/plugins/terrain/src/index.ts") },
  { find: /^@downdraft\/plugin-terrain\//, replacement: resolve(repoRoot, "packages/plugins/terrain/src") + "/" },
  { find: /^@downdraft\/plugin-movement-3d$/, replacement: resolve(repoRoot, "packages/plugins/movement-3d/src/index.ts") },
  { find: /^@downdraft\/plugin-movement-3d\//, replacement: resolve(repoRoot, "packages/plugins/movement-3d/src") + "/" },
  { find: /^@downdraft\/plugin-movement-2d$/, replacement: resolve(repoRoot, "packages/plugins/movement-2d/src/index.ts") },
  { find: /^@downdraft\/plugin-movement-2d\//, replacement: resolve(repoRoot, "packages/plugins/movement-2d/src") + "/" },
  { find: /^@downdraft\/plugin-sailing$/, replacement: resolve(repoRoot, "packages/plugins/sailing/src/index.ts") },
  { find: /^@downdraft\/plugin-sailing\//, replacement: resolve(repoRoot, "packages/plugins/sailing/src") + "/" },
  { find: /^@downdraft\/plugin-camera-controls$/, replacement: resolve(repoRoot, "packages/plugins/camera-controls/src/index.ts") },
  { find: /^@downdraft\/plugin-camera-controls\//, replacement: resolve(repoRoot, "packages/plugins/camera-controls/src") + "/" },
  { find: /^node:fs$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/fs.ts") },
  { find: /^fs$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/fs.ts") },
  { find: /^node:path$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/path.ts") },
  { find: /^path$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/path.ts") },
  { find: /^@downdraft\/library-marching-cubes$/, replacement: resolve(repoRoot, "packages/libraries/marching-cubes/src/index.ts") },
  { find: /^@downdraft\/library-marching-cubes\//, replacement: resolve(repoRoot, "packages/libraries/marching-cubes/src") + "/" },
  { find: /^@downdraft\/library-navmesh$/, replacement: resolve(repoRoot, "packages/libraries/navmesh/src/index.ts") },
  { find: /^@downdraft\/library-navmesh\//, replacement: resolve(repoRoot, "packages/libraries/navmesh/src") + "/" },
  { find: /^@downdraft\/library-water$/, replacement: resolve(repoRoot, "packages/libraries/water/src/index.ts") },
  { find: /^@downdraft\/library-water\//, replacement: resolve(repoRoot, "packages/libraries/water/src") + "/" },
  { find: /^@downdraft\/mcp$/, replacement: resolve(repoRoot, "packages/mcp/src/index.ts") },
  { find: /^@downdraft\/mcp\//, replacement: resolve(repoRoot, "packages/mcp/src") + "/" },
  { find: /^@downdraft\/plugin-electron-osr$/, replacement: resolve(repoRoot, "packages/plugins/electron-osr/src/index.ts") },
  { find: /^@downdraft\/plugin-electron-osr\//, replacement: resolve(repoRoot, "packages/plugins/electron-osr/src") + "/" },
  { find: /^@downdraft\/app\/renderer$/, replacement: resolve(repoRoot, "packages/app/src/renderer/index.ts") },
  { find: /^@downdraft\/app\/renderer\/downdraft-base\.css$/, replacement: resolve(repoRoot, "packages/app/src/renderer/downdraft-base.css") },
  { find: /^@downdraft\/app\/shared$/, replacement: resolve(repoRoot, "packages/app/src/shared/index.ts") },
  { find: /^@downdraft\/app\/mobile$/, replacement: resolve(repoRoot, "packages/app/src/mobile/index.ts") },
  { find: /^@downdraft\/app$/, replacement: resolve(repoRoot, "packages/app/src/index.ts") },
  { find: /^@capacitor\/app$/, replacement: resolve(root, "stubs/@capacitor/app.ts") },
  { find: /^@capacitor\/browser$/, replacement: resolve(root, "stubs/@capacitor/browser.ts") },
];

// Generate index.html with mobile entry
import { writeFileSync } from "fs";
writeFileSync(resolve(root, "index.html"), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Sandjongg — SAB Polyfill Test</title>
  <style>
    html, body { margin: 0; padding: 0; overflow: hidden; background: #0a0a12; }
    canvas { display: block; width: 100vw; height: 100vh; }
    #root { position: absolute; inset: 0; pointer-events: none; z-index: 100; }
  </style>
</head>
<body>
  <canvas id="game-canvas"></canvas>
  <div id="root"></div>
  <script type="module" src="/src/mobile.tsx"></script>
</body>
</html>
`);

export default defineConfig({
  root,
  server: {
    port: 5174,
    headers: {}, // NO COOP/COEP — SAB unavailable → polyfill activates
  },
  resolve: {
    alias: rendererAliases,
    dedupe: ["react", "react-dom"],
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@bokuweb/zstd-wasm"] },
  plugins: [react()],
});
