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

import { hotReloadPlugin } from "@downdraft/core/vite/hot-reload-plugin";
import { wgslHmrPlugin } from "@downdraft/core/vite/wgsl-hmr-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "path";
import { downdraftAssetBakePlugin, type AssetBakePluginOptions } from "./asset-bake-plugin.ts";
import { downdraftHtmlPlugin, type DowndraftHtmlOptions, type LayerSpec } from "./downdraft-html-plugin.ts";
import { createEngineResolver } from "./engine-resolve.ts";
import { profilingPreludePlugin, type ProfilingPreludePluginOptions } from "./profiling-prelude-plugin.ts";
import { sceneModuleUrlPlugin } from "./scene-module-url-plugin.ts";
import { silenceSourcemapWarningsPlugin } from "./silence-sourcemap-warnings-plugin.ts";
import { wgslValidatePlugin } from "./wgsl-validate-plugin.ts";
import { workerUrlGuardPlugin } from "./worker-url-guard-plugin.ts";

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
      // Same for engine packages — aliased to their src/ dirs.
      if (name.startsWith("@downdraft/")) return false;
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
  // electron-vite spawns the Electron binary with our env. If the host shell
  // exported ELECTRON_RUN_AS_NODE=1 (some tooling does), the spawned "app"
  // runs as plain Node: require("electron") resolves to the npm shim and
  // every API is missing. Strip it so dev always launches a real app.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const { root } = options;
  // Resolves @downdraft/* packages via Node resolution (workspace symlinks in
  // the monorepo, node_modules in standalone games). `engine.repoRoot` is the
  // monorepo root when detected, else null.
  const engine = createEngineResolver(root);
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
  const engineDeps = engine.engineDeps(excludeSet);
  const gameDeps = collectDirectDeps(resolve(root, "package.json"), excludeSet);
  const autoOptimizeDepsInclude = [...new Set([...engineDeps, ...gameDeps])];

  // --- Workspace deps must never be externalized ---
  // externalizeDepsPlugin() reads <cwd>/package.json, so when dev is launched
  // from the game directory (draft dev), the game's `workspace:*` deps leak
  // into the main/preload bundles as runtime require()s. Those packages map
  // their exports to .ts source that Node can't load (directory + extensionless
  // imports), so the app crashes with ERR_UNSUPPORTED_DIR_IMPORT on startup.
  // Excluding them lets the resolve.alias entries above bundle them instead.
  let workspaceDeps: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
    const deps: Record<string, string> = pkg.dependencies ?? {};
    // Aliased-to-source packages must be bundled, not externalized: workspace
    // deps (game-internal modules) and every @downdraft/* engine package.
    workspaceDeps = Object.keys(deps).filter(
      (name) => deps[name] === "workspace:*" || name.startsWith("@downdraft/"),
    );
  } catch { /* no package.json — nothing to exclude */ }

  // Subpath imports the dep scanner can't see (side-effect imports inside Web
  // Workers get discovered mid-session → re-optimize → stale chunk URLs →
  // "Failed to fetch dynamically imported module" inside the worker). When a
  // package is already included, force its known worker-side subpaths in too.
  const subpathDeps: Record<string, string[]> = {
    "pixi.js": ["pixi.js/events"],
  };
  for (const dep of autoOptimizeDepsInclude) {
    for (const sub of subpathDeps[dep] ?? []) {
      if (!autoOptimizeDepsInclude.includes(sub)) autoOptimizeDepsInclude.push(sub);
    }
  }

  // --- Shared alias sets ---

  const coreAliases = [
    { find: /^@downdraft\/core$/, replacement: resolve(engine.src("@downdraft/core", "core"), "index.ts") },
    { find: /^@downdraft\/core\//, replacement: engine.src("@downdraft/core", "core") + "/" },
  ];

  const mainAliases = [
    { find: "@main", replacement: resolve(engine.src("@downdraft/app", "app"), "main") },
    { find: "@shared", replacement: resolve(engine.src("@downdraft/app", "app"), "shared") },
    ...coreAliases,
    { find: /^@downdraft\/mcp\//, replacement: engine.src("@downdraft/mcp", "mcp") + "/" },
    { find: /^@downdraft\/mcp$/, replacement: resolve(engine.src("@downdraft/mcp", "mcp"), "index.ts") },
    { find: /^@downdraft\/shader-graph$/, replacement: resolve(engine.src("@downdraft/shader-graph", "shader-graph"), "index.ts") },
    { find: /^@downdraft\/shader-graph\//, replacement: engine.src("@downdraft/shader-graph", "shader-graph") + "/" },
    { find: /^@downdraft\/module-electron-osr$/, replacement: resolve(engine.src("@downdraft/module-electron-osr", "modules/electron-osr"), "index.ts") },
    { find: /^@downdraft\/module-electron-osr\/main-entry$/, replacement: resolve(engine.src("@downdraft/module-electron-osr", "modules/electron-osr"), "main-entry.ts") },
    { find: /^@downdraft\/module-electron-osr\//, replacement: engine.src("@downdraft/module-electron-osr", "modules/electron-osr") + "/" },
    { find: /^@downdraft\/module-raw-input$/, replacement: resolve(engine.src("@downdraft/module-raw-input", "modules/raw-input"), "index.ts") },
    { find: /^@downdraft\/module-raw-input\/main-entry$/, replacement: resolve(engine.src("@downdraft/module-raw-input", "modules/raw-input"), "main-entry.ts") },
    { find: /^@downdraft\/module-raw-input\/polyfill$/, replacement: resolve(engine.src("@downdraft/module-raw-input", "modules/raw-input"), "renderer/polyfill.ts") },
    { find: /^@downdraft\/module-raw-input\//, replacement: engine.src("@downdraft/module-raw-input", "modules/raw-input") + "/" },
    { find: /^@downdraft\/library-persistence$/, replacement: resolve(engine.src("@downdraft/library-persistence", "libraries/persistence"), "index.ts") },
    { find: /^@downdraft\/library-persistence\/browser$/, replacement: resolve(engine.src("@downdraft/library-persistence", "libraries/persistence"), "browser.ts") },
    { find: /^@downdraft\/library-persistence\//, replacement: engine.src("@downdraft/library-persistence", "libraries/persistence") + "/" },
    // library-models — dynamically imported by core's loader-mesh.ts; needs to
    // be resolvable in the main process build.
    { find: /^@downdraft\/library-models$/, replacement: resolve(engine.src("@downdraft/library-models", "libraries/models"), "index.ts") },
    { find: /^@downdraft\/library-models\//, replacement: engine.src("@downdraft/library-models", "libraries/models") + "/" },
    // @downdraft/app subpath exports — resolve to source for dev builds
    { find: /^@downdraft\/app\/main$/, replacement: resolve(engine.src("@downdraft/app", "app"), "main/index.ts") },
    { find: /^@downdraft\/app\/preload$/, replacement: resolve(engine.src("@downdraft/app", "app"), "preload/index.ts") },
    { find: /^@downdraft\/app\/shared$/, replacement: resolve(engine.src("@downdraft/app", "app"), "shared/index.ts") },
    { find: /^@downdraft\/app\/vite$/, replacement: resolve(engine.src("@downdraft/app", "app"), "vite/index.ts") },
    { find: /^@downdraft\/app$/, replacement: resolve(engine.src("@downdraft/app", "app"), "index.ts") },
    ...(options.mainAliases ?? []),
  ];

  const rendererAliasEntries = [
    { find: "@renderer", replacement: resolve(rendererRoot, "src") },
    { find: "@shared", replacement: resolve(rendererRoot, "src/shared") },
    { find: "@sim", replacement: resolve(rendererRoot, "src/simulation") },
    ...coreAliases,
    { find: /^@downdraft\/ui$/, replacement: resolve(engine.src("@downdraft/ui", "ui"), "index.ts") },
    { find: /^@downdraft\/ui\//, replacement: engine.src("@downdraft/ui", "ui") + "/" },
    { find: /^@downdraft\/shader-graph$/, replacement: resolve(engine.src("@downdraft/shader-graph", "shader-graph"), "index.ts") },
    { find: /^@downdraft\/shader-graph\//, replacement: engine.src("@downdraft/shader-graph", "shader-graph") + "/" },
    // Persistence — browser entry excludes FileSaveStore (node:fs/node:path)
    { find: /^@downdraft\/library-persistence\/browser$/, replacement: resolve(engine.src("@downdraft/library-persistence", "libraries/persistence"), "browser.ts") },
    { find: /^@downdraft\/library-persistence$/, replacement: resolve(engine.src("@downdraft/library-persistence", "libraries/persistence"), "browser.ts") },
    { find: /^@downdraft\/library-persistence\//, replacement: engine.src("@downdraft/library-persistence", "libraries/persistence") + "/" },
    { find: /^@downdraft\/library-sand$/, replacement: resolve(engine.src("@downdraft/library-sand", "libraries/sand"), "index.ts") },
    { find: /^@downdraft\/library-sand\//, replacement: engine.src("@downdraft/library-sand", "libraries/sand") + "/" },
    { find: /^@downdraft\/library-lighting$/, replacement: resolve(engine.src("@downdraft/library-lighting", "libraries/lighting"), "index.ts") },
    { find: /^@downdraft\/library-lighting\//, replacement: engine.src("@downdraft/library-lighting", "libraries/lighting") + "/" },
    { find: /^@downdraft\/library-weatherfx$/, replacement: resolve(engine.src("@downdraft/library-weatherfx", "libraries/weatherfx"), "index.ts") },
    { find: /^@downdraft\/library-weatherfx\//, replacement: engine.src("@downdraft/library-weatherfx", "libraries/weatherfx") + "/" },
    { find: /^@downdraft\/library-weather$/, replacement: resolve(engine.src("@downdraft/library-weather", "libraries/weather"), "index.ts") },
    { find: /^@downdraft\/library-weather\//, replacement: engine.src("@downdraft/library-weather", "libraries/weather") + "/" },
    { find: /^@downdraft\/library-entities$/, replacement: resolve(engine.src("@downdraft/library-entities", "libraries/entities"), "index.ts") },
    { find: /^@downdraft\/library-entities\//, replacement: engine.src("@downdraft/library-entities", "libraries/entities") + "/" },
    { find: /^@downdraft\/library-stickman$/, replacement: resolve(engine.src("@downdraft/library-stickman", "libraries/stickman"), "index.ts") },
    { find: /^@downdraft\/library-stickman\//, replacement: engine.src("@downdraft/library-stickman", "libraries/stickman") + "/" },
    { find: /^@downdraft\/library-models$/, replacement: resolve(engine.src("@downdraft/library-models", "libraries/models"), "index.ts") },
    { find: /^@downdraft\/library-models\//, replacement: engine.src("@downdraft/library-models", "libraries/models") + "/" },
    { find: /^@downdraft\/module-devtools$/, replacement: resolve(engine.src("@downdraft/module-devtools", "modules/devtools"), "index.ts") },
    { find: /^@downdraft\/module-devtools\//, replacement: engine.src("@downdraft/module-devtools", "modules/devtools") + "/" },
    { find: /^@downdraft\/module-terrain$/, replacement: resolve(engine.src("@downdraft/module-terrain", "modules/terrain"), "index.ts") },
    { find: /^@downdraft\/module-terrain\//, replacement: engine.src("@downdraft/module-terrain", "modules/terrain") + "/" },
    { find: /^@downdraft\/module-movement-3d$/, replacement: resolve(engine.src("@downdraft/module-movement-3d", "modules/movement-3d"), "index.ts") },
    { find: /^@downdraft\/module-movement-3d\//, replacement: engine.src("@downdraft/module-movement-3d", "modules/movement-3d") + "/" },
    { find: /^@downdraft\/module-movement-2d$/, replacement: resolve(engine.src("@downdraft/module-movement-2d", "modules/movement-2d"), "index.ts") },
    { find: /^@downdraft\/module-movement-2d\//, replacement: engine.src("@downdraft/module-movement-2d", "modules/movement-2d") + "/" },
    { find: /^@downdraft\/module-vitals$/, replacement: resolve(engine.src("@downdraft/module-vitals", "modules/vitals"), "index.ts") },
    { find: /^@downdraft\/module-vitals\//, replacement: engine.src("@downdraft/module-vitals", "modules/vitals") + "/" },
    { find: /^@downdraft\/module-sailing$/, replacement: resolve(engine.src("@downdraft/module-sailing", "modules/sailing"), "index.ts") },
    { find: /^@downdraft\/module-sailing\//, replacement: engine.src("@downdraft/module-sailing", "modules/sailing") + "/" },
    { find: /^@downdraft\/module-camera-controls$/, replacement: resolve(engine.src("@downdraft/module-camera-controls", "modules/camera-controls"), "index.ts") },
    { find: /^@downdraft\/module-camera-controls\//, replacement: engine.src("@downdraft/module-camera-controls", "modules/camera-controls") + "/" },
    { find: /^@downdraft\/library-pixi-ui$/, replacement: resolve(engine.src("@downdraft/library-pixi-ui", "libraries/pixi-ui"), "index.ts") },
    { find: /^@downdraft\/library-pixi-ui\//, replacement: engine.src("@downdraft/library-pixi-ui", "libraries/pixi-ui") + "/" },
    { find: /^@downdraft\/library-profiler$/, replacement: resolve(engine.src("@downdraft/library-profiler", "libraries/profiler"), "index.ts") },
    { find: /^@downdraft\/library-profiler\//, replacement: engine.src("@downdraft/library-profiler", "libraries/profiler") + "/" },
    { find: /^node:fs$/, replacement: resolve(engine.src("@downdraft/app", "app"), "renderer-shims/fs.ts") },
    { find: /^fs$/, replacement: resolve(engine.src("@downdraft/app", "app"), "renderer-shims/fs.ts") },
    { find: /^node:path$/, replacement: resolve(engine.src("@downdraft/app", "app"), "renderer-shims/path.ts") },
    { find: /^path$/, replacement: resolve(engine.src("@downdraft/app", "app"), "renderer-shims/path.ts") },
    { find: /^node:url$/, replacement: resolve(engine.src("@downdraft/app", "app"), "renderer-shims/url.ts") },
    { find: /^@downdraft\/library-marching-cubes$/, replacement: resolve(engine.src("@downdraft/library-marching-cubes", "libraries/marching-cubes"), "index.ts") },
    { find: /^@downdraft\/library-marching-cubes\//, replacement: engine.src("@downdraft/library-marching-cubes", "libraries/marching-cubes") + "/" },
    { find: /^@downdraft\/library-character$/, replacement: resolve(engine.src("@downdraft/library-character", "libraries/character"), "index.ts") },
    { find: /^@downdraft\/library-character\//, replacement: engine.src("@downdraft/library-character", "libraries/character") + "/" },
    { find: /^@downdraft\/library-pathfinding-2d$/, replacement: resolve(engine.src("@downdraft/library-pathfinding-2d", "libraries/pathfinding-2d"), "index.ts") },
    { find: /^@downdraft\/library-pathfinding-2d\//, replacement: engine.src("@downdraft/library-pathfinding-2d", "libraries/pathfinding-2d") + "/" },
    { find: /^@downdraft\/library-navmesh$/, replacement: resolve(engine.src("@downdraft/library-navmesh", "libraries/navmesh"), "index.ts") },
    { find: /^@downdraft\/library-navmesh\//, replacement: engine.src("@downdraft/library-navmesh", "libraries/navmesh") + "/" },
    { find: /^@downdraft\/library-recast$/, replacement: resolve(engine.src("@downdraft/library-recast", "libraries/recast"), "index.ts") },
    { find: /^@downdraft\/library-recast\//, replacement: engine.src("@downdraft/library-recast", "libraries/recast") + "/" },
    { find: /^@downdraft\/library-water$/, replacement: resolve(engine.src("@downdraft/library-water", "libraries/water"), "index.ts") },
    { find: /^@downdraft\/library-water\//, replacement: engine.src("@downdraft/library-water", "libraries/water") + "/" },
    { find: /^@downdraft\/library-postfx$/, replacement: resolve(engine.src("@downdraft/library-postfx", "libraries/postfx"), "index.ts") },
    { find: /^@downdraft\/library-postfx\//, replacement: engine.src("@downdraft/library-postfx", "libraries/postfx") + "/" },
    // Game-owned plugin aliases are registered by each game's own
    // electron.vite.config.ts via `rendererAliases` — the engine config
    // must not hardcode any specific game's plugin paths.
    { find: /^@downdraft\/mcp$/, replacement: resolve(engine.src("@downdraft/mcp", "mcp"), "index.ts") },
    { find: /^@downdraft\/mcp\//, replacement: engine.src("@downdraft/mcp", "mcp") + "/" },
    { find: /^@downdraft\/module-electron-osr$/, replacement: resolve(engine.src("@downdraft/module-electron-osr", "modules/electron-osr"), "index.ts") },
    { find: /^@downdraft\/module-electron-osr\//, replacement: engine.src("@downdraft/module-electron-osr", "modules/electron-osr") + "/" },
    { find: /^@downdraft\/module-raw-input$/, replacement: resolve(engine.src("@downdraft/module-raw-input", "modules/raw-input"), "index.ts") },
    { find: /^@downdraft\/module-raw-input\/polyfill$/, replacement: resolve(engine.src("@downdraft/module-raw-input", "modules/raw-input"), "renderer/polyfill.ts") },
    { find: /^@downdraft\/module-raw-input\//, replacement: engine.src("@downdraft/module-raw-input", "modules/raw-input") + "/" },
    // @downdraft/app renderer accessor + base CSS
    { find: /^@downdraft\/app\/renderer$/, replacement: resolve(engine.src("@downdraft/app", "app"), "renderer/index.ts") },
    { find: /^@downdraft\/app\/renderer\/downdraft-base\.css$/, replacement: resolve(engine.src("@downdraft/app", "app"), "renderer/downdraft-base.css") },
    { find: /^@downdraft\/app\/shared$/, replacement: resolve(engine.src("@downdraft/app", "app"), "shared/index.ts") },
    { find: /^@downdraft\/app$/, replacement: resolve(engine.src("@downdraft/app", "app"), "index.ts") },
    ...(options.rendererAliases ?? []),
  ];

  engine.warnUndeclared();

  // --- Hot-reload config ---
  // Games with a sim worker pass simPaths to trigger worker swap (with ack).
  // Games without a sim worker let Vite's native HMR handle everything.
  // Game-specific plugin paths (e.g. games/<game>/plugins/) must be supplied
  // by the game's own electron.vite.config.ts — the engine defaults only
  // cover engine-owned directories.
  const hasSimWorker = existsSync(resolve(rendererRoot, "src/simulation"));
  // Path patterns are substring-matched against absolute file paths. The
  // `packages/*` forms cover the monorepo layout; the `/@downdraft/*` forms
  // cover standalone games where engine packages live under node_modules
  // (or any other install location — the scope name is the invariant).
  const simPaths = options.simPaths ?? (hasSimWorker
    ? ["simulation/", "shared/",
       "packages/core/", "packages/modules/", "packages/libraries/",
       "/@downdraft/core/", "/@downdraft/module-", "/@downdraft/library-"]
    : []);
  const rendererPaths = options.rendererPaths ?? (hasSimWorker
    ? ["engine/", "stores/",
       "packages/modules/electron-osr/src/renderer/",
       "/@downdraft/module-electron-osr/src/renderer/"]
    : []);
  const excludePaths = options.excludePaths ?? [
    "packages/modules/electron-osr/src/main/",
    "/@downdraft/module-electron-osr/src/main/",
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
        externalizeDepsPlugin({ exclude: ["@dimforge/rapier3d-compat", "recast-navigation", ...workspaceDeps] }),
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
        externalizeDepsPlugin({ exclude: workspaceDeps }),
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
          { find: "@shared", replacement: resolve(engine.src("@downdraft/app", "app"), "shared") },
          { find: "@downdraft/app/preload", replacement: resolve(engine.src("@downdraft/app", "app"), "preload/index.ts") },
          { find: "@downdraft/app/shared", replacement: resolve(engine.src("@downdraft/app", "app"), "shared/index.ts") },
          { find: "@downdraft/app", replacement: resolve(engine.src("@downdraft/app", "app"), "index.ts") },
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
        fs: {
          // Engine sources may live outside the game root — symlinked
          // workspace/monorepo checkouts, `bun link`, or `file:` deps all
          // resolve to real paths Vite must be allowed to serve. The parent
          // dir of the resolved core package covers every @downdraft/*
          // package in both layouts (packages/ in the monorepo,
          // node_modules/@downdraft/ in standalone installs).
          allow: [rendererRoot, root, dirname(engine.pkg("@downdraft/core", "core"))],
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
        wgslHmrPlugin(resolve(engine.src("@downdraft/core", "core"), "render/wgsl-hmr.ts")),
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

// Re-export the engine resolver for game configs that build custom aliases
export { createEngineResolver, type EngineResolver } from "./engine-resolve.ts";
// Re-export HTML generation types for games that need them
export type { CanvasLayer, DomLayer, DowndraftHtmlOptions, LayerSpec } from "./downdraft-html-plugin.ts";
// Re-export asset bake types
export type { AssetBakeOptions, AssetBakePluginOptions } from "./asset-bake-plugin.ts";
// Re-export profiling prelude types
export type { ProfilingPreludePluginOptions } from "./profiling-prelude-plugin.ts";

/** Determine if profiling should be enabled based on the config option + env. */
function shouldEnableProfiling(profiling: DowndraftViteConfigOptions["profiling"]): boolean {
  if (profiling === false) return false;
  if (profiling === "always") return true;
  if (typeof profiling === "object") return true;
  // Default: enabled in dev, disabled in prod
  return process.env.NODE_ENV !== "production";
}

