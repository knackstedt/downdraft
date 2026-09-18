// ============================================================================
// engine-resolve.ts — locate @downdraft/* package sources in both layouts
// ============================================================================
//
// The engine supports two consumption layouts:
//
//   1. Monorepo — games live at <repo>/games/<name> and @downdraft/* deps are
//      bun workspace links into <repo>/packages/*.
//   2. Standalone — a game repo installed on its own; @downdraft/* packages
//      come from npm into node_modules/.
//
// Both resolve identically through Node's package resolution: the workspace
// symlink and the installed package both answer `<pkg>/package.json`. We only
// fall back to the monorepo-relative path when the package isn't resolvable
// from the game directory at all (e.g. the game doesn't declare it as a dep —
// the alias then still works inside the monorepo, matching legacy behavior).

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export interface EngineResolver {
  /** Absolute path to a package's `src/` dir (e.g. packages/core/src). */
  src(pkg: string, monorepoSubdir: string): string;
  /** Absolute path to a package's root dir (e.g. packages/core). */
  pkg(pkg: string, monorepoSubdir: string): string;
  /**
   * Union of external (non-@downdraft) `dependencies` across the game's own
   * package.json plus every resolvable @downdraft/* dep, transitively.
   * Replaces the old "read the engine root package.json" behavior so it works
   * for standalone games too.
   */
  engineDeps(exclude: Set<string>): string[];
  /** The monorepo root when detected (game at <root>/games/<name>), else null. */
  repoRoot: string | null;
  /**
   * Warn once about packages that only resolved via the monorepo fallback
   * (not declared in the game's package.json), and about packages that
   * could not be resolved at all in standalone layouts. Call after building
   * the alias table — alias probing engages the fallback eagerly, so
   * per-call warnings would be noise.
   */
  warnUndeclared(): void;
}

/**
 * @param gameRoot absolute path to the game directory.
 * @param monorepoRoot optional override for the monorepo root detection —
 *        defaults to `<gameRoot>/../..`.
 */
export function createEngineResolver(gameRoot: string, monorepoRoot?: string): EngineResolver {
  const candidate = monorepoRoot ?? resolve(gameRoot, "../..");
  const repoRoot = existsSync(join(candidate, "packages/core/package.json")) ? candidate : null;
  const req = createRequire(resolve(gameRoot, "package.json"));
  const undeclared = new Set<string>();
  const missing = new Set<string>();

  function pkg(name: string, monorepoSubdir: string): string {
    try {
      return dirname(req.resolve(`${name}/package.json`));
    } catch {
      // Not installed / not a declared dep — fall back to the monorepo layout
      // so unaliased engine packages still resolve inside the engine repo.
      // Standalone games have no monorepo to fall back to: return the
      // conventional node_modules path so the failure names the package.
      (repoRoot ? undeclared : missing).add(name);
      return repoRoot
        ? join(repoRoot, "packages", monorepoSubdir)
        : join(gameRoot, "node_modules", name);
    }
  }

  const src = (name: string, monorepoSubdir: string) => join(pkg(name, monorepoSubdir), "src");

  function engineDeps(exclude: Set<string>): string[] {
    // Monorepo: keep the legacy behavior — the engine root package.json lists
    // the canonical external dep set.
    if (repoRoot) {
      try {
        const pkgJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
        return Object.keys(pkgJson.dependencies ?? {}).filter((d) => !exclude.has(d));
      } catch {
        return [];
      }
    }
    // Standalone: walk the game's @downdraft/* deps transitively and collect
    // every external dependency they declare.
    const out = new Set<string>();
    const seen = new Set<string>();
    const visit = (pkgJsonPath: string) => {
      let pkgJson: any;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      } catch {
        return;
      }
      for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
        if (!dep.startsWith("@downdraft/")) {
          if (!exclude.has(dep)) out.add(dep);
          continue;
        }
        if (seen.has(dep)) continue;
        seen.add(dep);
        try {
          visit(req.resolve(`${dep}/package.json`));
        } catch {
          // dep declared but not installed — skip
        }
      }
    };
    visit(resolve(gameRoot, "package.json"));
    return [...out];
  }

  function warnUndeclared(): void {
    if (undeclared.size > 0) {
      const list = [...undeclared].sort().join(", ");
      console.warn(
        `[downdraft] ${undeclared.size} package(s) resolved via monorepo fallback (not declared in the game's package.json): ${list}\n` +
        `  Declare them as dependencies or standalone installs will break.`,
      );
    }
    if (missing.size > 0) {
      const list = [...missing].sort().join(", ");
      console.warn(
        `[downdraft] ${missing.size} package(s) could not be resolved from the game's package.json: ${list}\n` +
        `  Install and declare them as dependencies, or imports of them will fail.`,
      );
    }
  }

  return { src, pkg, engineDeps, repoRoot, warnUndeclared };
}
