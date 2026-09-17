// ============================================================================
// paths.ts — monorepo vs standalone-game resolution for the draft CLI
// ============================================================================
//
// The CLI runs in two layouts:
//
//   1. Monorepo — the workspace `draft` bin, games at <root>/games/<name>.
//   2. Standalone — @downdraft/cli installed as a game repo devDep; the game
//      directory IS the project root (no games/ level).
//
// Resolution rules:
//   - The monorepo root is detected by walking up looking for a package.json
//     named "downdraft-engine" (the CLI's own install location is checked too,
//     so `draft --game <x>` still works when invoked from outside the repo).
//   - A game directory is identified by containing `electron.vite.config.ts`.
//     Inside the monorepo, `games/<name>` resolves by name; standalone games
//     are found by walking up from cwd (or verified against the name).

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const GAME_CONFIG_FILE = "electron.vite.config.ts";

/**
 * Find the downdraft monorepo root — a directory whose package.json is named
 * "downdraft-engine" and contains packages/core. Searches cwd ancestry first,
 * then the CLI's own location (packages/cli/src → ../../.. in the monorepo).
 * Returns null when running inside a standalone game repo.
 */
export function findMonorepoRoot(start: string = process.cwd()): string | null {
  const candidates = [resolve(start), resolve(import.meta.dir, "../../..")];
  for (const seed of candidates) {
    let dir = seed;
    for (;;) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === "downdraft-engine" && existsSync(join(dir, "packages/core"))) {
          return dir;
        }
      } catch { /* no package.json here — keep walking */ }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

/**
 * Walk up from `start` looking for a directory containing
 * `electron.vite.config.ts` — the marker for a game directory. Works for both
 * `games/<name>` inside the monorepo and standalone game repos.
 */
export function findGameDirUpward(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, GAME_CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Resolve a game's directory.
 *  - `name` given + monorepo → `<root>/games/<name>` (must exist).
 *  - `name` given + standalone → cwd's game dir, if its basename matches.
 *  - no name → walk up from cwd for the nearest game dir.
 * Returns null when nothing resolves.
 */
export function resolveGameDir(name?: string): string | null {
  if (name) {
    const root = findMonorepoRoot();
    if (root) {
      const dir = join(root, "games", name);
      return existsSync(dir) ? dir : null;
    }
    const dir = findGameDirUpward();
    return dir && basename(dir) === name ? dir : null;
  }
  return findGameDirUpward();
}

/**
 * The directory builds should spawn from / write `dist` into — the monorepo
 * root when inside it, else the game directory itself.
 */
export function buildCwd(gameDir: string): string {
  return findMonorepoRoot() ?? gameDir;
}
