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
  // Also validates with the Tint CLI if available (build-time parity with
  // the Vite wgslValidatePlugin). Disabled when DOWNDRAFT_SHADER_VALIDATE=0.
  Bun.plugin({
    name: "downdraft-wgsl-loader",
    setup(build: any) {
      // Tint binary resolution — best-effort, cached after first call.
      let tintBin: string | null | undefined = undefined;
      function getTintBin(): string | null {
        if (tintBin !== undefined) return tintBin;
        try {
          const { resolveTintBinary } = require("../../app/src/vite/tint-binary.ts");
          tintBin = resolveTintBinary() as string | null;
        } catch {
          tintBin = null;
        }
        return tintBin;
      }

      function validateWgsl(path: string, text: string): void {
        if (process.env.DOWNDRAFT_SHADER_VALIDATE === "0") return;
        const bin = getTintBin();
        if (!bin) return;
        try {
          const { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } = require("node:fs");
          const { tmpdir } = require("node:os");
          const { join } = require("node:path");
          const { execSync } = require("node:child_process");
          const tmpDir = mkdtempSync(join(tmpdir(), "dd-tint-"));
          const tmpFile = join(tmpDir, "shader.wgsl");
          const outFile = join(tmpDir, "out.spvasm");
          writeFileSync(tmpFile, text, "utf-8");
          try {
            execSync(`"${bin}" -f spvasm "${tmpFile}" -o "${outFile}"`, {
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8",
              timeout: 30000,
            });
          } catch (e: any) {
            const output = (e.stdout ?? "") + (e.stderr ?? "");
            throw new Error(`WGSL validation failed for ${path}:\n${output.trim()}`);
          } finally {
            try { unlinkSync(tmpFile); } catch {}
            try { rmdirSync(tmpDir); } catch {}
          }
        } catch (e: any) {
          // Re-throw validation errors so they block the module load.
          if (e.message?.includes("WGSL validation failed")) throw e;
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
      build.onLoad({ filter: /\.css$/ }, async (_args: any) => {
        return { exports: { default: "" }, loader: "object" };
      });
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

  // ── import.meta.glob polyfill ──
  // Vite's import.meta.glob() is a compile-time feature. In Bun-native mode,
  // we set it on import.meta for this module. Other modules that need it
  // should import from @downdraft/core/platform/glob-polyfill.
  // The glob polyfill is installed per-module via the runtime utility.
  try {
    const { createGlob } = require("./glob-polyfill.ts");
    (import.meta as any).glob = createGlob(__dirname);
  } catch {}
}
