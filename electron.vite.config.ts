import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "path";

const game = process.env.DOWNDRAFT_GAME;
const rendererRoot = game ? resolve("games", game) : resolve("src/renderer");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@dimforge/rapier3d-compat"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "db-worker": resolve("src/main/db-worker.ts"),
        },
        output: {
          entryFileNames: "[name].js",
        },
      },
    } as any,
    resolve: {
      alias: {
        "@main": resolve("src/main"),
        "@shared": resolve("src/shared"),
        "@downdraft/core": resolve("packages/core/src/index.ts"),
        "@downdraft/core/*": resolve("packages/core/src/*"),
        "@downdraft/mcp/*": resolve("packages/mcp/src/*"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
        },
        output: {
          entryFileNames: "[name].js",
        },
      },
    } as any,
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  renderer: {
    root: rendererRoot,
    resolve: {
      alias: {
        "@renderer": resolve(rendererRoot, "src"),
        "@shared": game ? resolve(rendererRoot, "src/shared") : resolve("src/shared"),
        "@sim": resolve(rendererRoot, "src/simulation"),
        "@downdraft/core": resolve("packages/core/src/index.ts"),
        "@downdraft/core/*": resolve("packages/core/src/*"),
      },
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
