// ============================================================================
// pkg-root.ts — package-root resolution for module-relative paths
//
// Modules that resolve package-relative paths (native crate dirs, staged
// asset roots) must anchor at the package root rather than hardcoding a
// ".." segment count: the transpiled npm dist/ nests modules one level
// deeper than src/, so source-relative math escapes into dist/.
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Nearest ancestor directory containing a package.json, walking up from
 * `fromDir`. Layout-agnostic — a module under src/ and its transpiled copy
 * under dist/src/ resolve to the same package root. Falls back to
 * `fromDir` when no package.json ancestor exists (bare file imports).
 */
export function findPackageRoot(fromDir: string): string {
  let dir = fromDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return fromDir;
    dir = parent;
  }
}
