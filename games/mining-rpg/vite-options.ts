// ============================================================================
// vite-options — custom Vite options for mining-rpg.
//
// These options are loaded by the game's own electron.vite.config.ts
// (games/mining-rpg/electron.vite.config.ts). They configure the
// Solid-in-worker UI:
//   - workerPlugins: Solid plugin for worker bundles
//   - rendererPlugins: Solid plugin (scoped to src/solid/**), URL replacement plugin
//   - extraRollupInputs: Worker entry as a separate Rollup chunk
//
// This file exports a FACTORY FUNCTION rather than a static object so the
// game's electron.vite.config.ts can resolve `vite-plugin-solid` from the
// game's node_modules (the root workspace doesn't have it as a dependency).
//
// For standalone builds (cd games/mining-rpg && npx electron-vite build),
// the electron.vite.config.ts in this directory calls this factory directly.
// ============================================================================

import { createRequire } from "node:module";
import type { Plugin } from "vite";
import type { DowndraftViteConfigOptions } from "@downdraft/app/vite";

// Create a require relative to this file so we can resolve solid-js from
// the game's node_modules. This works in both CJS and ESM contexts.
const gameRequire = createRequire(import.meta.url ?? __filename);
const { readFileSync } = gameRequire("node:fs");

// Replaces __SOLID_WORKER_URL__ in the main bundle with the emitted worker
// chunk's URL. Uses generateBundle to find the worker filename and patch the
// main bundle's code before it's written to disk.
function solidWorkerUrlPlugin(): Plugin {
  const workerEntryPath = "src/solid/worker-entry.ts";

  return {
    name: "solid-worker-url",
    apply: "build",
    generateBundle(_opts, bundle) {
      let workerFileName: string | null = null;
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === "chunk" && chunk.facadeModuleId?.includes(workerEntryPath)) {
          workerFileName = fileName;
          break;
        }
      }
      if (!workerFileName) return;
      const workerUrl = JSON.stringify("/" + workerFileName);
      for (const [, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue;
        if (chunk.code && chunk.code.includes("__SOLID_WORKER_URL__")) {
          chunk.code = chunk.code.replace(/__SOLID_WORKER_URL__/g, workerUrl);
        }
      }
    },
  };
}

/**
 * Esbuild plugin for Vite's dep pre-bundler that overrides solid-js resolution.
 * Forces the browser (reactive) build instead of the server build that the
 * "worker" export condition selects.
 */
function solidEsbuildPlugin(aliases: Array<{ find: RegExp; replacement: string }>): any[] {
  return [{
    name: "solid-browser-resolve",
    setup(build: any) {
      for (const alias of aliases) {
        const pattern = alias.find;
        const replacement = alias.replacement;
        build.onResolve({ filter: pattern }, (args: any) => {
          if (args.path === replacement) return null; // already resolved
          return { path: replacement };
        });
      }
    },
  }];
}

/**
 * Vite plugin that forces solid-js to resolve to the browser (reactive) build
 * instead of the server build.
 *
 * The solid-js package.json has a "worker" export condition that maps to
 * dist/server.js — a non-reactive SSR build where createSignal/createStore
 * are no-ops. Vite uses the "worker" condition when resolving modules in a
 * Web Worker context, which breaks all reactivity: click handlers fire but
 * Show/createStore never trigger re-renders.
 *
 * This plugin intercepts resolution of solid-js, solid-js/web, and
 * solid-js/store and redirects them to the browser dev build (dist/dev.js).
 */
