// ============================================================================
// engine-resolve.ts — locate the @downdraft/engine package in both layouts
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

import { createLogger } from "@downdraft/engine/util/logger";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const log = createLogger("info");

export interface EngineResolver {
  /** Absolute path to the @downdraft/engine package root (…/packages/engine). */
  engineRoot: string;
  /** Absolute path to a subsystem `src/` dir inside the engine package —
   *  `src("libraries/water")` → `<engineRoot>/libraries/water/src`,
   *  `src("core")` → `<engineRoot>/core/src`. */
  src(rel: string): string;
  /** Absolute path inside the engine package — `at("app/src")` → `<engineRoot>/app/src`. */
  at(rel: string): string;
  /**
   * External (non-@downdraft) `dependencies` of the engine package, minus the
   * excluded set. The engine manifest already unions every folded subsystem's
   * externals. Used for Vite optimizeDeps.include.
   */
  engineDeps(exclude: Set<string>): string[];
  /** The monorepo root when detected (game at <root>/games/<name>), else null. */
  repoRoot: string | null;
  /**
   * Warn once if @downdraft/engine only resolved via the monorepo fallback
   * (not declared in the game's package.json) or could not be resolved at
   * all in a standalone layout. Call after building the alias table — alias
   * probing engages the fallback eagerly, so per-call warnings would be noise.
   */
  warnUndeclared(): void;
}

const ENGINE_PKG = "@downdraft/engine";

/**
 * @param gameRoot absolute path to the game directory.
 * @param monorepoRoot optional override for the monorepo root detection —
 *        defaults to `<gameRoot>/../..`.
 */
export function createEngineResolver(gameRoot: string, monorepoRoot?: string): EngineResolver {
  const candidate = monorepoRoot ?? resolve(gameRoot, "../..");
  const repoRoot = existsSync(join(candidate, "packages/engine/package.json")) ? candidate : null;
  const req = createRequire(resolve(gameRoot, "package.json"));
  let undeclared = false;
  let missing = false;

  let engineRoot: string;
  try {
    engineRoot = dirname(req.resolve(`${ENGINE_PKG}/package.json`));
  } catch {
    // Not installed / not a declared dep — fall back to the monorepo layout
    // so engine code still resolves inside the engine repo. Standalone games
    // have no monorepo to fall back to: return the conventional node_modules
    // path so the failure names the package.
    if (repoRoot) {
      undeclared = true;
      engineRoot = join(repoRoot, "packages/engine");
    } else {
      missing = true;
      engineRoot = join(gameRoot, "node_modules", ENGINE_PKG);
    }
  }

  const at = (rel: string) => join(engineRoot, rel);
  const src = (rel: string) => join(engineRoot, rel, "src");

  function engineDeps(exclude: Set<string>): string[] {
    // The engine package's own dependency list is the canonical external dep
    // set — it already unions every folded subsystem's externals.
    const out = new Set<string>();
    try {
      const pkgJson = JSON.parse(readFileSync(join(engineRoot, "package.json"), "utf-8"));
      for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
        if (!dep.startsWith("@downdraft/") && !exclude.has(dep)) out.add(dep);
      }
    } catch { /* engine package unreadable — no deps to contribute */ }
    return [...out];
  }

  function warnUndeclared(): void {
    if (undeclared) {
      log.warn(
        "downdraft",
        `${ENGINE_PKG} resolved via monorepo fallback (not declared in the game's package.json).\n` +
        `  Declare it as a dependency or standalone installs will break.`,
      );
    }
    if (missing) {
      log.warn(
        "downdraft",
        `${ENGINE_PKG} could not be resolved from the game's package.json.\n` +
        `  Install and declare it as a dependency, or imports of it will fail.`,
      );
    }
  }

  return { engineRoot, src, at, engineDeps, repoRoot, warnUndeclared };
}
