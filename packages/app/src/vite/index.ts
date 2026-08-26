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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "path";
import { hotReloadPlugin } from "../../../core/src/vite/hot-reload-plugin";
import { wgslHmrPlugin } from "../../../core/src/vite/wgsl-hmr-plugin";
import { downdraftHtmlPlugin, type DowndraftHtmlOptions, type LayerSpec } from "./downdraft-html-plugin";
import { silenceSourcemapWarningsPlugin } from "./silence-sourcemap-warnings-plugin";
import { workerUrlGuardPlugin } from "./worker-url-guard-plugin";

export interface DowndraftViteConfigOptions {
  /** The game directory (usually `__dirname` from the game's electron.vite.config.ts). */
  root: string;
  /** Main process entry (default: `<root>/src/main.ts`). */
  main?: string;
  /** Preload entry (default: `<root>/src/preload.ts`). */
  preload?: string;
  /** Renderer root directory (default: `<root>`). Must contain `index.html` unless `html` is set. */
  rendererRoot?: string;
  /** Game name — used to determine hot-reload simPaths. Defaults to basename(root). */
  game?: string;
  /** Additional main-process aliases to merge. */
  mainAliases?: Array<{ find: string | RegExp; replacement: string }>;
  /** Additional renderer aliases to merge. */
  rendererAliases?: Array<{ find: string | RegExp; replacement: string }>;
  /** Additional packages to exclude from Vite's dep pre-bundling (optimizeDeps.exclude).
   *  Useful when resolve.alias remaps a package to a specific file and the
   *  pre-bundler would otherwise resolve it via export conditions. */
  optimizeDepsExclude?: string[];
  /** Additional packages to include in Vite's dep pre-bundling (optimizeDeps.include).
   *  Use this to force pre-bundling of specific entry points (e.g. when
   *  resolve.alias remaps a package to a non-default file). */
  optimizeDepsInclude?: string[];
  /** Additional esbuild plugins for Vite's dep pre-bundling (optimizeDeps.esbuildOptions.plugins).
   *  Use this to override how esbuild resolves specific packages during pre-bundling. */
  optimizeDepsEsbuildPlugins?: any[];
  /** Export conditions for esbuild's dep pre-bundling (optimizeDeps.esbuildOptions.conditions).
   *  Use this to override which export condition is used when pre-bundling packages
   *  that have multiple export targets (e.g. solid-js has "worker" and "browser"). */
  optimizeDepsEsbuildConditions?: string[];
  /** Additional main-process vite plugins. */
  mainPlugins?: any[];
  /** Additional renderer vite plugins. */
  rendererPlugins?: any[];
  /** Additional vite plugins applied only to worker bundles (renderer.worker.plugins). */
  workerPlugins?: any[];
  /** Additional Rollup entry inputs for the renderer build (e.g. separate worker chunks).
   *  Each entry is { name: string, path: string } where path is relative to root. */
  extraRollupInputs?: Array<{ name: string; path: string }>;
  /** Hot-reload sim paths (defaults to to-the-ocean's set if game name matches). */
  simPaths?: string[];
  /** Hot-reload renderer paths. */
  rendererPaths?: string[];
  /** Hot-reload exclude paths. */
  excludePaths?: string[];
  /**
   * HTML generation config. When provided, the framework generates index.html
   * from a layer spec instead of requiring the game to maintain its own.
   * Defaults to one canvas + one DOM root:
   *
   *   { title: game, layers: [{ type: "canvas", id: "game-canvas" }, { type: "dom", id: "root" }] }
   *
   * If the game has a physical index.html, the generated HTML replaces its
   * content at build/dev time. Set to `false` to disable generation and use
   * the game's own index.html as-is.
   */
  html?: DowndraftHtmlOptions | false;
  /**
   * Convenience shorthand for `html.layers`. If set, implies `html` is enabled.
   * Defaults to one canvas + one DOM root.
   */
  layers?: LayerSpec[];
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
    { find: /^@downdraft\/library-persistence$/, replacement: resolve(repoRoot, "packages/libraries/persistence/src/index.ts") },
    { find: /^@downdraft\/library-persistence\/browser$/, replacement: resolve(repoRoot, "packages/libraries/persistence/src/browser.ts") },
    { find: /^@downdraft\/library-persistence\//, replacement: resolve(repoRoot, "packages/libraries/persistence/src") + "/" },
    // library-models — dynamically imported by core's loader-mesh.ts; needs to
    // be resolvable in the main process build.
    { find: /^@downdraft\/library-models$/, replacement: resolve(repoRoot, "packages/libraries/models/src/index.ts") },
    { find: /^@downdraft\/library-models\//, replacement: resolve(repoRoot, "packages/libraries/models/src") + "/" },
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
    // Persistence — browser entry excludes FileSaveStore (node:fs/node:path)
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
    { find: /^@downdraft\/library-undertow$/, replacement: resolve(repoRoot, "packages/libraries/undertow/src/index.ts") },
    { find: /^@downdraft\/library-undertow\//, replacement: resolve(repoRoot, "packages/libraries/undertow/src") + "/" },
    { find: /^node:fs$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/fs.ts") },
    { find: /^fs$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/fs.ts") },
    { find: /^@downdraft\/library-marching-cubes$/, replacement: resolve(repoRoot, "packages/libraries/marching-cubes/src/index.ts") },
    { find: /^@downdraft\/library-marching-cubes\//, replacement: resolve(repoRoot, "packages/libraries/marching-cubes/src") + "/" },
    { find: /^@downdraft\/library-navmesh$/, replacement: resolve(repoRoot, "packages/libraries/navmesh/src/index.ts") },
    { find: /^@downdraft\/library-navmesh\//, replacement: resolve(repoRoot, "packages/libraries/navmesh/src") + "/" },
    { find: /^@downdraft\/library-water$/, replacement: resolve(repoRoot, "packages/libraries/water/src/index.ts") },
    { find: /^@downdraft\/library-water\//, replacement: resolve(repoRoot, "packages/libraries/water/src") + "/" },
    // @to-the-ocean game plugins (game-owned, depend on engine)
    { find: /^@to-the-ocean\/library-boats$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/boats/src/index.ts") },
    { find: /^@to-the-ocean\/library-boats\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/boats/src") + "/" },
    { find: /^@to-the-ocean\/library-buoyancy$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/buoyancy/src/index.ts") },
    { find: /^@to-the-ocean\/library-buoyancy\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/buoyancy/src") + "/" },
    { find: /^@to-the-ocean\/library-collision$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/collision/src/index.ts") },
    { find: /^@to-the-ocean\/library-collision\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/collision/src") + "/" },
    { find: /^@to-the-ocean\/plugin-crafting$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/crafting/src/index.ts") },
    { find: /^@to-the-ocean\/plugin-crafting\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/crafting/src") + "/" },
    { find: /^@to-the-ocean\/library-economy$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/economy/src/index.ts") },
    { find: /^@to-the-ocean\/library-economy\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/economy/src") + "/" },
    { find: /^@to-the-ocean\/library-fishing$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/fishing/src/index.ts") },
    { find: /^@to-the-ocean\/library-fishing\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/fishing/src") + "/" },
    { find: /^@to-the-ocean\/plugin-inventory$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/inventory/src/index.ts") },
    { find: /^@to-the-ocean\/plugin-inventory\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/inventory/src") + "/" },
    { find: /^@to-the-ocean\/library-items$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/items/src/index.ts") },
    { find: /^@to-the-ocean\/library-items\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/items/src") + "/" },
    { find: /^@to-the-ocean\/library-survival$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/survival/src/index.ts") },
    { find: /^@to-the-ocean\/library-survival\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/survival/src") + "/" },
    { find: /^@to-the-ocean\/library-wildlife$/, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/wildlife/src/index.ts") },
    { find: /^@to-the-ocean\/library-wildlife\//, replacement: resolve(repoRoot, "games/to-the-ocean/plugins/wildlife/src") + "/" },
    { find: /^@to-the-ocean\/util\//, replacement: resolve(repoRoot, "games/to-the-ocean/src/util") + "/" },
    { find: /^@downdraft\/mcp$/, replacement: resolve(repoRoot, "packages/mcp/src/index.ts") },
    { find: /^@downdraft\/mcp\//, replacement: resolve(repoRoot, "packages/mcp/src") + "/" },
    { find: /^@downdraft\/plugin-electron-osr$/, replacement: resolve(repoRoot, "packages/plugins/electron-osr/src/index.ts") },
    { find: /^@downdraft\/plugin-electron-osr\//, replacement: resolve(repoRoot, "packages/plugins/electron-osr/src") + "/" },
    // @downdraft/app renderer accessor + base CSS
    { find: /^@downdraft\/app\/renderer$/, replacement: resolve(repoRoot, "packages/app/src/renderer/index.ts") },
    { find: /^@downdraft\/app\/renderer\/downdraft-base\.css$/, replacement: resolve(repoRoot, "packages/app/src/renderer/downdraft-base.css") },
    { find: /^@downdraft\/app\/shared$/, replacement: resolve(repoRoot, "packages/app/src/shared/index.ts") },
    { find: /^@downdraft\/app$/, replacement: resolve(repoRoot, "packages/app/src/index.ts") },
    ...(options.rendererAliases ?? []),
  ];

  // --- Hot-reload config ---
  // to-the-ocean has a sim worker — simPaths trigger worker swap (with ack).
  // Other games have no sim worker — let Vite's native HMR handle everything.
  const hasSimWorker = existsSync(resolve(rendererRoot, "src/simulation"));
  const simPaths = options.simPaths ?? (hasSimWorker
    ? ["simulation/", "shared/", "packages/core/", "packages/plugins/", "packages/libraries/", "games/to-the-ocean/plugins/"]
    : []);
  const rendererPaths = options.rendererPaths ?? (hasSimWorker
    ? ["engine/", "stores/", "packages/plugins/electron-osr/src/renderer/"]
    : []);
  const excludePaths = options.excludePaths ?? [
    "packages/plugins/electron-osr/src/main/",
    "simulation/ecs/ecs-",
    "games/to-the-ocean/plugins/wildlife/src/",
    "games/to-the-ocean/plugins/buoyancy/src/",
    "games/to-the-ocean/plugins/collision/src/",
  ];

  // --- HTML generation ---
  // If html is not explicitly false, generate index.html from the layer spec.
  // Games can opt out by setting html: false to use their own index.html as-is.
  const htmlOpts: DowndraftHtmlOptions | null = options.html === false
    ? null
    : options.html ?? {
        title: game,
        layers: options.layers ?? [
          { type: "canvas", id: "game-canvas" },
          { type: "dom", id: "root" },
        ],
        entry: "/src/main.tsx",
      };

  // Ensure index.html exists for the rollup input — if the game doesn't have
  // one, the HTML plugin will generate it virtually. But rollup needs a file
  // to exist at the input path. We create a placeholder if needed.
  const indexHtmlPath = resolve(rendererRoot, "index.html");
  if (htmlOpts && !existsSync(indexHtmlPath)) {
    // The plugin's transformIndexHtml will replace this content at build time.
    // We just need a file to exist so rollup can resolve the input.
    mkdirSync(resolve(rendererRoot), { recursive: true });
    writeFileSync(indexHtmlPath, "<!-- downdraft: generated -->\n", "utf-8");
  }

  return defineConfig({
    main: {
      plugins: [
        externalizeDepsPlugin({ exclude: ["@dimforge/rapier3d-compat", "@downdraft/plugin-electron-osr", "@downdraft/library-persistence"] }),
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
      server: {
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        },
      },
      resolve: {
        alias: rendererAliasEntries,
        // Force a single copy of React in the bundle. With bun's symlinked
        // node_modules and multiple workspace packages each declaring react,
        // Rollup can otherwise resolve react/react-dom from different paths
        // and emit two copies, causing "Invalid hook call" at runtime.
        dedupe: ["react", "react-dom"],
      },
      worker: {
        format: "es",
        // Vite 6 requires worker.plugins to be a function that returns an
        // array of plugins, not an array directly.
        plugins: (() => options.workerPlugins ?? []) as any,
      },
      // Exclude @bokuweb/zstd-wasm from dep pre-bundling. The package loads
      // its WASM via `new URL("./zstd.wasm", import.meta.url)`, which esbuild's
      // pre-bundler doesn't handle — the .wasm file isn't copied alongside the
      // pre-bundled output, so import.meta.url points to a non-existent path
      // and the dev server returns the HTML SPA fallback (causing
      // "expected magic word 00 61 73 6d, found 3c 21 44 4f" WASM errors).
      // Excluding it lets Vite serve the original module with the correct
      // import.meta.url pointing into node_modules.
      optimizeDeps: {
        exclude: ["@bokuweb/zstd-wasm", ...(options.optimizeDepsExclude ?? [])],
        include: [...(options.optimizeDepsInclude ?? [])],
        esbuildOptions: {
          plugins: [...(options.optimizeDepsEsbuildPlugins ?? [])],
          conditions: options.optimizeDepsEsbuildConditions,
        },
      },
      build: {
        outDir: "dist/renderer",
        sourcemap: "hidden",
        rollupOptions: {
          input: {
            index: resolve(rendererRoot, "index.html"),
            ...(Object.fromEntries(
              (options.extraRollupInputs ?? []).map((e) => [e.name, resolve(rendererRoot, e.path)]),
            )),
          },
        },
      } as any,
      plugins: [
        ...(htmlOpts ? [downdraftHtmlPlugin(htmlOpts)] : []),
        // Silence "Sourcemap for ... points to missing source files" warnings
        // from @bokuweb/zstd-wasm (excluded from dep pre-bundling above, so
        // served raw from node_modules — its .js.map files reference sources
        // the package author didn't publish). See silence-sourcemap-warnings-plugin.ts.
        silenceSourcemapWarningsPlugin(),
        // Exclude src/solid/** from the React plugin so it doesn't inject
        // React Refresh code (which references `window`) into the Solid worker
        // chunk. The Solid plugin (added via rendererPlugins) handles those files.
        react({ exclude: "**/src/solid/**" }),
        // WGSL `?raw` HMR boundary — must run before Vite's asset plugin so
        // `*.wgsl?raw` modules become HMR boundaries (fine-grained shader
        // reload via wgslHotReload, full page reload fallback). Applies to
        // all games and CLI templates automatically via this factory.
        wgslHmrPlugin(repoRoot),
        hotReloadPlugin({
          simPaths,
          rendererPaths,
          excludePaths,
        }),
        // Guard against the silent prod-break pattern of assigning a worker
        // URL to a variable before `new Worker()`. Warns at build time.
        workerUrlGuardPlugin(),
        ...(options.rendererPlugins ?? []),
      ],
    },
  });
}

// Re-export HTML generation types for games that need them
export type { CanvasLayer, DomLayer, DowndraftHtmlOptions, LayerSpec } from "./downdraft-html-plugin";

