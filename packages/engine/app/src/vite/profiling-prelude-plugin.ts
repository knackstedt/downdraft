// ============================================================================
// profilingPreludePlugin — Vite transform plugin that auto-injects
// `import "@downdraft/core/profiling/worker-prelude";` as the first statement
// of worker-entry files.
//
// The import is a side-effect import — the prelude self-initializes on load
// in worker realm and no-ops in main realm. This ensures the ProfilingSAB is
// attached + OPFS/IndexedDB prototypes are patched + the warning engine +
// event-loop monitor are initialized before any worker code runs.
//
// Default glob: `**/*worker*.ts`, `**/*worker*.tsx` (excluding specs, .d.ts,
// and the pixi-ui/profiler worker itself). Configurable via include/exclude.
// ============================================================================

import type { Plugin } from "vite";

export interface ProfilingPreludePluginOptions {
  /** Include glob patterns (matched against the file path). Default: worker entries. */
  include?: string[];
  /** Exclude glob patterns. Default: specs, .d.ts, pixi-ui/profiler workers. */
  exclude?: string[];
}

const DEFAULT_INCLUDE = [
  "**/*worker*.ts",
  "**/*worker*.tsx",
];

const DEFAULT_EXCLUDE = [
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.d.ts",
  "**/pixi-ui-worker.ts",
  "**/profiler-scene.ts",
  "**/profiling-prelude-plugin.ts",
  "**/worker-prelude.ts",
];

const PRELUDE_IMPORT = `import "@downdraft/core/profiling/worker-prelude";`;

/** Simple glob matcher — supports * and ** patterns. */
function matchGlob(path: string, pattern: string): boolean {
  // Normalize path separators
  const normalizedPath = path.replace(/\\/g, "/");
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*");
  return new RegExp("^" + regex + "$").test(normalizedPath);
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(path, p));
}

export function profilingPreludePlugin(options?: ProfilingPreludePluginOptions): Plugin {
  const include = options?.include ?? DEFAULT_INCLUDE;
  const exclude = options?.exclude ?? DEFAULT_EXCLUDE;

  return {
    name: "downdraft:profiling-prelude",
    enforce: "pre",
    transform(_code: string, id: string) {
      // Only transform TypeScript files
      if (!id.endsWith(".ts") && !id.endsWith(".tsx")) return null;

      // Check include patterns
      if (!matchesAny(id, include)) return null;

      // Check exclude patterns
      if (matchesAny(id, exclude)) return null;

      // Skip if the file already has the prelude import (idempotent)
      if (_code.includes(PRELUDE_IMPORT)) return null;

      // Inject the prelude import as the first statement
      const transformed = PRELUDE_IMPORT + "\n" + _code;
      return {
        code: transformed,
        map: null, // No source map needed for a simple prepend
      };
    },
  };
}
