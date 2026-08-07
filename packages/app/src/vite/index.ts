// ============================================================================
// createDowndraftViteConfig() — electron-vite build config factory for games
// ============================================================================
//
// Each game's `electron.vite.config.ts` calls this factory to get a fully
// wired electron-vite config with all engine aliases, externalization,
// hot-reload plugin, and CJS preload output. Games only need to specify
// their `root` and can override any section.
//
// ```ts
// import { createDowndraftViteConfig } from "@downdraft/app/vite";
// export default createDowndraftViteConfig({ root: __dirname });
// ```

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { existsSync } from "node:fs";
import { resolve } from "path";
import { hotReloadPlugin } from "../../../core/src/vite/hot-reload-plugin";

export interface DowndraftViteConfigOptions {
  /** The game directory (usually `__dirname` from the game's electron.vite.config.ts). */
  root: string;
  /** Main process entry (default: `<root>/src/main.ts`). */
  main?: string;
  /** Preload entry (default: `<root>/src/preload.ts`). */
  preload?: string;
  /** Renderer root directory (default: `<root>`). Must contain `index.html`. */
  rendererRoot?: string;
  /** Game name — used to determine hot-reload simPaths. Defaults to basename(root). */
  game?: string;
  /** Additional main-process aliases to merge. */
  mainAliases?: Array<{ find: string | RegExp; replacement: string }>;
  /** Additional renderer aliases to merge. */
  rendererAliases?: Array<{ find: string | RegExp; replacement: string }>;
  /** Additional main-process vite plugins. */
  mainPlugins?: any[];
  /** Additional renderer vite plugins. */
  rendererPlugins?: any[];
  /** Hot-reload sim paths (defaults to to-the-ocean's set if game name matches). */
  simPaths?: string[];
  /** Hot-reload renderer paths. */
  rendererPaths?: string[];
  /** Hot-reload exclude paths. */
  excludePaths?: string[];
}

