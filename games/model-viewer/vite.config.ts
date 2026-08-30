import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@renderer", replacement: resolve(__dirname, "src") },
      { find: /^@downdraft\/core$/, replacement: resolve(__dirname, "../../packages/core/src/index.ts") },
      { find: /^@downdraft\/core\//, replacement: resolve(__dirname, "../../packages/core/src") + "/" },
      { find: /^@downdraft/library-models$/, replacement: resolve(__dirname, "../../packages/libraries/models/src/index.ts") },
      { find: /^@downdraft/library-models\//, replacement: resolve(__dirname, "../../packages/libraries/models/src") + "/" },
      { find: /^@downdraft\/library-entities$/, replacement: resolve(__dirname, "../../packages/libraries/entities/src/index.ts") },
      { find: /^@downdraft\/library-entities\//, replacement: resolve(__dirname, "../../packages/libraries/entities/src") + "/" },
      { find: /^@downdraft/module-camera-controls$/, replacement: resolve(__dirname, "../../packages/modules/camera-controls/src/index.ts") },
      { find: /^@downdraft/module-camera-controls\//, replacement: resolve(__dirname, "../../packages/modules/camera-controls/src") + "/" },
      { find: /^@downdraft/module-devtools$/, replacement: resolve(__dirname, "../../packages/modules/devtools/src/index.ts") },
      { find: /^@downdraft/module-devtools\//, replacement: resolve(__dirname, "../../packages/modules/devtools/src") + "/" },
      { find: /^node:fs$/, replacement: resolve(__dirname, "../../packages/app/src/renderer-shims/fs.ts") },
      { find: /^fs$/, replacement: resolve(__dirname, "../../packages/app/src/renderer-shims/fs.ts") },
    ],
  },
  server: {
    port: 5180,
    fs: {
      allow: [
        resolve(__dirname),
        resolve(__dirname, "../.."),
      ],
    },
  },
  optimizeDeps: {
    include: ["fflate"],
  },
});
