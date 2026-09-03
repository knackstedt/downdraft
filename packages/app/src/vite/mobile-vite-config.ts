// ============================================================================
// createDowndraftMobileViteConfig() — Vite build config for mobile (Capacitor)
// ============================================================================
//
// This is a web-only Vite config (no electron-vite, no main/preload process).
// It produces a single `dist/mobile/` web bundle (renderer + workers + assets)
// that Capacitor wraps in the system WebView (Android System WebView / iOS
// WKWebView).
//
// It reuses the same alias sets, HTML generation, and WGSL HMR plugin as the
// desktop `createDowndraftViteConfig()`, but:
//   - Drops the `main` and `preload` build targets (no Electron).
//   - Sets `build.target` to "esnext" for modern WebView engines.
//   - Sets `worker.format: "es"` for ES module workers.
//   - Excludes `@downdraft/app/main`, `@downdraft/app/preload`, and
//     `@downdraft/module-electron-osr` from the bundle (they're not imported
//     by the mobile entry, so they tree-shake out naturally).
//   - The mobile entry is `<root>/src/mobile.tsx` (not `main.tsx`), which
//     calls `createDowndraftMobileApp()` instead of `createDowndraftApp()`.
//
// Usage (from a game's `mobile.vite.config.ts`):
//
//   import { createDowndraftMobileViteConfig } from "@downdraft/app/vite/mobile";
//   export default createDowndraftMobileViteConfig({ root: __dirname });
//

import react from "@vitejs/plugin-react";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type PluginOption } from "vite";
import { wgslHmrPlugin } from "../../../core/src/vite/wgsl-hmr-plugin";
import { downdraftAssetBakePlugin, type AssetBakePluginOptions } from "./asset-bake-plugin";
import { downdraftHtmlPlugin, type DowndraftHtmlOptions, type LayerSpec } from "./downdraft-html-plugin";
import { collectDirectDeps } from "./index";
import { sceneModuleUrlPlugin } from "./scene-module-url-plugin";
import { silenceSourcemapWarningsPlugin } from "./silence-sourcemap-warnings-plugin";
import { workerUrlGuardPlugin } from "./worker-url-guard-plugin";

export interface DowndraftMobileViteConfigOptions {
  /** The game directory (usually `__dirname` from the game's mobile.vite.config.ts). */
  root: string;
  /** Mobile entry script (default: `<root>/src/mobile.tsx`). */
  entry?: string;
  /** Renderer root directory (default: `<root>`). Must contain `index.html` unless `html` is set. */
  rendererRoot?: string;
  /** Game name — used for the HTML title. Defaults to basename(root). */
  game?: string;
  /** Additional renderer aliases to merge. */
  rendererAliases?: Array<{ find: string | RegExp; replacement: string }>;
  /** Additional vite plugins for the renderer build. */
  rendererPlugins?: PluginOption[];
  /** Additional vite plugins applied only to worker bundles. */
  workerPlugins?: PluginOption[];
  /** Additional Rollup entry inputs (e.g. separate worker chunks). */
  extraRollupInputs?: Array<{ name: string; path: string }>;
  /** Additional packages to exclude from Vite's dep pre-bundling. */
  optimizeDepsExclude?: string[];
  /** Additional packages to include in Vite's dep pre-bundling. */
  optimizeDepsInclude?: string[];
  /**
   * HTML generation config. When provided, the framework generates index.html
   * from a layer spec. Defaults to one canvas + one DOM root with the mobile
   * entry script.
   */
  html?: DowndraftHtmlOptions | false;
  /** Convenience shorthand for `html.layers`. */
  layers?: LayerSpec[];
  /**
   * Asset bake/optimization step (same as desktop). When enabled, glTF/GLB/
   * audio `?url` imports are baked into optimized formats. Set to `false` to
   * disable. Disabled when `DOWNDRAFT_BAKE=0`.
   */
  assetBake?: AssetBakePluginOptions | false;
}

