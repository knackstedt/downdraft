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
      ],
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("packages/app/src/preload/index.ts"),
        },
        output: {
          entryFileNames: "[name].js",
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
