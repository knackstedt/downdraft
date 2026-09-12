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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "path";
import { hotReloadPlugin } from "../../../core/src/vite/hot-reload-plugin";
import { wgslHmrPlugin } from "../../../core/src/vite/wgsl-hmr-plugin";
import { downdraftAssetBakePlugin, type AssetBakePluginOptions } from "./asset-bake-plugin";
import { downdraftHtmlPlugin, type DowndraftHtmlOptions, type LayerSpec } from "./downdraft-html-plugin";
import { profilingPreludePlugin, type ProfilingPreludePluginOptions } from "./profiling-prelude-plugin";
import { sceneModuleUrlPlugin } from "./scene-module-url-plugin";
import { silenceSourcemapWarningsPlugin } from "./silence-sourcemap-warnings-plugin";
import { wgslValidatePlugin } from "./wgsl-validate-plugin";
import { workerUrlGuardPlugin } from "./worker-url-guard-plugin";

// ---------------------------------------------------------------------------
// Auto-include direct deps for Vite's dep pre-bundling (optimizeDeps.include)
// ---------------------------------------------------------------------------
//
// Vite's dep scanner crawls HTML entries and follows static imports to
// discover which node_modules packages need pre-bundling. It CANNOT see:
//   - bare imports inside Web Workers (new Worker(new URL(...)))
//   - dynamic imports (import("..."))
//   - imports that only appear after plugin transforms
//
// When the browser later requests one of these undiscovered deps, Vite
// re-runs the pre-bundler mid-session and does a FULL PAGE RELOAD (not HMR).
// This is the #1 source of "why did my dev server just reload?" frustration.
//
// To prevent this, we auto-include all direct `dependencies` from both the
// engine root package.json and the game's package.json. Workspace packages
// (workspace:*) are filtered out because they're aliased to source — Vite
// never resolves them from node_modules. Packages already in the exclude
// list (e.g. WASM-loading packages) are also filtered to avoid conflicts.

/**
 * Read a package.json and return the names of its direct `dependencies`
 * that should be pre-bundled by Vite's optimizeDeps. Filters out:
 *  - `workspace:*` packages (aliased to source, not in node_modules)
 *  - packages already in the exclude set (e.g. WASM-loading packages)
 */
export function collectDirectDeps(pkgJsonPath: string, excludeSet: Set<string>): string[] {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    const deps: Record<string, string> = pkg.dependencies ?? {};
    return Object.keys(deps).filter((name) => {
      // Skip workspace packages — they're aliased to source in dev, so
      // Vite never resolves them from node_modules. Including them in
      // optimizeDeps.include would cause pre-bundling to fail or no-op.
      if (deps[name] === "workspace:*") return false;
      // Skip packages already in the exclude list — being in both include
      // and exclude is contradictory and Vite warns about it.
      if (excludeSet.has(name)) return false;
      return true;
    });
  } catch {
    // package.json missing or unreadable — no deps to contribute.
    return [];
  }
}

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
  /** Hot-reload sim paths (defaults to engine dirs if the game has a sim worker).
   *  Games with their own plugin directories should append them here. */
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
  /**
   * Asset bake/optimization step. When enabled (default in build, lazy in
   * dev), glTF/GLB/audio `?url` imports are baked into optimized formats
   * (meshopt geometry + Basis KTX2 textures + normalized audio) and cached
   * in `<root>/.downdraft/bake/`. Set to `false` to disable. The runtime
   * decodes the baked formats with its existing codecs.
   *
   * Disabled when `DOWNDRAFT_BAKE=0`; forced re-bake when
   * `DOWNDRAFT_BAKE_FORCE=1`.
   */
  assetBake?: AssetBakePluginOptions | false;
  /**
   * Profiling system — injects the worker prelude into worker entries.
   * - `true` (default in dev): injects `import "@downdraft/core/profiling/worker-prelude"`
   *   into all worker-entry files, enabling IOPS patching, warning rules,
   *   event-loop monitoring, and the in-game profiler overlay.
   * - `false`: disables prelude injection (profiling off).
   * - `"always"`: enables in both dev and prod builds.
   * Pass an object to customize the plugin's include/exclude globs.
   */
  profiling?: boolean | "always" | ProfilingPreludePluginOptions;
}