export function createDowndraftViteConfig(options: DowndraftViteConfigOptions): ReturnType<typeof defineConfig> {
  const { root } = options;
  const repoRoot = resolve(root, "../..");
  const game = options.game ?? root.split("/").pop()!;
  const mainEntry = options.main ?? resolve(root, "src/main.ts");
  const preloadEntry = options.preload ?? resolve(root, "src/preload.ts");
  const rendererRoot = options.rendererRoot ?? root;

  // --- Shared alias sets ---

  const coreAliases = [
    { find: /^@downdraft\/core$/, replacement: resolve(repoRoot, "packages/core/src/index.ts") },
    { find: /^@downdraft\/core\//, replacement: resolve(repoRoot, "packages/core/src") + "/" },
  ];

  const mainAliases = [
    { find: "@main", replacement: resolve(repoRoot, "packages/app/src/main") },
    { find: "@shared", replacement: resolve(repoRoot, "packages/app/src/shared") },
    ...coreAliases,
    { find: /^@downdraft\/mcp\//, replacement: resolve(repoRoot, "packages/mcp/src") + "/" },
    { find: /^@downdraft\/mcp$/, replacement: resolve(repoRoot, "packages/mcp/src/index.ts") },
    { find: /^@downdraft\/shader-graph$/, replacement: resolve(repoRoot, "packages/shader-graph/src/index.ts") },
    { find: /^@downdraft\/shader-graph\//, replacement: resolve(repoRoot, "packages/shader-graph/src") + "/" },
    { find: /^@downdraft\/plugin-electron-osr$/, replacement: resolve(repoRoot, "packages/plugins/electron-osr/src/index.ts") },
    { find: /^@downdraft\/plugin-electron-osr\/main-entry$/, replacement: resolve(repoRoot, "packages/plugins/electron-osr/src/main-entry.ts") },
    { find: /^@downdraft\/plugin-electron-osr\//, replacement: resolve(repoRoot, "packages/plugins/electron-osr/src") + "/" },
    { find: /^@downdraft\/plugin-persistence$/, replacement: resolve(repoRoot, "packages/plugins/persistence/src/index.ts") },
    { find: /^@downdraft\/plugin-persistence\//, replacement: resolve(repoRoot, "packages/plugins/persistence/src") + "/" },
    // plugin-models — dynamically imported by core's loader-mesh.ts; needs to
    // be resolvable in the main process build.
    { find: /^@downdraft\/plugin-models$/, replacement: resolve(repoRoot, "packages/plugins/models/src/index.ts") },
    { find: /^@downdraft\/plugin-models\//, replacement: resolve(repoRoot, "packages/plugins/models/src") + "/" },
    // @downdraft/app subpath exports — resolve to source for dev builds
    { find: /^@downdraft\/app\/main$/, replacement: resolve(repoRoot, "packages/app/src/main/index.ts") },
    { find: /^@downdraft\/app\/preload$/, replacement: resolve(repoRoot, "packages/app/src/preload/index.ts") },
    { find: /^@downdraft\/app\/shared$/, replacement: resolve(repoRoot, "packages/app/src/shared/index.ts") },
    { find: /^@downdraft\/app\/vite$/, replacement: resolve(repoRoot, "packages/app/src/vite/index.ts") },
    { find: /^@downdraft\/app$/, replacement: resolve(repoRoot, "packages/app/src/index.ts") },
    ...(options.mainAliases ?? []),
  ];

  const rendererAliasEntries = [
    { find: "@renderer", replacement: resolve(rendererRoot, "src") },
    { find: "@shared", replacement: resolve(rendererRoot, "src/shared") },
    { find: "@sim", replacement: resolve(rendererRoot, "src/simulation") },
    ...coreAliases,
    { find: /^@downdraft\/ui$/, replacement: resolve(repoRoot, "packages/ui/src/index.ts") },
    { find: /^@downdraft\/ui\//, replacement: resolve(repoRoot, "packages/ui/src") + "/" },
    { find: /^@downdraft\/shader-graph$/, replacement: resolve(repoRoot, "packages/shader-graph/src/index.ts") },
    { find: /^@downdraft\/shader-graph\//, replacement: resolve(repoRoot, "packages/shader-graph/src") + "/" },
    { find: /^@downdraft\/plugin-postfx$/, replacement: resolve(repoRoot, "packages/plugins/postfx/src/index.ts") },
    { find: /^@downdraft\/plugin-postfx\//, replacement: resolve(repoRoot, "packages/plugins/postfx/src") + "/" },
    { find: /^@downdraft\/plugin-lighting$/, replacement: resolve(repoRoot, "packages/plugins/lighting/src/index.ts") },
    { find: /^@downdraft\/plugin-lighting\//, replacement: resolve(repoRoot, "packages/plugins/lighting/src") + "/" },
    { find: /^@downdraft\/plugin-weatherfx$/, replacement: resolve(repoRoot, "packages/plugins/weatherfx/src/index.ts") },
    { find: /^@downdraft\/plugin-weatherfx\//, replacement: resolve(repoRoot, "packages/plugins/weatherfx/src") + "/" },
    { find: /^@downdraft\/plugin-weather$/, replacement: resolve(repoRoot, "packages/plugins/weather/src/index.ts") },
    { find: /^@downdraft\/plugin-weather\//, replacement: resolve(repoRoot, "packages/plugins/weather/src") + "/" },
    { find: /^@downdraft\/plugin-entities$/, replacement: resolve(repoRoot, "packages/plugins/entities/src/index.ts") },
    { find: /^@downdraft\/plugin-entities\//, replacement: resolve(repoRoot, "packages/plugins/entities/src") + "/" },
    { find: /^@downdraft\/plugin-models$/, replacement: resolve(repoRoot, "packages/plugins/models/src/index.ts") },
    { find: /^@downdraft\/plugin-models\//, replacement: resolve(repoRoot, "packages/plugins/models/src") + "/" },
    { find: /^@downdraft\/plugin-devtools$/, replacement: resolve(repoRoot, "packages/plugins/devtools/src/index.ts") },
    { find: /^@downdraft\/plugin-devtools\//, replacement: resolve(repoRoot, "packages/plugins/devtools/src") + "/" },
    { find: /^@downdraft\/plugin-camera-controls$/, replacement: resolve(repoRoot, "packages/plugins/camera-controls/src/index.ts") },
    { find: /^@downdraft\/plugin-camera-controls\//, replacement: resolve(repoRoot, "packages/plugins/camera-controls/src") + "/" },
    { find: /^@downdraft\/plugin-boats$/, replacement: resolve(repoRoot, "packages/plugins/boats/src/index.ts") },
    { find: /^@downdraft\/plugin-boats\//, replacement: resolve(repoRoot, "packages/plugins/boats/src") + "/" },
    { find: /^node:fs$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/fs.ts") },
    { find: /^fs$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/fs.ts") },
    { find: /^@downdraft\/plugin-marching-cubes$/, replacement: resolve(repoRoot, "packages/plugins/marching-cubes/src/index.ts") },
    { find: /^@downdraft\/plugin-marching-cubes\//, replacement: resolve(repoRoot, "packages/plugins/marching-cubes/src") + "/" },
    { find: /^@downdraft\/plugin-navmesh$/, replacement: resolve(repoRoot, "packages/plugins/navmesh/src/index.ts") },
    { find: /^@downdraft\/plugin-navmesh\//, replacement: resolve(repoRoot, "packages/plugins/navmesh/src") + "/" },
    { find: /^@downdraft\/plugin-water$/, replacement: resolve(repoRoot, "packages/plugins/water/src/index.ts") },
    { find: /^@downdraft\/plugin-water\//, replacement: resolve(repoRoot, "packages/plugins/water/src") + "/" },
    { find: /^@downdraft\/plugin-fishing$/, replacement: resolve(repoRoot, "packages/plugins/fishing/src/index.ts") },
    { find: /^@downdraft\/plugin-fishing\//, replacement: resolve(repoRoot, "packages/plugins/fishing/src") + "/" },
    { find: /^@downdraft\/plugin-survival$/, replacement: resolve(repoRoot, "packages/plugins/survival/src/index.ts") },
    { find: /^@downdraft\/plugin-survival\//, replacement: resolve(repoRoot, "packages/plugins/survival/src") + "/" },
    { find: /^@downdraft\/plugin-economy$/, replacement: resolve(repoRoot, "packages/plugins/economy/src/index.ts") },
    { find: /^@downdraft\/plugin-economy\//, replacement: resolve(repoRoot, "packages/plugins/economy/src") + "/" },
    { find: /^@downdraft\/plugin-inventory$/, replacement: resolve(repoRoot, "packages/plugins/inventory/src/index.ts") },
    { find: /^@downdraft\/plugin-inventory\//, replacement: resolve(repoRoot, "packages/plugins/inventory/src") + "/" },
    { find: /^@downdraft\/plugin-items$/, replacement: resolve(repoRoot, "packages/plugins/items/src/index.ts") },
    { find: /^@downdraft\/plugin-items\//, replacement: resolve(repoRoot, "packages/plugins/items/src") + "/" },
    { find: /^@downdraft\/plugin-crafting$/, replacement: resolve(repoRoot, "packages/plugins/crafting/src/index.ts") },
    { find: /^@downdraft\/plugin-crafting\//, replacement: resolve(repoRoot, "packages/plugins/crafting/src") + "/" },
    { find: /^@downdraft\/mcp$/, replacement: resolve(repoRoot, "packages/mcp/src/index.ts") },
    { find: /^@downdraft\/mcp\//, replacement: resolve(repoRoot, "packages/mcp/src") + "/" },
    { find: /^@downdraft\/plugin-electron-osr$/, replacement: resolve(repoRoot, "packages/plugins/electron-osr/src/index.ts") },
    { find: /^@downdraft\/plugin-electron-osr\//, replacement: resolve(repoRoot, "packages/plugins/electron-osr/src") + "/" },
    // @downdraft/app renderer accessor
    { find: /^@downdraft\/app\/renderer$/, replacement: resolve(repoRoot, "packages/app/src/renderer/index.ts") },
    { find: /^@downdraft\/app\/shared$/, replacement: resolve(repoRoot, "packages/app/src/shared/index.ts") },
    { find: /^@downdraft\/app$/, replacement: resolve(repoRoot, "packages/app/src/index.ts") },
    ...(options.rendererAliases ?? []),
  ];

  // --- Hot-reload config ---
  // to-the-ocean has a sim worker — simPaths trigger worker swap (with ack).
  // Other games have no sim worker — let Vite's native HMR handle everything.
  const hasSimWorker = existsSync(resolve(rendererRoot, "src/simulation"));
  const simPaths = options.simPaths ?? (hasSimWorker
    ? ["simulation/", "shared/", "packages/core/", "packages/plugins/"]
    : []);
  const rendererPaths = options.rendererPaths ?? (hasSimWorker
    ? ["engine/", "stores/", "packages/plugins/electron-osr/src/renderer/"]
    : []);
  const excludePaths = options.excludePaths ?? [
    "packages/plugins/electron-osr/src/main/",
    "simulation/ecs/ecs-",
    "packages/plugins/wildlife/src/",
    "packages/plugins/buoyancy/src/",
    "packages/plugins/collision/src/",
  ];

  return defineConfig({
    main: {
      plugins: [
        externalizeDepsPlugin({ exclude: ["@dimforge/rapier3d-compat", "@downdraft/plugin-electron-osr", "@downdraft/plugin-persistence"] }),
        {
          name: "force-cjs-main",
          configResolved(config) {
            const output = config.build.rollupOptions.output;
            const out = Array.isArray(output) ? output[0] : output;
            if (out) {
              out.format = "cjs";
            }
          },
        },
        ...(options.mainPlugins ?? []),
      ],
      build: {
        outDir: "dist/main",
        sourcemap: "hidden",
        rollupOptions: {
          input: {
            index: mainEntry,
          },
          output: {
            entryFileNames: "[name].cjs",
          },
        },
      } as any,
      resolve: {
        alias: mainAliases,
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
        outDir: "dist/preload",
        sourcemap: "hidden",
        rollupOptions: {
          input: {
            index: preloadEntry,
          },
          output: {
            format: "cjs",
            entryFileNames: "[name].cjs",
          },
        },
      } as any,
      resolve: {
        alias: [
          { find: "@shared", replacement: resolve(repoRoot, "packages/app/src/shared") },
          { find: "@downdraft/app/preload", replacement: resolve(repoRoot, "packages/app/src/preload/index.ts") },
          { find: "@downdraft/app/shared", replacement: resolve(repoRoot, "packages/app/src/shared/index.ts") },
          { find: "@downdraft/app", replacement: resolve(repoRoot, "packages/app/src/index.ts") },
          ...coreAliases,
        ],
      },
    },
    renderer: {
      root: rendererRoot,
      resolve: {
        alias: rendererAliasEntries,
      },
      build: {
        outDir: "dist/renderer",
        sourcemap: "hidden",
        rollupOptions: {
          input: {
            index: resolve(rendererRoot, "index.html"),
          },
        },
      } as any,
      plugins: [
        react(),
        hotReloadPlugin({
          simPaths,
          rendererPaths,
          excludePaths,
          shaderExts: [".wgsl"],
          assetExts: [".glb", ".png", ".jpg", ".jpeg", ".webp"],
        }),
        ...(options.rendererPlugins ?? []),
      ],
    },
  });
}
