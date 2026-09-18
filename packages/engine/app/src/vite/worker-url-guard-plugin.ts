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

        // Skip chunks that are entirely from node_modules (third-party libraries
        // like meshoptimizer's decoder create their own workers internally and
        // can't use the inline `new URL(..., import.meta.url)` pattern).
        const moduleIds: string[] = chunk.moduleIds ?? (chunk.modules ? Object.keys(chunk.modules) : []);
        if (moduleIds.length > 0 && moduleIds.every((id: string) => id.includes("node_modules"))) {
          continue;
        }

        const code = chunk.code;
        NEW_WORKER_RE.lastIndex = 0;

        // First pass: find all valid inline `new Worker(new URL(..., import.meta.url))` calls.
        // If a chunk has at least one valid pattern, then any `new Worker(variable)` calls
        // are likely the custom-URL branch of a conditional (e.g.
        //   this.workerUrl ? new Worker(this.workerUrl) : new Worker(new URL(..., import.meta.url))
        // ). The variable-based branch is intentional and safe — Vite bundles the
        // default branch's worker, and the custom-URL branch is only used when the
        // caller explicitly provides a pre-resolved URL.
        let hasValidWorkerUrl = false;
        let match: RegExpExecArray | null;
        NEW_WORKER_RE.lastIndex = 0;
        while ((match = NEW_WORKER_RE.exec(code)) !== null) {
          const startIdx = match.index + match[0].length;
          const window = code.slice(startIdx, startIdx + 200);
          const trimmed = window.trimStart();
          if (trimmed.startsWith("new URL(") && INLINE_URL_RE.test(trimmed)) {
            hasValidWorkerUrl = true;
            workerChunks.push(fileName);
            break;
          }
        }

        // Second pass: find violations, skipping variable-based calls if the
        // chunk also has at least one valid inline URL pattern.
        NEW_WORKER_RE.lastIndex = 0;
        while ((match = NEW_WORKER_RE.exec(code)) !== null) {
          const startIdx = match.index + match[0].length;
          const window = code.slice(startIdx, startIdx + 200);
          const trimmed = window.trimStart();

          // Valid inline URL pattern — already tracked above
          if (trimmed.startsWith("new URL(") && INLINE_URL_RE.test(trimmed)) {
            continue;
          }

          // Variable-based Worker creation — skip if this chunk also has a
          // valid inline URL pattern (it's the custom-URL branch of a conditional)
          if (hasValidWorkerUrl) {
            continue;
          }

          // If the argument is a variable or anything else, it's a violation
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