export function createDowndraftViteConfig(options: DowndraftViteConfigOptions): ReturnType<typeof defineConfig> {
  const { root } = options;
  const repoRoot = resolve(root, "../..");
  const game = options.game ?? root.split("/").pop()!;
  const mainEntry = options.main ?? resolve(root, "src/main.ts");
  const preloadEntry = options.preload ?? resolve(root, "src/preload.ts");
  const rendererRoot = options.rendererRoot ?? root;

  // --- Auto-include direct deps for optimizeDeps ---
  // Collect direct `dependencies` from the engine root and the game's
  // package.json so Vite pre-bundles them at startup. This prevents the
  // mid-session re-optimization + full page reload that happens when a dep
  // is imported from a worker or dynamic import the scanner can't see.
  const optimizeDepsExcludeDefaults = [
    "@bokuweb/zstd-wasm", "@h00w/basis-universal-transcoder", "recast-navigation",
    ...(options.optimizeDepsExclude ?? []),
  ];
  const excludeSet = new Set(optimizeDepsExcludeDefaults);
  const engineDeps = collectDirectDeps(resolve(repoRoot, "package.json"), excludeSet);
  const gameDeps = collectDirectDeps(resolve(root, "package.json"), excludeSet);
  const autoOptimizeDepsInclude = [...new Set([...engineDeps, ...gameDeps])];

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
    { find: /^@downdraft\/module-electron-osr$/, replacement: resolve(repoRoot, "packages/modules/electron-osr/src/index.ts") },
    { find: /^@downdraft\/module-electron-osr\/main-entry$/, replacement: resolve(repoRoot, "packages/modules/electron-osr/src/main-entry.ts") },
    { find: /^@downdraft\/module-electron-osr\//, replacement: resolve(repoRoot, "packages/modules/electron-osr/src") + "/" },
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
    { find: /^@downdraft\/module-devtools$/, replacement: resolve(repoRoot, "packages/modules/devtools/src/index.ts") },
    { find: /^@downdraft\/module-devtools\//, replacement: resolve(repoRoot, "packages/modules/devtools/src") + "/" },
    { find: /^@downdraft\/module-terrain$/, replacement: resolve(repoRoot, "packages/modules/terrain/src/index.ts") },
    { find: /^@downdraft\/module-terrain\//, replacement: resolve(repoRoot, "packages/modules/terrain/src") + "/" },
    { find: /^@downdraft\/module-movement-3d$/, replacement: resolve(repoRoot, "packages/modules/movement-3d/src/index.ts") },
    { find: /^@downdraft\/module-movement-3d\//, replacement: resolve(repoRoot, "packages/modules/movement-3d/src") + "/" },
    { find: /^@downdraft\/module-movement-2d$/, replacement: resolve(repoRoot, "packages/modules/movement-2d/src/index.ts") },
    { find: /^@downdraft\/module-movement-2d\//, replacement: resolve(repoRoot, "packages/modules/movement-2d/src") + "/" },
    { find: /^@downdraft\/module-sailing$/, replacement: resolve(repoRoot, "packages/modules/sailing/src/index.ts") },
    { find: /^@downdraft\/module-sailing\//, replacement: resolve(repoRoot, "packages/modules/sailing/src") + "/" },
    { find: /^@downdraft\/module-camera-controls$/, replacement: resolve(repoRoot, "packages/modules/camera-controls/src/index.ts") },
    { find: /^@downdraft\/module-camera-controls\//, replacement: resolve(repoRoot, "packages/modules/camera-controls/src") + "/" },
    { find: /^@downdraft\/library-pixi-ui$/, replacement: resolve(repoRoot, "packages/libraries/pixi-ui/src/index.ts") },
    { find: /^@downdraft\/library-pixi-ui\//, replacement: resolve(repoRoot, "packages/libraries/pixi-ui/src") + "/" },
    { find: /^@downdraft\/library-profiler$/, replacement: resolve(repoRoot, "packages/libraries/profiler/src/index.ts") },
    { find: /^@downdraft\/library-profiler\//, replacement: resolve(repoRoot, "packages/libraries/profiler/src") + "/" },
    { find: /^node:fs$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/fs.ts") },
    { find: /^fs$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/fs.ts") },
    { find: /^node:path$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/path.ts") },
    { find: /^path$/, replacement: resolve(repoRoot, "packages/app/src/renderer-shims/path.ts") },
    { find: /^@downdraft\/library-marching-cubes$/, replacement: resolve(repoRoot, "packages/libraries/marching-cubes/src/index.ts") },
    { find: /^@downdraft\/library-marching-cubes\//, replacement: resolve(repoRoot, "packages/libraries/marching-cubes/src") + "/" },
    { find: /^@downdraft\/library-navmesh$/, replacement: resolve(repoRoot, "packages/libraries/navmesh/src/index.ts") },
    { find: /^@downdraft\/library-navmesh\//, replacement: resolve(repoRoot, "packages/libraries/navmesh/src") + "/" },
    { find: /^@downdraft\/library-recast$/, replacement: resolve(repoRoot, "packages/libraries/recast/src/index.ts") },
    { find: /^@downdraft\/library-recast\//, replacement: resolve(repoRoot, "packages/libraries/recast/src") + "/" },
    { find: /^@downdraft\/library-water$/, replacement: resolve(repoRoot, "packages/libraries/water/src/index.ts") },
    { find: /^@downdraft\/library-water\//, replacement: resolve(repoRoot, "packages/libraries/water/src") + "/" },
    { find: /^@downdraft\/library-postfx$/, replacement: resolve(repoRoot, "packages/libraries/postfx/src/index.ts") },
    { find: /^@downdraft\/library-postfx\//, replacement: resolve(repoRoot, "packages/libraries/postfx/src") + "/" },
    // Game-owned plugin aliases are registered by each game's own
    // electron.vite.config.ts via `rendererAliases` — the engine config
    // must not hardcode any specific game's plugin paths.
    { find: /^@downdraft\/mcp$/, replacement: resolve(repoRoot, "packages/mcp/src/index.ts") },
    { find: /^@downdraft\/mcp\//, replacement: resolve(repoRoot, "packages/mcp/src") + "/" },
    { find: /^@downdraft\/module-electron-osr$/, replacement: resolve(repoRoot, "packages/modules/electron-osr/src/index.ts") },
    { find: /^@downdraft\/module-electron-osr\//, replacement: resolve(repoRoot, "packages/modules/electron-osr/src") + "/" },
    // @downdraft/app renderer accessor + base CSS
    { find: /^@downdraft\/app\/renderer$/, replacement: resolve(repoRoot, "packages/app/src/renderer/index.ts") },
    { find: /^@downdraft\/app\/renderer\/downdraft-base\.css$/, replacement: resolve(repoRoot, "packages/app/src/renderer/downdraft-base.css") },
    { find: /^@downdraft\/app\/shared$/, replacement: resolve(repoRoot, "packages/app/src/shared/index.ts") },
    { find: /^@downdraft\/app$/, replacement: resolve(repoRoot, "packages/app/src/index.ts") },
    ...(options.rendererAliases ?? []),
  ];

  // --- Hot-reload config ---
  // Games with a sim worker pass simPaths to trigger worker swap (with ack).
  // Games without a sim worker let Vite's native HMR handle everything.
  // Game-specific plugin paths (e.g. games/<game>/plugins/) must be supplied
  // by the game's own electron.vite.config.ts — the engine defaults only
  // cover engine-owned directories.
  const hasSimWorker = existsSync(resolve(rendererRoot, "src/simulation"));
  const simPaths = options.simPaths ?? (hasSimWorker
    ? ["simulation/", "shared/", "packages/core/", "packages/modules/", "packages/libraries/"]
    : []);
  const rendererPaths = options.rendererPaths ?? (hasSimWorker
    ? ["engine/", "stores/", "packages/modules/electron-osr/src/renderer/"]
    : []);
  const excludePaths = options.excludePaths ?? [
    "packages/modules/electron-osr/src/main/",
    "simulation/ecs/ecs-",
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
        externalizeDepsPlugin({ exclude: ["@dimforge/rapier3d-compat", "@downdraft/module-electron-osr", "@downdraft/library-persistence", "recast-navigation"] }),
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
        exclude: optimizeDepsExcludeDefaults,
        include: [...autoOptimizeDepsInclude, ...(options.optimizeDepsInclude ?? [])],
        esbuildOptions: {
          plugins: [...(options.optimizeDepsEsbuildPlugins ?? [])],
          conditions: options.optimizeDepsEsbuildConditions,
        },
      },
      build: {
        outDir: "dist/renderer",
        sourcemap: "hidden",
        rollupOptions: {
          onwarn(warning: any, defaultHandler: (warning: any) => void) {
            if (warning.code === "ASSET_OVERWRITE" || (warning.message?.includes("overwrites a previously emitted file"))) {
              return;
            }
            defaultHandler(warning);
          },
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
        // Asset bake/optimization — intercepts bakeable `?url` imports and
        // emits optimized (meshopt + Basis KTX2 + normalized audio) assets.
        // Disabled via `assetBake: false` or DOWNDRAFT_BAKE=0.
        ...(options.assetBake === false ? [] : [downdraftAssetBakePlugin(options.assetBake ?? {})]),
        // Silence "Sourcemap for ... points to missing source files" warnings
        // from @bokuweb/zstd-wasm (excluded from dep pre-bundling above, so
        // served raw from node_modules — its .js.map files reference sources
        // the package author didn't publish). See silence-sourcemap-warnings-plugin.ts.
        silenceSourcemapWarningsPlugin(),
        // Exclude src/solid/** from the React plugin so it doesn't inject
        // React Refresh code (which references `window`) into the Solid worker
        // chunk. The Solid plugin (added via rendererPlugins) handles those files.
        react({ exclude: "**/src/solid/**" }),
        // WGSL validation — validates .wgsl files with the Tint CLI at
        // build/compile time. Runs before wgslHmrPlugin so malformed shaders
        // are caught before module creation. Disabled when Tint is unavailable
        // or DOWNDRAFT_SHADER_VALIDATE=0 (runtime validation still active).
        wgslValidatePlugin(),
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
        // Compile `new URL("./*.ts", import.meta.url)` scene-module references
        // into bundled JS chunks (fixes pixi-ui overlay in prod builds).
        sceneModuleUrlPlugin(),
        // Profiling prelude — injects `import "@downdraft/core/profiling/worker-prelude"`
        // into worker-entry files so IOPS patching, warning rules, and event-loop
        // monitoring are active before any worker code runs. Enabled by default
        // in dev; set `profiling: false` to disable, `profiling: "always"` for prod.
        ...(shouldEnableProfiling(options.profiling) ? [profilingPreludePlugin(typeof options.profiling === "object" ? options.profiling : undefined)] : []),
        ...(options.rendererPlugins ?? []),
      ],
    },
  });
}

// Re-export HTML generation types for games that need them
export type { CanvasLayer, DomLayer, DowndraftHtmlOptions, LayerSpec } from "./downdraft-html-plugin";
// Re-export asset bake types
export type { AssetBakeOptions, AssetBakePluginOptions } from "./asset-bake-plugin";
// Re-export profiling prelude types
export type { ProfilingPreludePluginOptions } from "./profiling-prelude-plugin";

/** Determine if profiling should be enabled based on the config option + env. */
function shouldEnableProfiling(profiling: DowndraftViteConfigOptions["profiling"]): boolean {
  if (profiling === false) return false;
  if (profiling === "always") return true;
  if (typeof profiling === "object") return true;
  // Default: enabled in dev, disabled in prod
  return process.env.NODE_ENV !== "production";
}

