// ============================================================================
// wgslHmrPlugin — Vite plugin that turns `*.wgsl?raw` imports into HMR boundaries
// ============================================================================
//
// Vite's built-in `?raw` handler returns the file contents as a string but
// does NOT set up an HMR boundary for non-JS assets. Without this plugin,
// editing a `.wgsl` file either does nothing (the hotReloadPlugin used to
// swallow the event) or triggers a coarse full-reload.
//
// This plugin intercepts `*.wgsl?raw` in its `load` hook (enforce: "pre" so
// it runs before Vite's `vite:asset` plugin) and emits a tiny JS module that:
//   1. Imports the zero-dependency `wgslHotReload` registry by absolute path
//      (avoids circular deps through the @downdraft/core barrel, which itself
//      imports `.wgsl?raw` modules via MaterialLibrary).
//   2. Exports the raw shader source as `default` (same contract as `?raw`).
//   3. Registers the source with the registry.
//   4. Calls `import.meta.hot.accept()` so the `?raw` module becomes an HMR
//      boundary — only this module re-evaluates on file change, not the
//      entire import chain. On accept, it calls `wgslHotReload.reload()`,
//      which notifies subscribers (fine-grained pipeline rebuild) or falls
//      back to a full page reload when there are none.
//
// In production builds `import.meta.hot` is undefined, so the accept block is
// dead-code-eliminated. The `register()` call still runs but is harmless.

import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export function wgslHmrPlugin(hmrRegistryPath: string): Plugin {
  // Resolve the registry source file directly to avoid importing through the
  // @downdraft/core barrel (which would create a circular dependency because
  // the barrel re-exports modules that themselves import `*.wgsl?raw`).
  // Callers pass the absolute path — in the monorepo that's
  // packages/core/src/render/wgsl-hmr.ts; standalone games resolve it inside
  // node_modules/@downdraft/core/src/.
  const registryPath = hmrRegistryPath;

  return {
    name: "downdraft-wgsl-hmr",
    enforce: "pre",

    load(id) {
      // Intercept `*.wgsl?raw` (the `?raw` query is appended by Vite to the
      // resolved file id). Also handle bare `*.wgsl` for safety, though the
      // codebase always uses `?raw`.
      const isWgslRaw = id.endsWith(".wgsl?raw");
      const isWgslBare = id.endsWith(".wgsl") && !id.includes("?");

      // Skip anything that's not a wgsl file we should own. Note: Vite may
      // append a version query (e.g. `?raw&t=...`) during HMR updates — handle
      // that by stripping any query before checking the extension.
      let filePath: string | null = null;
      if (isWgslRaw) {
        filePath = id.slice(0, -4); // strip "?raw"
      } else if (isWgslBare) {
        filePath = id;
      } else {
        const queryIndex = id.indexOf("?");
        if (queryIndex > 0) {
          const pathPart = id.slice(0, queryIndex);
          const queryPart = id.slice(queryIndex + 1);
          if (pathPart.endsWith(".wgsl") && queryPart.startsWith("raw")) {
            filePath = pathPart;
          }
        }
      }
      if (!filePath) return;

      let source: string;
      try {
        source = readFileSync(filePath, "utf-8");
      } catch {
        // Let Vite's default loader handle the error (e.g. file missing).
        return;
      }

      // Use the absolute file path (without query) as the stable shader id.
      const shaderId = JSON.stringify(filePath);
      const registryImport = JSON.stringify(registryPath);

      // IMPORTANT: keep this template in sync with Vite's `?raw` contract —
      // `export default <string>` is what consumers import.
      return `import { wgslHotReload } from ${registryImport};

const src = ${JSON.stringify(source)};
wgslHotReload.register(${shaderId}, src);
export default src;

if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (m && m.default !== undefined && m.default !== src) {
      wgslHotReload.reload(${shaderId}, m.default);
    }
  });
}
`;
    },
  };
}
