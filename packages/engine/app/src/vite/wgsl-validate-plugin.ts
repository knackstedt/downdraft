// ============================================================================
// wgsl-validate-plugin.ts — Vite plugin that validates WGSL shaders at
// build/compile time using the Tint CLI.
// ============================================================================
//
// Intercepts `*.wgsl` and `*.wgsl?raw` imports in its `load` hook and shells
// out to the Tint binary to validate the WGSL source. On error, fails the
// build (or dev module load). On warning, logs to console (deduplicated).
//
// Caches validation results by file path + mtime to avoid re-validating
// unchanged files. Disabled when DOWNDRAFT_SHADER_VALIDATE=0 or when the
// Tint binary is not available (falls through to runtime validation).
//
// This plugin runs alongside wgslHmrPlugin — both intercept *.wgsl?raw in
// their load hooks. This plugin runs with enforce: "pre" so it validates
// the source before wgslHmrPlugin transforms it into a JS module. If
// validation fails, the load hook throws, preventing the module from being
// created. If validation passes, this plugin returns null (lets
// wgslHmrPlugin handle the actual module creation).

import { createLogger } from "@downdraft/engine/util/logger";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { Plugin } from "vite";
import { resolveTintBinary, validateWgslWithTint } from "./tint-binary.ts";

const log = createLogger("info");

/**
 * Some WGSL sources are fragments that only compile when concatenated with
 * shared prelude files (e.g. postfx effect shaders are assembled at runtime
 * as `fullscreen-vs.wgsl + occluder-chunk.wgsl + effect.wgsl`). Such files
 * declare their preludes with a pragma comment:
 *
 *   // wgsl-validate: prelude ./fullscreen-vs.wgsl
 *
 * The validator prepends each referenced file (in order, relative to the
 * shader's directory) before invoking tint, so the check matches the runtime
 * concatenation.
 */
function applyPreludePragmas(source: string, filePath: string): string {
  const pragmas = source.matchAll(/^\/\/\s*wgsl-validate:\s*prelude\s+(\S+)\s*$/gm);
  const parts: string[] = [];
  for (const m of pragmas) {
    try {
      parts.push(readFileSync(resolvePath(dirname(filePath), m[1]), "utf-8"));
    } catch {
      // Missing prelude — validate without it; tint will report the fallout.
    }
  }
  return parts.length ? parts.join("\n") + "\n" + source : source;
}

/**
 * Some WGSL sources can never validate standalone: partial struct bodies
 * spliced into other shaders, or chunks that reference symbols declared in
 * each consuming shader (e.g. a shared lighting fn that reads a leaf-provided
 * `uniforms` var). Such files opt out with:
 *
 *   // wgsl-validate: skip
 *
 * They still get validated transitively whenever a consuming shader lists
 * them as a prelude.
 */
function hasSkipPragma(source: string): boolean {
  return /^\/\/\s*wgsl-validate:\s*skip\s*$/m.test(source);
}

export function wgslValidatePlugin(): Plugin {
  const tintBin = resolveTintBinary();
  const enabled = tintBin !== null && process.env.DOWNDRAFT_SHADER_VALIDATE !== "0";

  // Validation cache: filePath → { mtime, result }
  const cache = new Map<string, { mtime: number; ok: boolean; errors: string[]; warnings: string[] }>();
  // Warning dedup
  const warnedWarnings = new Set<string>();

  return {
    name: "downdraft-wgsl-validate",
    enforce: "pre",

    configResolved(config) {
      if (enabled) {
        config.logger.info(`[downdraft-wgsl-validate] enabled (tint: ${tintBin})`);
      } else if (process.env.DOWNDRAFT_SHADER_VALIDATE !== "0") {
        config.logger.warn(`[downdraft-wgsl-validate] Tint binary not found — build-time WGSL validation disabled (runtime validation still active)`);
      }
    },

    load(id) {
      if (!enabled) return null;

      // Match *.wgsl?raw and bare *.wgsl (same logic as wgslHmrPlugin)
      let filePath: string | null = null;
      if (id.endsWith(".wgsl?raw")) {
        filePath = id.slice(0, -4); // strip "?raw"
      } else if (id.endsWith(".wgsl") && !id.includes("?")) {
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
      if (!filePath) return null;

      // Read the source
      let source: string;
      try {
        source = readFileSync(filePath, "utf-8");
      } catch {
        // Let Vite's default loader handle the error (e.g. file missing).
        return null;
      }

      // Check cache (by mtime)
      const mtime = statSync(filePath).mtimeMs;
      const cached = cache.get(filePath);
      if (cached && cached.mtime === mtime) {
        if (!cached.ok) {
          this.error(`WGSL validation failed for ${filePath}:\n${cached.errors.join("\n")}`);
        }
        // Log cached warnings once
        for (const w of cached.warnings) {
          if (!warnedWarnings.has(w)) {
            warnedWarnings.add(w);
            log.warn("wgsl-validate", w);
          }
        }
        return null; // Let wgslHmrPlugin handle module creation
      }

      // Opt-out for chunk files that can only compile inside a consumer
      if (hasSkipPragma(source)) {
        cache.set(filePath, { mtime, ok: true, errors: [], warnings: [] });
        return null;
      }

      // Validate with Tint (with any declared prelude files prepended)
      const result = validateWgslWithTint(tintBin!, applyPreludePragmas(source, filePath), filePath);
      cache.set(filePath, { mtime, ok: result.ok, errors: result.errors, warnings: result.warnings });

      if (!result.ok) {
        // Build mode: this.error fails the build.
        // Dev mode: this.error shows in the Vite overlay + blocks module load.
        this.error(`WGSL validation failed for ${filePath}:\n${result.errors.join("\n")}`);
      }

      // Log warnings (deduplicated)
      for (const w of result.warnings) {
        if (!warnedWarnings.has(w)) {
          warnedWarnings.add(w);
          log.warn("wgsl-validate", w);
        }
      }

      // Return null to let wgslHmrPlugin create the actual module.
      return null;
    },
  };
}
