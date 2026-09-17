import { createEngineResolver } from "@downdraft/app/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

const engine = createEngineResolver(__dirname);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@renderer", replacement: resolve(__dirname, "src") },
      { find: /^@downdraft\/core$/, replacement: resolve(engine.src("@downdraft/core", "core"), "index.ts") },
      { find: /^@downdraft\/core\//, replacement: engine.src("@downdraft/core", "core") + "/" },
      { find: /^@downdraft\/library-models$/, replacement: resolve(engine.src("@downdraft/library-models", "libraries/models"), "index.ts") },
      { find: /^@downdraft\/library-models\//, replacement: engine.src("@downdraft/library-models", "libraries/models") + "/" },
      { find: /^@downdraft\/library-entities$/, replacement: resolve(engine.src("@downdraft/library-entities", "libraries/entities"), "index.ts") },
      { find: /^@downdraft\/library-entities\//, replacement: engine.src("@downdraft/library-entities", "libraries/entities") + "/" },
      { find: /^@downdraft\/module-camera-controls$/, replacement: resolve(engine.src("@downdraft/module-camera-controls", "modules/camera-controls"), "index.ts") },
      { find: /^@downdraft\/module-camera-controls\//, replacement: engine.src("@downdraft/module-camera-controls", "modules/camera-controls") + "/" },
      { find: /^@downdraft\/module-devtools$/, replacement: resolve(engine.src("@downdraft/module-devtools", "modules/devtools"), "index.ts") },
      { find: /^@downdraft\/module-devtools\//, replacement: engine.src("@downdraft/module-devtools", "modules/devtools") + "/" },
      { find: /^node:fs$/, replacement: resolve(engine.src("@downdraft/app", "app"), "renderer-shims/fs.ts") },
      { find: /^fs$/, replacement: resolve(engine.src("@downdraft/app", "app"), "renderer-shims/fs.ts") },
    ],
  },
  server: {
    port: 5180,
    fs: {
      allow: [
        resolve(__dirname),
        // Monorepo: allow the engine packages dir; standalone installs serve
        // from node_modules which is allowed by default.
        ...(engine.repoRoot ? [engine.repoRoot] : []),
      ],
    },
  },
  optimizeDeps: {
    include: ["fflate"],
  },
});
