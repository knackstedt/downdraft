// ============================================================================
// sceneModuleUrlPlugin — compiles `new URL("./*.ts", import.meta.url)` asset
// references into bundled JS chunks (instead of raw, uncompiled .ts assets),
// and rewrites pixi.js imports in scene-tree modules to use the worker's
// pixi.js instance (via `self.__pixi`) to avoid dual-instance bugs.
// ============================================================================
//
// Problem 1: Raw .ts assets
//   The pixi-ui library's documented scene-wiring pattern is:
//
//     sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href
//
//   In production builds, Vite's `new URL(..., import.meta.url)` asset
//   handling emits the referenced .ts file as a STATIC ASSET VERBATIM — the
//   raw, uncompiled .ts source. The worker then tries to `import()` a .ts
//   file, which the WebView/browser cannot execute.
//
//   Fix: emit the referenced file as a bundled Rollup CHUNK (compiled JS).
//
// Problem 2: Dual pixi.js instance
//   The scene chunk is part of the RENDERER build and imports pixi.js from
//   the renderer's main bundle. The pixi-ui WORKER has its own pixi.js
//   instance (separate Rollup build). When the worker dynamically imports
//   the scene at runtime, the scene's pixi.js objects (Container, Text,
//   FillStyle, Texture.WHITE, etc.) are from a DIFFERENT class instance
//   than the worker's. PIXI v8's internal singleton comparisons (e.g.
//   `fillStyle.texture === Texture.WHITE` in getCanvasFillStyle) fail
//   because the singletons are different objects, causing runtime errors
//   like `createPattern: The provided value is not of type ...`.
//
//   Fix: rewrite `import { ... } from "pixi.js"` in scene-tree modules to
//   `const { ... } = self.__pixi;` so the scene uses the WORKER's pixi.js
//   instance (exposed as `self.__pixi` by the worker before importing the
//   scene). This also makes scene chunks smaller (pixi.js is not bundled
//   into them).

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import type { Plugin } from "vite";

const require_ = createRequire(import.meta.url);

