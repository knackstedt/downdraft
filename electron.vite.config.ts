import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "path";
import { hotReloadPlugin } from "./packages/core/src/vite/hot-reload-plugin";

import { existsSync } from "node:fs";

const game = process.env.DOWNDRAFT_GAME;
const rendererRoot = game
  ? (existsSync(resolve("games", game)) ? resolve("games", game) : resolve("examples", game))
  : resolve("packages/app");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@dimforge/rapier3d-compat"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve("packages/app/src/main/index.ts"),
          "db-worker": resolve("packages/app/src/main/db-worker.ts"),
        },
        output: {
          entryFileNames: "[name].js",
        },
      },
    } as any,
    resolve: {
      alias: [
        { find: "@main", replacement: resolve("packages/app/src/main") },
        { find: "@shared", replacement: resolve("packages/app/src/shared") },
        { find: /^@downdraft\/core$/, replacement: resolve("packages/core/src/index.ts") },
        { find: /^@downdraft\/core\//, replacement: resolve("packages/core/src") + "/" },
        { find: /^@downdraft\/mcp\//, replacement: resolve("packages/mcp/src") + "/" },
        { find: /^@downdraft\/mcp$/, replacement: resolve("packages/mcp/src/index.ts") },
        { find: /^@downdraft\/shader-graph$/, replacement: resolve("packages/shader-graph/src/index.ts") },
        { find: /^@downdraft\/shader-graph\//, replacement: resolve("packages/shader-graph/src") + "/" },
      ],
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: "force-cjs-preload",
        configResolved(config) {
          const output = config.build.rollupOptions.output;
          const out = Array.isArray(output) ? output[0] : output;
          if (out) {
            out.format = "cjs";
            out.entryFileNames = "[name].cjs";
          }
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve("packages/app/src/preload/index.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    } as any,
    resolve: {
      alias: {
        "@shared": resolve("packages/app/src/shared"),
      },
    },
  },
  renderer: {
    root: rendererRoot,
    resolve: {
      alias: [
        { find: "@renderer", replacement: resolve(rendererRoot, "src") },
        { find: "@shared", replacement: game ? resolve(rendererRoot, "src/shared") : resolve("packages/app/src/shared") },
        { find: "@sim", replacement: resolve(rendererRoot, "src/simulation") },
        { find: /^@downdraft\/core$/, replacement: resolve("packages/core/src/index.ts") },
        { find: /^@downdraft\/core\//, replacement: resolve("packages/core/src") + "/" },
        { find: /^@downdraft\/ui$/, replacement: resolve("packages/ui/src/index.ts") },
        { find: /^@downdraft\/ui\//, replacement: resolve("packages/ui/src") + "/" },
        { find: /^@downdraft\/shader-graph$/, replacement: resolve("packages/shader-graph/src/index.ts") },
        { find: /^@downdraft\/shader-graph\//, replacement: resolve("packages/shader-graph/src") + "/" },
        { find: /^@downdraft\/plugin-postfx$/, replacement: resolve("packages/plugins/postfx/src/index.ts") },
        { find: /^@downdraft\/plugin-postfx\//, replacement: resolve("packages/plugins/postfx/src") + "/" },
        { find: /^@downdraft\/plugin-lighting$/, replacement: resolve("packages/plugins/lighting/src/index.ts") },
        { find: /^@downdraft\/plugin-lighting\//, replacement: resolve("packages/plugins/lighting/src") + "/" },
        { find: /^@downdraft\/plugin-weatherfx$/, replacement: resolve("packages/plugins/weatherfx/src/index.ts") },
        { find: /^@downdraft\/plugin-weatherfx\//, replacement: resolve("packages/plugins/weatherfx/src") + "/" },
        { find: /^@downdraft\/plugin-weather$/, replacement: resolve("packages/plugins/weather/src/index.ts") },
        { find: /^@downdraft\/plugin-weather\//, replacement: resolve("packages/plugins/weather/src") + "/" },
        { find: /^@downdraft\/plugin-entities$/, replacement: resolve("packages/plugins/entities/src/index.ts") },
        { find: /^@downdraft\/plugin-entities\//, replacement: resolve("packages/plugins/entities/src") + "/" },
        { find: /^@downdraft\/plugin-models$/, replacement: resolve("packages/plugins/models/src/index.ts") },
        { find: /^@downdraft\/plugin-models\//, replacement: resolve("packages/plugins/models/src") + "/" },
        { find: /^@downdraft\/plugin-devtools$/, replacement: resolve("packages/plugins/devtools/src/index.ts") },
        { find: /^@downdraft\/plugin-devtools\//, replacement: resolve("packages/plugins/devtools/src") + "/" },
        { find: /^node:fs$/, replacement: resolve("packages/app/src/renderer-shims/fs.ts") },
        { find: /^fs$/, replacement: resolve("packages/app/src/renderer-shims/fs.ts") },
        { find: /^@downdraft\/plugin-marching-cubes$/, replacement: resolve("packages/plugins/marching-cubes/src/index.ts") },
        { find: /^@downdraft\/plugin-marching-cubes\//, replacement: resolve("packages/plugins/marching-cubes/src") + "/" },
        { find: /^@downdraft\/plugin-navmesh$/, replacement: resolve("packages/plugins/navmesh/src/index.ts") },
        { find: /^@downdraft\/plugin-navmesh\//, replacement: resolve("packages/plugins/navmesh/src") + "/" },
        { find: /^@downdraft\/plugin-water$/, replacement: resolve("packages/plugins/water/src/index.ts") },
        { find: /^@downdraft\/plugin-water\//, replacement: resolve("packages/plugins/water/src") + "/" },
        { find: /^@downdraft\/plugin-fishing$/, replacement: resolve("packages/plugins/fishing/src/index.ts") },
        { find: /^@downdraft\/plugin-fishing\//, replacement: resolve("packages/plugins/fishing/src") + "/" },
        { find: /^@downdraft\/plugin-survival$/, replacement: resolve("packages/plugins/survival/src/index.ts") },
        { find: /^@downdraft\/plugin-survival\//, replacement: resolve("packages/plugins/survival/src") + "/" },
        { find: /^@downdraft\/plugin-economy$/, replacement: resolve("packages/plugins/economy/src/index.ts") },
        { find: /^@downdraft\/plugin-economy\//, replacement: resolve("packages/plugins/economy/src") + "/" },
        { find: /^@downdraft\/plugin-inventory$/, replacement: resolve("packages/plugins/inventory/src/index.ts") },
        { find: /^@downdraft\/plugin-inventory\//, replacement: resolve("packages/plugins/inventory/src") + "/" },
        { find: /^@downdraft\/plugin-items$/, replacement: resolve("packages/plugins/items/src/index.ts") },
        { find: /^@downdraft\/plugin-items\//, replacement: resolve("packages/plugins/items/src") + "/" },
        { find: /^@downdraft\/plugin-crafting$/, replacement: resolve("packages/plugins/crafting/src/index.ts") },
        { find: /^@downdraft\/plugin-crafting\//, replacement: resolve("packages/plugins/crafting/src") + "/" },
        { find: /^@downdraft\/mcp$/, replacement: resolve("packages/mcp/src/index.ts") },
        { find: /^@downdraft\/mcp\//, replacement: resolve("packages/mcp/src") + "/" },
      ],
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(rendererRoot, "index.html"),
        },
      },
    } as any,
    plugins: [
      react(),
      hotReloadPlugin({
        simPaths: ["simulation/", "shared/", "packages/core/", "packages/plugins/"],
        rendererPaths: ["engine/", "stores/"],
        shaderExts: [".wgsl"],
        assetExts: [".glb", ".png", ".jpg", ".jpeg", ".webp"],
      }),
    ],
  },
});
