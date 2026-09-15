// ============================================================================
// native-assets.ts — Asset discovery replacing import.meta.glob
//
// In Vite, `import.meta.glob("../../assets/models/**/*.fbx", { query: "?url", eager: true })`
// returns a Record<string, string> mapping file paths to resolved URLs.
//
// In native mode, callers use `createGlob(import.meta.dir)` from
// @downdraft/core/platform/glob-polyfill — resolving patterns relative to
// the importing file, matching Vite semantics. This module re-exports that
// implementation and exposes it as globalThis.__nativeGlob for the engine's
// runtime-detection seam.
// ============================================================================

import { createLogger } from "@downdraft/core";
import { createGlob } from "@downdraft/core/platform/glob-polyfill";

const log = createLogger();

// ── nativeGlob: drop-in replacement for import.meta.glob ──
//
// Usage (matching Vite's import.meta.glob):
//   const models = nativeGlob("../../assets/models/**/*.fbx", { query: "?url", eager: true });
//
// Returns: Record<string, string> mapping relative paths to file:// URLs.
//
// NOTE: patterns are resolved relative to `baseDir` — callers that need
// caller-relative resolution should use `createGlob(import.meta.dir)`
// directly, since a module-level helper can't see the caller's import.meta.
export function nativeGlob(
  pattern: string,
  options?: { query?: string; import?: string; eager?: boolean },
  baseDir?: string,
): Record<string, string> {
  return createGlob(baseDir ?? process.cwd())(pattern, options);
}

// ── Install nativeGlob as a global polyfill ──
// The engine code calls import.meta.glob() which is a Vite-specific feature.
// In native mode, we can't intercept import.meta.glob directly, but we can
// provide a helper that game code can use conditionally.
//
// The approach: game code checks for native mode and calls nativeGlob() instead
// of import.meta.glob(). This is done via the runtime detection utility.
export function installAssetGlob(): void {
  (globalThis as any).__nativeGlob = nativeGlob;
  log.info("platform-native", "Asset glob installed (filesystem-based)");
}
