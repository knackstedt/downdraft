import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "path";

const game = process.env.DOWNDRAFT_GAME;
const rendererRoot = game ? resolve("games", game) : resolve("packages/app");

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
        { find: /^node:fs$/, replacement: resolve("packages/app/src/renderer-shims/fs.ts") },
        { find: /^fs$/, replacement: resolve("packages/app/src/renderer-shims/fs.ts") },
      ],
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(rendererRoot, "index.html"),
        },
      },
    } as any,
    plugins: [react()],
  },
});
