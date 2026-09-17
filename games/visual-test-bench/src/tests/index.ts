// ============================================================================
// Test auto-discovery — Vite glob import
//
// Every `*.test.ts` file in this directory (or subdirectories) is imported
// eagerly at module load time. Each test module calls `registerTest()` at
// the top level to register itself.
//
// Game authors add a new test by creating a `*.test.ts` file here — no
// manual import list to maintain. Vite resolves the glob at build time,
// so new tests get hot-reload automatically.
// ============================================================================

import { isBun } from "@downdraft/core/platform/runtime";

let modules: Record<string, unknown>;
if (!isBun) {
  // Vite — import.meta.glob is a compile-time macro here; it is NOT a
  // runtime function, so it cannot be feature-detected with typeof.
  modules = (import.meta as any).glob("./**/*.test.ts", { eager: true });
} else {
  // Bun-native fallback — import.meta.glob is a Vite API. Scan the test
  // directory on the filesystem and import each module eagerly instead.
  // Top-level await blocks dependent modules until registration completes.
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const dir = fileURLToPath(new URL(".", import.meta.url));
  modules = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".test.ts")) {
        modules[p] = await import(/* @vite-ignore */ pathToFileURL(p).href);
      }
    }
  };
  await walk(dir);
}

// Log discovered test modules for debugging.
const count = Object.keys(modules).length;
console.log(`[test-bench] discovered ${count} test module(s)`);
