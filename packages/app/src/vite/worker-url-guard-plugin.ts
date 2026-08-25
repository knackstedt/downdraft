// ============================================================================
// workerUrlGuardPlugin — Vite plugin that enforces the prod-safe worker URL
// pattern at build time.
//
// Vite's static analysis requires `new Worker(new URL("./xxx-worker.ts",
// import.meta.url), { type: "module" })` to appear literally in the source.
// If the URL is assigned to a variable first, Vite emits the worker as a raw
// unbundled asset with unresolved bare imports — workers silently fail to load
// in production builds (Worker.onerror fires with message: undefined).
//
// This plugin scans the generated bundle for `new Worker(` calls and warns/fails
// if the argument is not an inline `new URL(..., import.meta.url)` expression.
// It catches the #1 silent production-break scenario at build time instead of
// at runtime.
//
// The plugin also optionally warns about worker entry files that don't import
// `SimWorkerLoop` (the engine's reusable sim loop), encouraging games to use
// the shared infrastructure instead of re-implementing tick loops.
// ============================================================================

import type { Plugin } from "vite";

export interface WorkerUrlGuardOptions {
  /**
   * When true, the plugin throws (fails the build) on violations.
   * When false, it logs a warning.
   * Default: false (warn only — don't break existing builds during migration).
   */
  failOnError?: boolean;
  /**
   * When true, warns about worker entry chunks that don't reference SimWorkerLoop.
   * This is a soft enforcement to encourage using the shared sim loop.
   * Default: false.
   */
  warnOnMissingSimWorkerLoop?: boolean;
}

// Regex to find `new Worker(` calls in bundled code.
// Matches: new Worker(new URL("./xxx.ts", import.meta.url), { type: "module" })
// Also matches: new Worker(someVariable, ...) — which is the violation.
const NEW_WORKER_RE = /new\s+Worker\s*\(/g;

// Check if the argument following `new Worker(` is an inline `new URL(..., import.meta.url)`.
// We look for the pattern: new URL("..." or new URL('...' followed by , import.meta.url
const INLINE_URL_RE = /new\s+URL\s*\(\s*["'`][^"'`]+["'`]\s*,\s*import\.meta\.url\s*\)/;

/**
 * Vite plugin that guards against the silent production-break pattern of
 * assigning a worker URL to a variable before passing it to `new Worker()`.
 */
export function workerUrlGuardPlugin(opts: WorkerUrlGuardOptions = {}): Plugin {
  const failOnError = opts.failOnError ?? false;
  const warnOnMissingSimWorkerLoop = opts.warnOnMissingSimWorkerLoop ?? false;

  return {
    name: "downdraft-worker-url-guard",
    apply: "build",
    generateBundle(_opts, bundle: any) {
      const violations: string[] = [];
      const workerChunks: string[] = [];

      for (const [fileName, chunk] of Object.entries(bundle) as [string, any][]) {
        if (chunk.type !== "chunk" || !chunk.code) continue;

        // Find all `new Worker(` calls in this chunk
        let match: RegExpExecArray | null;
        const code = chunk.code;
        NEW_WORKER_RE.lastIndex = 0;

        while ((match = NEW_WORKER_RE.exec(code)) !== null) {
          // Extract a window of text after `new Worker(` to check the argument
          const startIdx = match.index + match[0].length;
          const window = code.slice(startIdx, startIdx + 200);

          // Skip if the first non-whitespace character is `new URL(` — check
          // for the inline pattern
          const trimmed = window.trimStart();
          if (trimmed.startsWith("new URL(")) {
            // Verify it's `new URL("...", import.meta.url)`
            if (INLINE_URL_RE.test(trimmed)) {
              // This is a worker entry chunk — track it for SimWorkerLoop check
              workerChunks.push(fileName);
              continue;
            }
          }

          // If the argument is a variable or anything else, it's a violation
          // (unless it's a URL object passed from opts — which we can't easily
          // distinguish, so we flag it as a potential issue)
          violations.push(
            `  ${fileName}: \`new Worker(...)\` does not use inline \`new URL(..., import.meta.url)\`. ` +
            `This will break production builds — Vite won't bundle the worker. ` +
            `Use: new Worker(new URL("./xxx-worker.ts", import.meta.url), { type: "module" })`,
          );
        }
      }

      if (violations.length > 0) {
        const msg = `[downdraft-worker-url-guard] Found ${violations.length} worker URL violation(s):\n${violations.join("\n")}`;
        if (failOnError) {
          this.error(msg);
        } else {
          this.warn(msg);
        }
      }

      // Optional: warn about worker chunks that don't use SimWorkerLoop
      if (warnOnMissingSimWorkerLoop && workerChunks.length > 0) {
        const missingSimLoop: string[] = [];
        for (const fileName of workerChunks) {
          const chunk = bundle[fileName];
          if (chunk?.code && !chunk.code.includes("SimWorkerLoop")) {
            missingSimLoop.push(fileName);
          }
        }
        if (missingSimLoop.length > 0) {
          this.warn(
            `[downdraft-worker-url-guard] Worker chunks without SimWorkerLoop (consider migrating):\n` +
            missingSimLoop.map((f) => `  ${f}`).join("\n"),
          );
        }
      }
    },
  };
}
