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
//   - Excludes `@downdraft/engine/app/main`, `@downdraft/engine/app/preload`, and
//     `@downdraft/engine/modules/electron-osr` from the bundle (they're not imported
//     by the mobile entry, so they tree-shake out naturally).
//   - The mobile entry is `<root>/src/mobile.tsx` (not `main.tsx`), which
//     calls `createDowndraftMobileApp()` instead of `createDowndraftApp()`.
//
// Usage (from a game's `mobile.vite.config.ts`):
//
//   import { createDowndraftMobileViteConfig } from "@downdraft/engine/app/vite/mobile";
//   export default createDowndraftMobileViteConfig({ root: __dirname });
//

import { wgslHmrPlugin } from "@downdraft/engine/vite/wgsl-hmr-plugin";
import react from "@vitejs/plugin-react";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type PluginOption } from "vite";
import { downdraftAssetBakePlugin, type AssetBakePluginOptions } from "./asset-bake-plugin.ts";
import { downdraftHtmlPlugin, type DowndraftHtmlOptions, type LayerSpec } from "./downdraft-html-plugin.ts";
import { createEngineResolver } from "./engine-resolve.ts";
import { collectDirectDeps } from "./index.ts";
import { sceneModuleUrlPlugin } from "./scene-module-url-plugin.ts";
import { silenceSourcemapWarningsPlugin } from "./silence-sourcemap-warnings-plugin.ts";
import { workerUrlGuardPlugin } from "./worker-url-guard-plugin.ts";

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
  const engine = createEngineResolver(root);
  const game = options.game ?? root.split("/").pop()!;
  const entry = options.entry ?? resolve(root, "src/mobile.tsx");
  const rendererRoot = options.rendererRoot ?? root;

  // --- Auto-include direct deps for optimizeDeps (same as desktop config) ---
  const optimizeDepsExcludeDefaults = [
    "@bokuweb/zstd-wasm", "@h00w/basis-universal-transcoder", "recast-navigation",
    ...(options.optimizeDepsExclude ?? []),
  ];
  const excludeSet = new Set(optimizeDepsExcludeDefaults);
  const engineDeps = engine.engineDeps(excludeSet);
  const gameDeps = collectDirectDeps(resolve(root, "package.json"), excludeSet);
  const autoOptimizeDepsInclude = [...new Set([...engineDeps, ...gameDeps])];

  // --- Engine aliases (same compact set as the desktop config) ---
  // The @downdraft/engine package resolves on its own via node_modules +
  // its exports map; these aliases are a monorepo fallback that guarantees
  // source is served. Ordering: irregular subpaths first, deep rules before
  // bare-name rules, the core catch-all last.
  const E = engine.engineRoot;
  const engineAliases = [
    { find: /^@downdraft\/engine$/, replacement: resolve(E, "core/src/index.ts") },
    { find: /^@downdraft\/engine\/modules\/raw-input\/polyfill$/, replacement: resolve(E, "modules/raw-input/src/renderer/polyfill.ts") },
    { find: /^@downdraft\/engine\/libraries\/([^/]+)\/(.+)$/, replacement: `${E}/libraries/$1/src/$2` },
    { find: /^@downdraft\/engine\/libraries\/([^/]+)$/, replacement: `${E}/libraries/$1/src/index.ts` },
    { find: /^@downdraft\/engine\/modules\/([^/]+)\/(.+)$/, replacement: `${E}/modules/$1/src/$2` },
    { find: /^@downdraft\/engine\/modules\/([^/]+)$/, replacement: `${E}/modules/$1/src/index.ts` },
    { find: /^@downdraft\/engine\/app\/(.+)$/, replacement: `${E}/app/src/$1` },
    { find: /^@downdraft\/engine\/app$/, replacement: `${E}/app/src/index.ts` },
    { find: /^@downdraft\/engine\/(ui|shader-graph|mcp|test|asset-bake)\/(.+)$/, replacement: `${E}/$1/src/$2` },
    { find: /^@downdraft\/engine\/(ui|shader-graph|mcp|test|asset-bake)$/, replacement: `${E}/$1/src/index.ts` },
    { find: /^@downdraft\/engine\/(.+)$/, replacement: `${E}/core/src/$1` },
  ];

  // --- Renderer aliases (same set as desktop, minus electron-osr/main/preload) ---
  const rendererAliasEntries = [
    { find: "@renderer", replacement: resolve(rendererRoot, "src") },
    { find: "@shared", replacement: resolve(rendererRoot, "src/shared") },
    { find: "@sim", replacement: resolve(rendererRoot, "src/simulation") },
    // node builtins → renderer shims (must precede any engine code resolution)
    { find: /^node:fs$/, replacement: resolve(engine.src("app"), "renderer-shims/fs.ts") },
    { find: /^fs$/, replacement: resolve(engine.src("app"), "renderer-shims/fs.ts") },
    { find: /^node:path$/, replacement: resolve(engine.src("app"), "renderer-shims/path.ts") },
    { find: /^path$/, replacement: resolve(engine.src("app"), "renderer-shims/path.ts") },
    // Persistence — bare specifier resolves to the browser entry (excludes
    // node:fs/node:path which don't exist in the WebView).
    { find: /^@downdraft\/engine\/libraries\/persistence$/, replacement: resolve(E, "libraries/persistence/src/browser.ts") },
    ...engineAliases,
    ...(options.rendererAliases ?? []),
  ];

  engine.warnUndeclared();

  // --- HTML generation ---
  // The mobile entry is src/mobile.tsx (not src/main.tsx). Always inject the
  // entry path into the HTML options, even when the game provides a custom
  // html config (without an explicit entry, the HTML plugin would default to
  // /src/main.tsx — the desktop entry — and the mobile touch/OSD code would
  // never be bundled).
  const mobileEntryPath = entry.replace(rendererRoot, "").replace(/\\/g, "/");
  const htmlOpts: DowndraftHtmlOptions | null = options.html === false
    ? null
    : {
        title: game,
        layers: options.layers ?? [
          { type: "canvas", id: "game-canvas" },
          { type: "dom", id: "root" },
        ],
        ...options.html,
        entry: options.html?.entry ?? mobileEntryPath,
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
    server: {
      fs: {
        // Engine sources may resolve outside the game root (symlinked
        // workspace checkouts, bun link, file: deps). repoRoot covers deps
        // hoisted to the monorepo node_modules (e.g. runtime-fetched wasm).
        allow: [rendererRoot, root, engine.engineRoot, engine.repoRoot ?? root],
      },
    },
    worker: {
      format: "es",
      plugins: (() => options.workerPlugins ?? []) as any,
      rollupOptions: {
        output: {
          // Force pixi.js + @pixi/react into a single chunk in the worker bundle.
          // Without this, Vite splits pixi.js across the worker entry chunk and
          // a shared chunk, creating duplicate Texture.WHITE instances. The
          // TextStyle fill setter sets fill.texture = Texture.WHITE from one
          // chunk, but getCanvasFillStyle compares against Texture.WHITE from
          // the other chunk — the reference equality check fails, causing solid
          // color fills to fall through to createPattern() with an invalid
          // Uint8Array resource, which throws.
          manualChunks(id) {
            if (
              id.includes("/pixi.js/") ||
              id.includes("/@pixi/react/") ||
              id.includes("/@downdraft/engine/libraries/pixi-ui/")
            ) {
              return "pixi-worker-bundle";
            }
          },
        },
      },
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
        output: {
          // Force pixi.js + @pixi/react into a single named chunk in the main
          // bundle. This prevents Vite from creating a shared chunk that
          // contains some pixi.js modules (with their own Texture.WHITE) which
          // would then be imported by the worker, creating a duplicate
          // Texture.WHITE reference. The worker has its own manualChunks in
          // worker.rollupOptions that creates a separate pixi-worker-bundle.
          manualChunks(id) {
            if (
              id.includes("/pixi.js/") ||
              id.includes("/@pixi/react/")
            ) {
              return "pixi-main-bundle";
            }
          },
        },
      },
    },
    plugins: [
      ...(htmlOpts ? [downdraftHtmlPlugin(htmlOpts)] : []),
      // Asset bake/optimization (textures especially matter for mobile).
      ...(options.assetBake === false ? [] : [downdraftAssetBakePlugin(options.assetBake ?? {})]),
      silenceSourcemapWarningsPlugin(),
      react({ exclude: "**/src/solid/**" }),
      wgslHmrPlugin(resolve(engine.src("core"), "render/wgsl-hmr.ts")),
      workerUrlGuardPlugin(),
      sceneModuleUrlPlugin(),
      ...(options.rendererPlugins ?? []),
    ],
  });
}
