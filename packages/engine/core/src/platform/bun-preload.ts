// ============================================================================
// Bun preload — registers plugin loaders for Vite-specific import patterns
//
// This file is referenced by bunfig.toml's `preload` field and executes before
// any user code. It registers Bun.plugin() loaders that handle:
//
//   1. `*.wgsl?raw` — WGSL shader imports (returns the file text as default export)
//   2. `*.wgsl`     — bare WGSL imports (same as ?raw)
//   3. `*.css`      — CSS imports (returns empty string — no DOM in native mode)
//   4. `*?url`      — asset URL imports (returns the file path as default export)
//   5. `*.glsl?raw` — GLSL shader imports (if any exist)
//   6. `*.txt?raw`  — raw text imports
//
// In Vite mode, Vite's own loaders handle these patterns. In Bun-native mode,
// this preload script is the replacement.
//
// This file MUST be safe to import under both Bun and Node/Vite. Under Node/Vite
// it's a no-op (Bun.plugin is undefined).
// ============================================================================

// Guard: only register under Bun
if (typeof (globalThis as any).Bun !== "undefined" && typeof (globalThis as any).Bun.plugin === "function") {
  const Bun = (globalThis as any).Bun;

  // ── WGSL shader loader (?raw and bare) ──
  // Matches: "./foo.wgsl?raw", "./foo.wgsl"
  // Also validates with naga in-process via libdowndraft_platform (build-time
  // parity with the Vite wgslValidatePlugin). Disabled when
  // DOWNDRAFT_SHADER_VALIDATE=0 or the native validator is unavailable.
  Bun.plugin({
    name: "downdraft-wgsl-loader",
    setup(build: any) {
      // Native validator resolution — best-effort, cached after first call.
      let validateNative: ((src: string, path?: string) => { ok: boolean; errors: string[] } | null) | null | undefined = undefined;
      function getValidator() {
        if (validateNative !== undefined) return validateNative;
        try {
          const { validateWgslNative } = require("@downdraft/platform-native");
          validateNative = validateWgslNative;
        } catch {
          validateNative = null;
        }
        return validateNative;
      }

      // Fragment shaders that only compile when concatenated with shared
      // preludes declare them with `// wgsl-validate: prelude <file>`
      // (mirrors the Vite wgslValidatePlugin). Unconcatenable chunks opt out
      // entirely with `// wgsl-validate: skip`.
      function applyPreludePragmas(source: string, filePath: string): string {
        const { readFileSync } = require("node:fs");
        const { dirname, resolve } = require("node:path");
        const parts: string[] = [];
        for (const m of source.matchAll(/^\/\/\s*wgsl-validate:\s*prelude\s+(\S+)\s*$/gm)) {
          try { parts.push(readFileSync(resolve(dirname(filePath), m[1]), "utf-8")); } catch {}
        }
        return parts.length ? parts.join("\n") + "\n" + source : source;
      }

      function validateWgsl(path: string, text: string): void {
        if (process.env.DOWNDRAFT_SHADER_VALIDATE === "0") return;
        if (/^\/\/\s*wgsl-validate:\s*skip\s*$/m.test(text)) return;
        const validate = getValidator();
        if (!validate) return;
        const result = validate(applyPreludePragmas(text, path), path);
        if (result !== null && !result.ok) {
          throw new Error(`WGSL validation failed for ${path}:\n${result.errors.join("\n")}`);
        }
      }

      // ?raw variant
      build.onLoad({ filter: /\.wgsl\?raw$/ }, async (args: any) => {
        const path = args.path.replace(/\?raw$/, "");
        const text = await Bun.file(path).text();
        validateWgsl(path, text);
        return { exports: { default: text }, loader: "object" };
      });
      // Bare .wgsl (no ?raw suffix) — also return text
      build.onLoad({ filter: /[^?]\.wgsl$/ }, async (args: any) => {
        const text = await Bun.file(args.path).text();
        validateWgsl(args.path, text);
        return { exports: { default: text }, loader: "object" };
      });
    },
  });

  // ── GLSL shader loader (?raw) ──
  Bun.plugin({
    name: "downdraft-glsl-loader",
    setup(build: any) {
      build.onLoad({ filter: /\.glsl\?raw$/ }, async (args: any) => {
        const path = args.path.replace(/\?raw$/, "");
        const text = await Bun.file(path).text();
        return { exports: { default: text }, loader: "object" };
      });
    },
  });

  // ── CSS loader (returns empty string — no DOM in native mode) ──
  // Matches: "./globals.css", "@fontsource/doto/400.css"
  Bun.plugin({
    name: "downdraft-css-loader",
    setup(build: any) {
      const { resolve } = require("node:path");
      // Resolve EVERY .css import — real files and exports-map-hidden package
      // CSS alike — to a real stub file. Bun bakes the resolved specifier into
      // its persistent transpile cache (~/.bun/install/cache/@t@/*.pile), so
      // the result must be a plain path that replays without this plugin
      // (e.g. `bun dev-shell.mjs` / `bun run` from a game dir, where the root
      // bunfig.toml preload doesn't apply). A virtual "dd-css:<path>"
      // namespace gets cached as a package-looking specifier: re-resolution
      // wraps it in another "dd-css:<dir>" layer per ancestor walked, looping
      // forever at "/" until ENAMETOOLONG.
      const stub = resolve(import.meta.dir, "css-stub.ts");
      // NOTE: the stub is a .ts file specifically so the baked specifier never
      // re-matches this /\.css$/ filter.
      build.onResolve({ filter: /\.css$/ }, () => ({ path: stub }));
      // Transpile-cache entries written by older versions still carry
      // "dd-css:<...>" specifiers — Bun routes those straight to the namespace
      // loader, so keep answering them until the entries age out.
      build.onLoad({ filter: /.*/, namespace: "dd-css" }, () => ({
        exports: { default: "" }, loader: "object",
      }));
    },
  });

  // ── ?url asset loader (returns file path as string) ──
  // Matches: "./model.fbx?url", "./texture.png?url"
  Bun.plugin({
    name: "downdraft-url-loader",
    setup(build: any) {
      build.onLoad({ filter: /\?url$/ }, async (args: any) => {
        const path = args.path.replace(/\?url$/, "");
        return { exports: { default: path }, loader: "object" };
      });
    },
  });

  // ── ?raw text loader (generic, non-shader) ──
  // Matches: "./data.txt?raw", "./config.json?raw"
  Bun.plugin({
    name: "downdraft-raw-text-loader",
    setup(build: any) {
      build.onLoad({ filter: /\?raw$/ }, async (args: any) => {
        // Skip if already handled by wgsl/glsl loaders
        if (args.path.endsWith(".wgsl?raw") || args.path.endsWith(".glsl?raw")) return undefined;
        const path = args.path.replace(/\?raw$/, "");
        const text = await Bun.file(path).text();
        return { exports: { default: text }, loader: "object" };
      });
    },
  });

  // ── import.meta.glob ──
  // Vite's import.meta.glob() is a compile-time transform — there is no way to
  // polyfill it from a preload script (assigning to this module's import.meta
  // has no effect on callers). Callers that need globbing in native mode must
  // use createGlob(import.meta.dir) from "./glob-polyfill" — see
  // games/to-the-ocean/src/engine/webgpu-renderer.ts for the pattern.
}

// ── Native-host marker ──
// Games detect the native runtime via globalThis.__nativeHost. Module-eval-time
// checks (top-level import.meta.glob fallbacks, feature gates) run BEFORE
// createNativeHost() can install the real host object, so seed a truthy marker
// here — createNativeHost() replaces it with the actual host instance later.
if (typeof (globalThis as any).Bun !== "undefined") {
  (globalThis as any).__nativeHost ??= true;
}
