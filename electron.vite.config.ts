import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

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
    root: "src/renderer",
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
        "@downdraft/core": resolve("packages/core/src/index.ts"),
        "@downdraft/core/*": resolve("packages/core/src/*"),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
        },
      },
    } as any,
    plugins: [react()],
  },
});
