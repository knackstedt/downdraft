// ============================================================================
// silenceSourcemapWarningsPlugin — Vite plugin that filters out noisy
// "Sourcemap for ... points to missing source files" warnings emitted by
// Vite's own logger (via `logger.warnOnce`) for third-party packages whose
// published tarballs ship .js.map files referencing source files that
// aren't included in the package.
//
// Unlike Rollup's `onwarn` (which only intercepts Rollup warnings with a
// `code`), these messages are emitted directly through Vite's logger and
// have no warning code — so the only way to suppress them is to wrap the
// logger. This plugin does that in `configResolved`, after Vite has
// constructed its logger, by patching `warnOnce` to drop messages matching
// the given patterns.
//
// Default patterns silence @bokuweb/zstd-wasm (used by @downdraft/engine/libraries/
// persistence), which is excluded from dep pre-bundling and served raw
// from node_modules — its .js.map files point at sources the package
// author didn't publish. The maps are useless to us (we don't debug into
// zstd-wasm), so the warnings are pure noise.
// ============================================================================

import type { Plugin } from "vite";

export interface SilenceSourcemapWarningsOptions {
  /**
   * Substrings to match against the warning message. If any substring is
   * found, the warning is dropped. Default: ["zstd-wasm"].
   */
  patterns?: string[];
}

/**
 * Vite plugin that silences "Sourcemap for ... points to missing source
 * files" warnings for specified packages by wrapping Vite's logger.
 */
export function silenceSourcemapWarningsPlugin(
  opts: SilenceSourcemapWarningsOptions = {},
): Plugin {
  const patterns = opts.patterns ?? ["zstd-wasm"];

  return {
    name: "downdraft-silence-sourcemap-warnings",
    enforce: "pre",
    configResolved(config) {
      const logger = (config as any).logger;
      if (!logger || typeof logger.warnOnce !== "function") return;

      const originalWarnOnce = logger.warnOnce.bind(logger);
      logger.warnOnce = (msg: string) => {
        if (typeof msg === "string" && patterns.some((p) => msg.includes(p))) {
          return;
        }
        originalWarnOnce(msg);
      };
    },
  };
}
