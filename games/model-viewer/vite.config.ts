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
      { find: /^@downdraft\/plugin-models$/, replacement: resolve(__dirname, "../../packages/plugins/models/src/index.ts") },
      { find: /^@downdraft\/plugin-models\//, replacement: resolve(__dirname, "../../packages/plugins/models/src") + "/" },
      { find: /^@downdraft\/library-entities$/, replacement: resolve(__dirname, "../../packages/plugins/entities/src/index.ts") },
      { find: /^@downdraft\/library-entities\//, replacement: resolve(__dirname, "../../packages/plugins/entities/src") + "/" },
      { find: /^@downdraft\/plugin-camera-controls$/, replacement: resolve(__dirname, "../../packages/plugins/camera-controls/src/index.ts") },
      { find: /^@downdraft\/plugin-camera-controls\//, replacement: resolve(__dirname, "../../packages/plugins/camera-controls/src") + "/" },
      { find: /^@downdraft\/plugin-devtools$/, replacement: resolve(__dirname, "../../packages/plugins/devtools/src/index.ts") },
      { find: /^@downdraft\/plugin-devtools\//, replacement: resolve(__dirname, "../../packages/plugins/devtools/src") + "/" },
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