function solidBrowserResolvePlugin(): Plugin {
  // Resolve solid-js to the browser (reactive) build. The solid-js package has
  // a "worker" export condition that maps to dist/server.js (non-reactive SSR
  // build). We need the browser dev build (dist/dev.js) which has real
  // createSignal/createStore reactivity.
  let solidMain: string | null = null;
  let solidWeb: string | null = null;
  let solidStore: string | null = null;
  try {
    solidMain = gameRequire.resolve("solid-js/dist/dev.js");
    solidWeb = gameRequire.resolve("solid-js/web/dist/dev.js");
    solidStore = gameRequire.resolve("solid-js/store/dist/dev.js");
  } catch {
    // Will be resolved lazily in resolveId
  }

  return {
    name: "solid-browser-resolve",
    enforce: "pre",
    resolveId(source) {
      if (source === "solid-js" && solidMain) return solidMain;
      if (source === "solid-js/web" && solidWeb) return solidWeb;
      if (source === "solid-js/store" && solidStore) return solidStore;
      return null;
    },
    // In dev mode, Vite serves pre-bundled deps as static files, bypassing
    // the plugin load hook. We use configureServer middleware to intercept
    // HTTP requests for the pre-bundled solid-js files and serve the browser
    // dev build content instead. This is necessary because Vite's dep
    // optimizer pre-bundles solid-js using the "worker" export condition
    // (→ non-reactive server build), and no combination of resolve.alias,
    // optimizeDeps.exclude, or esbuildOptions.conditions reliably overrides
    // this for the worker context.
    configureServer(server) {
      if (!solidWeb || !solidMain || !solidStore) return;
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        // Match pre-bundled dep URLs like:
        //   /node_modules/.vite/deps/solid-js_web.js?v=xxx
        if (!url.includes("/.vite/deps/solid-js")) return next();
        // Extract the version hash from the URL (e.g. ?v=bde13132)
        const versionMatch = url.match(/[?&]v=([^&]+)/);
        const version = versionMatch ? versionMatch[1] : "";
        try {
          let filePath: string | null = null;
          let isWeb = false;
          let isStore = false;
          let isMain = false;
          if (url.includes("solid-js_web.js")) { filePath = solidWeb; isWeb = true; }
          else if (url.includes("solid-js_store.js")) { filePath = solidStore; isStore = true; }
          else if (url.match(/solid-js\.js/) && !url.includes("solid-js_")) { filePath = solidMain; isMain = true; }
          if (filePath) {
            let content = readFileSync(filePath, "utf-8");
            // Rewrite bare imports to point to pre-bundled dep URLs.
            // The dev build files have `import { ... } from 'solid-js'`
            // which the browser can't resolve. We rewrite them to
            // `/node_modules/.vite/deps/solid-js.js?v=xxx`.
            const mainUrl = `/node_modules/.vite/deps/solid-js.js${version ? `?v=${version}` : ""}`;
            if (isWeb || isStore) {
              // solid-js/web/dist/dev.js and solid-js/store/dist/dev.js
              // both import from 'solid-js' (bare specifier).
              content = content.replace(/from\s+["']solid-js["']/g, `from "${mainUrl}"`);
            }
            // The main solid-js/dist/dev.js has no bare imports (it's self-contained)
            res.setHeader("Content-Type", "text/javascript");
            res.end(content);
            return;
          }
        } catch {
          // File not found — fall through to Vite's default handler
        }
        next();
      });
    },
    // Also intercept via the load hook for cases where the middleware
    // doesn't catch the request (e.g. during SSR or build).
    load(id) {
      if (!solidWeb || !solidMain || !solidStore) return null;
      if (!id.includes("/.vite/deps/")) return null;
      try {
        if (id.includes("solid-js_web.js")) {
          let content = readFileSync(solidWeb, "utf-8");
          // Rewrite bare imports for the load hook context.
          // In the load hook, the id is an absolute file path, so we
          // use the alias-resolved path for solid-js.
          content = content.replace(/from\s+["']solid-js["']/g, `from "${solidMain}"`);
          return content;
        }
        if (id.includes("solid-js_store.js")) {
          let content = readFileSync(solidStore, "utf-8");
          content = content.replace(/from\s+["']solid-js["']/g, `from "${solidMain}"`);
          return content;
        }
        if (id.match(/solid-js\.js/) && !id.includes("solid-js_")) {
          return readFileSync(solidMain, "utf-8");
        }
      } catch {
        // File not found — fall through to default loader
      }
      return null;
    },
  };
}

/**
 * Vite plugin that removes the "worker" export condition from resolve.conditions.
 *
 * The solid-js package.json lists "worker" before "browser" in its exports map.
 * When Vite resolves modules in a Web Worker context, it adds "worker" to the
 * resolve conditions, which selects the non-reactive server build (dist/server.js)
 * instead of the reactive browser build (dist/dev.js).
 *
 * This plugin runs as a "post" plugin so it executes AFTER vite-plugin-solid's
 * config hook (which sets resolve.conditions). It filters out "worker" from
 * the conditions, causing the "browser" → "development" conditions to be used
 * instead, which selects the reactive dev build.
 */
function solidRemoveWorkerConditionPlugin(): Plugin {
  return {
    name: "solid-remove-worker-condition",
    enforce: "post",
    config(config) {
      if (config.resolve?.conditions) {
        config.resolve.conditions = config.resolve.conditions.filter(
          (c: string) => c !== "worker",
        );
      }
    },
  };
}

/**
 * Build the mining-rpg Vite options. Takes the solid plugin as a parameter
 * so the caller can resolve it from the correct node_modules location.
 */
export default function buildOptions(solid: (opts?: any) => Plugin): Partial<DowndraftViteConfigOptions> {
  // Resolve solid-js to the browser (reactive) build via resolve.alias.
  // The solid-js package.json has a "worker" export condition that maps to
  // dist/server.js — a non-reactive SSR build where createSignal/createStore
  // are no-ops. Vite uses the "worker" condition when resolving modules in a
  // Web Worker context, which breaks all reactivity: click handlers fire but
  // Show/createStore never trigger re-renders.
  //
  // resolve.alias takes precedence over export conditions in both dev and
  // build modes, including Vite's pre-bundled dependencies (optimizeDeps).
  // This is critical: a custom resolveId plugin alone doesn't affect
  // optimizeDeps pre-bundling, so the dev server would still serve the
  // server build.
  const solidAliases: Array<{ find: RegExp; replacement: string }> = [];
  try {
    solidAliases.push(
      { find: /^solid-js\/web$/, replacement: gameRequire.resolve("solid-js/web/dist/dev.js") },
      { find: /^solid-js\/store$/, replacement: gameRequire.resolve("solid-js/store/dist/dev.js") },
      { find: /^solid-js$/, replacement: gameRequire.resolve("solid-js/dist/dev.js") },
    );
  } catch {
    // solid-js not resolvable — skip aliases
  }

  return {
    html: {
      title: "Mining RPG",
      layers: [
        { type: "canvas", id: "game-canvas" },
        { type: "dom", id: "root" },
      ],
    },
    // Force solid-js to resolve to the browser (reactive) build via aliases.
    // This overrides the "worker" export condition that maps to the server build.
    rendererAliases: solidAliases,
    // Exclude solid-js subpaths from pre-bundling so the resolve.alias
    // takes effect instead of the pre-bundled server build. The "worker"
    // export condition in solid-js maps to the non-reactive server build;
    // without this exclude, esbuild pre-bundles the server build before
    // the alias is applied.
    optimizeDepsExclude: ["solid-js/web", "solid-js/store"],
    // Solid plugin for worker bundles (applied via worker.plugins)
    workerPlugins: [solid({ hot: false })],
    // Solid plugin for the main renderer bundle, scoped to src/solid/** so it
    // doesn't conflict with @vitejs/plugin-react on React .tsx files.
    // Also includes plugins to force solid-js to resolve to the reactive
    // browser build (not the server build that the "worker" export condition
    // selects):
    //   - solidRemoveWorkerConditionPlugin: removes "worker" from
    //     resolve.conditions so the "browser" → "development" conditions are
    //     used instead (selects dist/dev.js with real reactivity).
    //   - solidBrowserResolvePlugin: resolveId plugin that redirects solid-js
    //     imports to the browser dev build files directly (belt-and-suspenders
    //     for cases where the condition removal doesn't apply, e.g. build mode).
    rendererPlugins: [
      solidRemoveWorkerConditionPlugin(),
      solidBrowserResolvePlugin(),
      solid({ hot: false, include: "**/src/solid/**" }) as any,
      solidWorkerUrlPlugin(),
    ],
    // Build the Solid worker entry as a separate Rollup chunk so it gets the
    // Solid JSX transform from the main renderer's plugin pipeline.
    extraRollupInputs: [{ name: "solid-worker", path: "src/solid/worker-entry.ts" }],
    simPaths: [],
    rendererPaths: [],
    excludePaths: [],
  };
}