export function createDowndraftMobileViteConfig(
  options: DowndraftMobileViteConfigOptions,
): ReturnType<typeof defineConfig> {
  const { root } = options;
  const repoRoot = resolve(root, "../..");
  const game = options.game ?? root.split("/").pop()!;
  const entry = options.entry ?? resolve(root, "src/mobile.tsx");
  const rendererRoot = options.rendererRoot ?? root;

  // --- Auto-include direct deps for optimizeDeps (same as desktop config) ---
  const optimizeDepsExcludeDefaults = [
    "@bokuweb/zstd-wasm", "@h00w/basis-universal-transcoder", "recast-navigation",
    ...(options.optimizeDepsExclude ?? []),
  ];
  const excludeSet = new Set(optimizeDepsExcludeDefaults);
  const engineDeps = collectDirectDeps(resolve(repoRoot, "package.json"), excludeSet);
  const gameDeps = collectDirectDeps(resolve(root, "package.json"), excludeSet);
  const autoOptimizeDepsInclude = [...new Set([...engineDeps, ...gameDeps])];

  // --- Shared core aliases (same as the desktop config) ---
  const coreAliases = [
    { find: /^@downdraft\/core$/, replacement: resolve(repoRoot, "packages/core/src/index.ts") },
    { find: /^@downdraft\/core\//, replacement: resolve(repoRoot, "packages/core/src") + "/" },
  ];

  // --- Renderer aliases (same set as desktop, minus electron-osr/main/preload) ---
  const rendererAliasEntries = [
    { find: "@renderer", replacement: resolve(rendererRoot, "src") },
    { find: "@shared", replacement: resolve(rendererRoot, "src/shared") },
    { find: "@sim", replacement: resolve(rendererRoot, "src/simulation") },
    ...coreAliases,
    { find: /^@downdraft\/ui$/, replacement: resolve(repoRoot, "packages/ui/src/index.ts") },
    { find: /^@downdraft\/ui\//, replacement: resolve(repoRoot, "packages/ui/src") + "/" },
    { find: /^@downdraft\/shader-graph$/, replacement: resolve(repoRoot, "packages/shader-graph/src/index.ts") },
    { find: /^@downdraft\/shader-graph\//, replacement: resolve(repoRoot, "packages/shader-graph/src") + "/" },
    // Persistence — browser entry (excludes node:fs/node:path)
    { find: /^@downdraft\/library-persistence\/browser$/, replacement: resolve(repoRoot, "packages/libraries/persistence/src/browser.ts") },
    { find: /^@downdraft\/library-persistence$/, replacement: resolve(repoRoot, "packages/libraries/persistence/src/browser.ts") },
    { find: /^@downdraft\/library-persistence\//, replacement: resolve(repoRoot, "packages/libraries/persistence/src") + "/" },
    // Engine libraries
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
    // Engine plugins (excluding electron-osr — not used on mobile)
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
    // MCP (renderer-side harness, used by some games for dev automation)
    { find: /^@downdraft\/mcp$/, replacement: resolve(repoRoot, "packages/mcp/src/index.ts") },
    { find: /^@downdraft\/mcp\//, replacement: resolve(repoRoot, "packages/mcp/src") + "/" },
    // @downdraft/app mobile + renderer accessor + base CSS
    { find: /^@downdraft\/app\/mobile$/, replacement: resolve(repoRoot, "packages/app/src/mobile/index.ts") },
    { find: /^@downdraft\/app\/renderer$/, replacement: resolve(repoRoot, "packages/app/src/renderer/index.ts") },
    { find: /^@downdraft\/app\/renderer\/downdraft-base\.css$/, replacement: resolve(repoRoot, "packages/app/src/renderer/downdraft-base.css") },
    { find: /^@downdraft\/app\/shared$/, replacement: resolve(repoRoot, "packages/app/src/shared/index.ts") },
    { find: /^@downdraft\/app$/, replacement: resolve(repoRoot, "packages/app/src/index.ts") },
    ...(options.rendererAliases ?? []),
  ];

  // --- HTML generation ---
  const htmlOpts: DowndraftHtmlOptions | null = options.html === false
    ? null
    : options.html ?? {
        title: game,
        layers: options.layers ?? [
          { type: "canvas", id: "game-canvas" },
          { type: "dom", id: "root" },
        ],
        // Mobile entry is src/mobile.tsx, not src/main.tsx
        entry: entry.replace(rendererRoot, "").replace(/\\/g, "/"),
      };

  // Ensure index.html exists for the rollup input.
  const indexHtmlPath = resolve(rendererRoot, "index.html");
  if (htmlOpts && !existsSync(indexHtmlPath)) {
    mkdirSync(resolve(rendererRoot), { recursive: true });
    writeFileSync(indexHtmlPath, "<!-- downdraft: generated -->\n", "utf-8");
  }

  return defineConfig({
    // Plain Vite config (not electron-vite) — web-only build for Capacitor
    root: rendererRoot,
    base: "./", // relative paths for file:// or http://localhost loading
    resolve: {
      alias: rendererAliasEntries,
      dedupe: ["react", "react-dom"],
    },
    worker: {
      format: "es",
      plugins: (() => options.workerPlugins ?? []) as any,
    },
    optimizeDeps: {
      exclude: optimizeDepsExcludeDefaults,
      include: [...autoOptimizeDepsInclude, ...(options.optimizeDepsInclude ?? [])],
    },
    build: {
      outDir: "dist/mobile",
      target: "esnext", // modern WebView (Android 121+, iOS 26+)
      sourcemap: "hidden",
      chunkSizeWarningLimit: 2000, // mobile bundle includes engine + game in one chunk
      rollupOptions: {
        onwarn(warning, defaultHandler) {
          // Suppress "emitted file overwrites a previously emitted file" warnings.
          // These occur when worker bundles and the main bundle emit sourcemap
          // files with colliding names — harmless because hidden sourcemaps are
          // not loaded at runtime.
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
        // Externalize Capacitor runtime packages — they're provided by the
        // native shell at runtime (not bundled into the web assets). The
        // mobile-bridge.ts uses dynamic import() with @vite-ignore, but Rollup
        // still needs them listed as external to avoid resolution errors.
        external: [
          /^@capacitor\//,
        ],
      },
    },
    plugins: [
      ...(htmlOpts ? [downdraftHtmlPlugin(htmlOpts)] : []),
      // Asset bake/optimization (textures especially matter for mobile).
      ...(options.assetBake === false ? [] : [downdraftAssetBakePlugin(options.assetBake ?? {})]),
      silenceSourcemapWarningsPlugin(),
      react({ exclude: "**/src/solid/**" }),
      wgslHmrPlugin(repoRoot),
      workerUrlGuardPlugin(),
      sceneModuleUrlPlugin(),
      ...(options.rendererPlugins ?? []),
    ],
  });
}