// Matches: new URL("./pixi-scene.ts", import.meta.url)   optionally + .href
// Captures: (1) the relative .ts/.tsx specifier, (2) optional ".href".
const SCENE_URL_RE = /new\s+URL\s*\(\s*["'`]([^"'`]+\.(?:ts|tsx))["'`]\s*,\s*import\.meta\.url\s*\)(\.href)?/g;

// Detects `new Worker(` immediately preceding a `new URL(...)` match so we can
// skip the worker-entry case (Vite already compiles those).
const WORKER_PREFIX_RE = /new\s+Worker\s*\(\s*$/;

// Matches value imports from pixi.js (not type-only):
//   import { Container, Graphics, Text } from "pixi.js";
//   import * as PIXI from "pixi.js";
//   import { Container as C, type Texture, Graphics } from "pixi.js"  (renamed + inline type)
//   import { Container, Graphics } from "pixi.js"  (multi-line — [^}]+ matches newlines)
// Does NOT match: import type { ... } from "pixi.js"
// `[^}]+` matches any char except `}` (including newlines) but stops at the
// first `}`, preventing the regex from matching across multiple import statements.
const PIXI_IMPORT_RE = /^import\s+(?!type\s)(\*\s+as\s+(\w+)|\{([^}]+)\})\s+from\s+["']pixi\.js["'];?\s*$/gm;

// Matches dynamic imports of pixi.js:
//   await import("pixi.js")
//   import("pixi.js")
// These are rewritten to Promise.resolve(self.__pixi) in scene-tree modules
// so the scene uses the worker's pixi.js instance instead of the main bundle's.
// The optional `typeof\s+` prefix capture is used to skip type annotations.
const PIXI_DYNAMIC_IMPORT_RE = /(typeof\s+)?import\s*\(\s*["']pixi\.js["']\s*\)/g;

// Matches dynamic imports of @pixi/react in scene-tree modules.
// Rewritten to use the worker's @pixi/react instance (self.__pixiReact)
// to avoid pulling the main bundle's pixi.js + @pixi/react into the worker
// context (which would create duplicate Texture.WHITE etc).
// The optional `typeof\s+` prefix capture is used to skip type annotations
// like `typeof import("@pixi/react")` which should NOT be rewritten.
const PIXI_REACT_DYNAMIC_IMPORT_RE = /(typeof\s+)?import\s*\(\s*["']@pixi\/react["']\s*\)/g;

// Matches dynamic imports of react in scene-tree modules.
// Rewritten to use the worker's React instance (self.__react) to avoid
// a dual-React-instance problem: the @pixi/react reconciler in the worker
// bundle sets the dispatcher on the worker's React, but scene components
// calling hooks on a different React instance would get a null dispatcher.
// The optional `typeof\s+` prefix skips type annotations like
// `typeof import("react")` which should NOT be rewritten.
const REACT_DYNAMIC_IMPORT_RE = /(typeof\s+)?import\s*\(\s*["']react["']\s*\)/g;

// Matches static value imports from react (not type-only) in scene-tree
// modules. Rewritten to `const { ... } = self.__react;` so the scene uses
// the worker's React instance. This is needed because static imports
// like `import { useSyncExternalStore } from "react"` would otherwise
// resolve to the main bundle's React.
// Handles: named imports, namespace imports, default imports, and mixed
// default + named imports.
const REACT_STATIC_IMPORT_RE = /^import\s+(?!type\s)(?:(\w+)\s*(?:,\s*)?)?(\*\s+as\s+(\w+)|\{([^}]+)\})\s+from\s+["']react["'];?\s*$/gm;

// Matches default-only imports: `import React from "react"`
const REACT_DEFAULT_IMPORT_RE = /^import\s+(\w+)\s+from\s+["']react["'];?\s*$/gm;

export interface SceneModuleUrlPluginOptions {
  /** When true, throw on violations instead of warning. Default: false. */
  failOnError?: boolean;
}

export function sceneModuleUrlPlugin(_opts: SceneModuleUrlPluginOptions = {}): Plugin {
  // placeholder string -> emitted chunk refId
  const placeholderToRefId = new Map<string, string>();
  // absolute .ts path -> refId (dedupe: one chunk per scene file)
  const tsToRefId = new Map<string, string>();
  // Set of module IDs (bare, no query) that are in the scene tree:
  // scene modules + their transitive dependencies. These modules will have
  // their `import { ... } from "pixi.js"` rewritten to `const { ... } = self.__pixi`
  // so they use the worker's pixi.js instance at runtime.
  const sceneTreeModules = new Set<string>();
  // Cycle guard: (importer, source) pairs we've already processed in resolveId.
  // Prevents infinite recursion on circular scene-tree dependencies.
  const resolveVisited = new Set<string>();

  return {
    name: "downdraft-scene-module-url",
    apply: "build",
    enforce: "pre",

    // Preserve entry signatures so emitted scene chunks retain their
    // `export default` factory. This is a Rollup INPUT option (not output).
    // Vite's default (`preserveEntrySignatures: false`) tree-shakes unused
    // entry exports — but scene chunks are only imported at runtime by the
    // worker (no static importer), so their default export would be silently
    // dropped without this. "strict" keeps the exact export signature of
    // every entry chunk.
    options(opts) {
      return { ...opts, preserveEntrySignatures: "strict" };
    },

    // Track scene-tree modules: when a module is imported by a scene-tree
    // module, add it to the scene tree. This runs before transform, so
    // sceneTreeModules is populated before we transform each module.
    //
    // This hook only runs work for modules already in the scene tree (the
    // outer `if` guards on sceneTreeModules/tsToRefId), so the synchronous
    // existsSync/require.resolve calls don't slow down the rest of the build.
    resolveId(source, importer) {
      if (!importer) return null;
      const importerBare = importer.replace(/\?.*$/, "");
      if (sceneTreeModules.has(importerBare) || tsToRefId.has(importerBare)) {
        // Skip pixi.js itself (handled by the import rewriting) and node:
        // builtins.
        if (source === "pixi.js" || source.startsWith("pixi.js/") || source.startsWith("node:")) {
          return null;
        }
        // Cycle guard — prevent infinite recursion on circular deps.
        const visitKey = `${importerBare}\0${source}`;
        if (resolveVisited.has(visitKey)) return null;
        resolveVisited.add(visitKey);

        // Manually resolve the source to an absolute path.
        // For relative paths: resolve relative to the importer, trying
        // common extensions + index files.
        // For bare specifiers: use Node's require.resolve which respects
        // the exports map in package.json.
        let resolvedPath: string | null = null;
        if (source.startsWith(".")) {
          const candidate = resolve(dirname(importerBare), source);
          if (existsSync(candidate)) {
            resolvedPath = candidate;
          } else {
            // Try common extensions, then /index.* for directory imports.
            for (let _i = 0, _it = [".ts", ".tsx", ".mts", ".jsx", ".js", ".mjs", ".cjs"], _n = _it.length; _i < _n; _i++) { const ext = _it[_i];
              if (existsSync(candidate + ext)) {
                resolvedPath = candidate + ext;
                break;
              }
            }
            if (!resolvedPath) {
              for (let _i = 0, _it = [".ts", ".tsx", ".mts", ".jsx", ".js", ".mjs"], _n = _it.length; _i < _n; _i++) { const ext = _it[_i];
                const idx = candidate + "/index" + ext;
                if (existsSync(idx)) {
                  resolvedPath = idx;
                  break;
                }
              }
            }
          }
        } else {
          // Bare specifier (any scope — @downdraft/*, @to-the-ocean/*, pixi
          // subpackages, third-party, etc.). require.resolve respects the
          // exports map in package.json.
          try {
            resolvedPath = require_.resolve(source, { paths: [dirname(importerBare)] });
          } catch {
            // Not a resolvable bare specifier — skip.
          }
        }
        if (resolvedPath) {
          // require.resolve may return a path with a query suffix from Vite;
          // strip it. existsSync guards against stale/broken resolutions.
          const resolvedBare = resolvedPath.replace(/\?.*$/, "");
          if (existsSync(resolvedBare)) {
            sceneTreeModules.add(resolvedBare);
          }
        }
      }
      return null;
    },

    transform(code, id) {
      const bareId = id.replace(/\?.*$/, "");

      // If this module is a scene module (emitted as a chunk above), disable
      // tree-shaking so its `export default` factory is preserved. Scene
      // chunks have no static importer (they're loaded at runtime by the
      // worker via import(url)), so Rollup would otherwise drop the unused
      // default export. Also mark it as a scene-tree module.
      const isSceneModule = tsToRefId.has(bareId);
      if (isSceneModule) {
        sceneTreeModules.add(bareId);
      }

      // For scene-tree modules, rewrite `import { ... } from "pixi.js"` to
      // `const { ... } = self.__pixi;` so the scene uses the worker's pixi.js
      // instance (exposed as self.__pixi) instead of the renderer's.
      // This prevents dual-instance bugs (e.g. Texture.WHITE singleton
      // comparison failures in getCanvasFillStyle).
      let pixiRewritten = false;
      if (sceneTreeModules.has(bareId) && code && (code.includes("from \"pixi.js\"") || code.includes("from 'pixi.js'"))) {
        PIXI_IMPORT_RE.lastIndex = 0;
        const newCode = code.replace(PIXI_IMPORT_RE, (full, namespaceOrNamed, namespace, named) => {
          pixiRewritten = true;
          if (namespace) {
            // import * as PIXI from "pixi.js"  →  const PIXI = self.__pixi;
            return `const ${namespace} = self.__pixi;`;
          }
          // import { Container, Graphics, Text } from "pixi.js"
          //   →  const { Container, Graphics, Text } = self.__pixi;
          // Also handles renamed imports (`Container as C`) and inline type
          // imports (`type Texture`) — the latter are stripped because they're
          // erased by esbuild anyway, and we're replacing the whole statement.
          const cleanNamed = named!
            .split(",")
            .map((s: string) => s.trim())
            .filter((s: string) => s && !s.startsWith("type "))
            .join(", ");
          return `const { ${cleanNamed} } = self.__pixi;`;
        });
        if (pixiRewritten) {
          code = newCode;
        }
      }

      // Also rewrite dynamic `import("pixi.js")` in scene-tree modules to
      // `Promise.resolve(self.__pixi)` so dynamic imports also use the worker's
      // pixi.js instance. This handles the @pixi/react adapter's
      // `await import("pixi.js")` pattern.
      if (sceneTreeModules.has(bareId) && code && code.includes('import("pixi.js")')) {
        PIXI_DYNAMIC_IMPORT_RE.lastIndex = 0;
        const dynCode = code.replace(PIXI_DYNAMIC_IMPORT_RE, (full, typeofPrefix) => {
          if (typeofPrefix) return full;
          pixiRewritten = true;
          return `Promise.resolve(self.__pixi)`;
        });
        code = dynCode;
      }

      // Rewrite dynamic `import("@pixi/react")` in scene-tree modules to
      // use the worker's @pixi/react instance (exposed as self.__pixiReact
      // by the worker before importing the scene). Without this, the scene
      // chunk dynamically imports @pixi/react from the main bundle, which
      // brings the main bundle's pixi.js into the worker context, creating
      // duplicate Texture.WHITE.
      if (sceneTreeModules.has(bareId) && code && code.includes('import("@pixi/react")')) {
        PIXI_REACT_DYNAMIC_IMPORT_RE.lastIndex = 0;
        code = code.replace(PIXI_REACT_DYNAMIC_IMPORT_RE, (full, typeofPrefix) => {
          // Skip type annotations: `typeof import("@pixi/react")` should
          // not be rewritten — it's a TypeScript type expression, not a
          // runtime dynamic import.
          if (typeofPrefix) return full;
          pixiRewritten = true;
          return `Promise.resolve(self.__pixiReact)`;
        });
      }

      // Rewrite static `import { ... } from "react"` and `import React from "react"`
      // in scene-tree modules to use self.__react so the scene uses the worker's
      // React instance. This prevents a dual-React-instance problem where
      // the @pixi/react reconciler sets the dispatcher on the worker's React
      // but scene components call hooks on the main bundle's React.
      if (sceneTreeModules.has(bareId) && code && (code.includes("from \"react\"") || code.includes("from 'react'"))) {
        // Handle named + namespace + mixed default/named imports
        REACT_STATIC_IMPORT_RE.lastIndex = 0;
        let reactCode = code.replace(REACT_STATIC_IMPORT_RE, (full, defaultName, namespaceOrNamed, namespace, named) => {
          pixiRewritten = true;
          const parts: string[] = [];
          if (defaultName) {
            parts.push(`const ${defaultName} = self.__react.default ?? self.__react;`);
          }
          if (namespace) {
            parts.push(`const ${namespace} = self.__react;`);
          }
          if (named) {
            const cleanNamed = named!
              .split(",")
              .map((s: string) => s.trim())
              .filter((s: string) => s && !s.startsWith("type "))
              .join(", ");
            if (cleanNamed) {
              parts.push(`const { ${cleanNamed} } = self.__react;`);
            }
          }
          return parts.join("\n");
        });
        // Handle default-only imports: `import React from "react"`
        REACT_DEFAULT_IMPORT_RE.lastIndex = 0;
        reactCode = reactCode.replace(REACT_DEFAULT_IMPORT_RE, (full, defaultName) => {
          pixiRewritten = true;
          return `const ${defaultName} = self.__react.default ?? self.__react;`;
        });
        code = reactCode;
      }

      // Rewrite dynamic `import("react")` in scene-tree modules to
      // `Promise.resolve(self.__react)` (skipping `typeof import("react")`
      // type annotations).
      if (sceneTreeModules.has(bareId) && code && code.includes('import("react")')) {
        REACT_DYNAMIC_IMPORT_RE.lastIndex = 0;
        code = code.replace(REACT_DYNAMIC_IMPORT_RE, (full, typeofPrefix) => {
          if (typeofPrefix) return full;
          pixiRewritten = true;
          return `Promise.resolve(self.__react)`;
        });
      }

      if (isSceneModule) {
        return { code, map: null, moduleSideEffects: "no-treeshake" };
      }

      if (!code || !code.includes("import.meta.url") || !code.includes("new URL")) {
        return pixiRewritten ? { code, map: null } : null;
      }
      SCENE_URL_RE.lastIndex = 0;

      const replacements: Array<{ start: number; end: number; replacement: string }> = [];
      let match: RegExpExecArray | null;
      while ((match = SCENE_URL_RE.exec(code)) !== null) {
        const tsSpec = match[1];
        const matchStart = match.index;
        const matchEnd = matchStart + match[0].length;

        // Skip `new Worker(new URL("./x.ts", import.meta.url))` — Vite compiles
        // worker entries itself; emitting a duplicate chunk would conflict.
        const preceding = code.slice(Math.max(0, matchStart - 30), matchStart);
        if (WORKER_PREFIX_RE.test(preceding)) continue;

        // Resolve the .ts path relative to the importing module.
        const tsAbsPath = resolve(dirname(id), tsSpec);
        // Skip references that don't resolve to an existing file — these are
        // doc/example matches inside comments (e.g. the pixi-ui library's
        // index.ts/scene.ts show the pattern in JSDoc). Avoids false positives
        // and stale references.
        if (!existsSync(tsAbsPath)) continue;
        let refId = tsToRefId.get(tsAbsPath);
        if (!refId) {
          // Emit as a bundled chunk (Rollup runs it through Vite's transform +
          // bundling, following its imports / applying aliases).
          refId = this.emitFile({ type: "chunk", id: tsAbsPath });
          tsToRefId.set(tsAbsPath, refId);
        }

        // Use a string-literal placeholder that Vite's asset plugin will NOT
        // try to resolve (it only processes `new URL(<string>, import.meta.url)`,
        // and we've removed that form). Replaced with the real URL in
        // generateBundle once the chunk filename is known.
        const safeRef = refId.replace(/[^a-zA-Z0-9_]/g, "_");
        const placeholder = `__DRAFT_SCENE_${safeRef}__`;
        placeholderToRefId.set(placeholder, refId);
        // Replace the entire match (including the optional `.href`) with the
        // string placeholder — the original expression yields a URL string via
        // `.href`, so a string literal is semantically equivalent.
        replacements.push({ start: matchStart, end: matchEnd, replacement: `"${placeholder}"` });
      }

      if (replacements.length === 0) {
        return pixiRewritten ? { code, map: null } : null;
      }

      // Apply replacements right-to-left so indices stay valid.
      replacements.sort((a, b) => b.start - a.start);
      let out = code;
      replacements.forEach((r) => {
        out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
      });
      return { code: out, map: null };
    },

    generateBundle(_opts, bundle) {
      for (const [placeholder, refId] of placeholderToRefId.entries()) {
        const sceneFileName = this.getFileName(refId);
        if (!sceneFileName) {
          // Fail fast: a missing chunk means the scene module was not bundled
          // (e.g. the .ts file didn't exist or had a syntax error). Leaving
          // the placeholder in the output would cause a runtime "module not
          // found" error with a cryptic message. Throw so the build fails
          // with an actionable error instead.
          this.error(
            `sceneModuleUrlPlugin: no emitted chunk for placeholder "${placeholder}" (refId ${refId}). ` +
              `The referenced scene module was not bundled — check that the .ts file exists and compiles.`,
          );
          continue;
        }
        const needle = `"${placeholder}"`;
        for (let _i = 0, _it = Object.values(bundle) as Array<any>, _n = _it.length; _i < _n; _i++) { const chunk = _it[_i];
          if (chunk.type !== "chunk" || !chunk.code || !chunk.code.includes(needle)) continue;
          // Relative path from this chunk's directory to the scene chunk.
          // Both are typically under assets/, so this resolves to
          // "./pixi-scene-[hash].js" — correct under any origin.
          let rel = relative(dirname(chunk.fileName), sceneFileName).replace(/\\/g, "/");
          if (!rel.startsWith(".")) rel = "./" + rel;
          chunk.code = chunk.code.split(needle).join(`"${rel}"`);
        }
      }
    },
  };
}
