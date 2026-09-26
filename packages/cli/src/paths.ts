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
//   - A game directory is identified by `downdraft.config.json`, falling back
//     to `src/native-entry.ts` (un-migrated games) and, last-resort, the
//     dormant `electron.vite.config.ts`. Inside the monorepo, `games/<name>`
//     resolves by name; standalone games are found by walking up from cwd.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export const GAME_CONFIG_FILE = "downdraft.config.json";
const NATIVE_ENTRY_FILE = "src/native-entry.ts";
const LEGACY_CONFIG_FILE = "electron.vite.config.ts";

function isGameDir(dir: string): boolean {
  return existsSync(join(dir, GAME_CONFIG_FILE))
    || existsSync(join(dir, NATIVE_ENTRY_FILE))
    || existsSync(join(dir, LEGACY_CONFIG_FILE));
}

/**
 * Find the downdraft monorepo root — a directory whose package.json is named
 * "downdraft-engine" and contains packages/engine. Searches cwd ancestry first,
 * then the CLI's own location (packages/cli/src → ../../.. in the monorepo).
 * Returns null when running inside a standalone game repo.
 */
export function findMonorepoRoot(start: string = process.cwd()): string | null {
  const candidates = [resolve(start), resolve(import.meta.dir, "../../..")];
  for (let _i = 0, _it = candidates, _n = _it.length; _i < _n; _i++) { const seed = _it[_i];
    let dir = seed;
    for (;;) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === "downdraft-engine" && existsSync(join(dir, "packages/engine"))) {
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
 * Walk up from `start` looking for a game directory — `downdraft.config.json`
 * or `src/native-entry.ts` (dormant `electron.vite.config.ts` accepted as a
 * legacy fallback). Works for both `games/<name>` inside the monorepo and
 * standalone game repos.
 */
export function findGameDirUpward(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (isGameDir(dir)) return dir;
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
  const upward = findGameDirUpward();
  if (!name) return upward;
  // The cwd's own game wins when its name matches — standalone repos can live
  // anywhere, and the CLI's own location may still detect the monorepo.
  if (upward && basename(upward) === name) return upward;
  const root = findMonorepoRoot();
  if (root) {
    const dir = join(root, "games", name);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * The directory builds should spawn from / write `dist` into — the monorepo
 * root when the game lives inside it (shared root dist), else the game
 * directory itself. The CLI's own location must NOT trigger the monorepo
 * branch for standalone games (linked installs resolve back into the repo).
 */
export function buildCwd(gameDir: string): string {
  const root = findMonorepoRoot();
  return root && resolve(gameDir).startsWith(root + sep) ? root : gameDir;
}
