// ============================================================================
// paths.ts — monorepo vs standalone-app resolution for the draft CLI
// ============================================================================
//
// The CLI runs in two layouts:
//
//   1. Monorepo — the workspace `draft` bin, apps at <root>/apps/<name>.
//   2. Standalone — @downdraft/cli installed as an app repo devDep; the app
//      directory IS the project root (no apps/ level).
//
// Resolution rules:
//   - The monorepo root is detected by walking up looking for a package.json
//     named "downdraft-engine" (the CLI's own install location is checked too,
//     so `draft --app <x>` still works when invoked from outside the repo).
//   - An app directory is identified by `downdraft.config.json`, falling back
//     to `src/native-entry.ts` (un-migrated apps). Inside the monorepo,
//     `apps/<name>` resolves by name; standalone apps are found by walking
//     up from cwd.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export const APP_CONFIG_FILE = "downdraft.config.json";
const NATIVE_ENTRY_FILE = "src/native-entry.ts";

function isAppDir(dir: string): boolean {
  return existsSync(join(dir, APP_CONFIG_FILE))
    || existsSync(join(dir, NATIVE_ENTRY_FILE));
}

/**
 * Read an app's `downdraft.config.json` — engine-level settings that apply
 * regardless of the app's package.json build section. Missing/invalid files
 * yield `{}` (the file doubles as an app-dir marker, so it may be absent).
 *
 *   { "runtime": "bun" | "node" | "deno" }  — default JS runtime for
 *   `draft dev`/`draft release` (overridden by --runtime / DD_RUNTIME).
 */
export function readAppConfig(appDir: string): Record<string, unknown> {
  try {
    const cfg = JSON.parse(readFileSync(join(appDir, APP_CONFIG_FILE), "utf8"));
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

/**
 * Find the downdraft monorepo root — a directory whose package.json is named
 * "downdraft-engine" and contains packages/engine. Searches cwd ancestry first,
 * then the CLI's own location (packages/cli/src → ../../.. in the monorepo).
 * Returns null when running inside a standalone app repo.
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
 * Walk up from `start` looking for an app directory — `downdraft.config.json`
 * or `src/native-entry.ts`. Works for both `apps/<name>` inside the monorepo
 * and standalone app repos.
 */
export function findAppDirUpward(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (isAppDir(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Resolve an app's directory.
 *  - `name` given + monorepo → `<root>/apps/<name>` (must exist).
 *  - `name` given + standalone → cwd's app dir, if its basename matches.
 *  - no name → walk up from cwd for the nearest app dir.
 * Returns null when nothing resolves.
 */
export function resolveAppDir(name?: string): string | null {
  const upward = findAppDirUpward();
  if (!name) return upward;
  // The cwd's own app wins when its name matches — standalone repos can live
  // anywhere, and the CLI's own location may still detect the monorepo.
  if (upward && basename(upward) === name) return upward;
  const root = findMonorepoRoot();
  if (root) {
    // apps/ holds tracked in-repo apps; games/ holds local project clones
    // (gitignored); examples/ holds tracked fixtures (e.g. packaging-smoke).
    for (const base of ["apps", "games", "examples"].values()) {
      const dir = join(root, base, name);
      if (existsSync(dir)) return dir;
    }
  }
  return null;
}

/**
 * The directory builds should spawn from / write `dist` into — the monorepo
 * root when the app lives inside it (shared root dist), else the app
 * directory itself. The CLI's own location must NOT trigger the monorepo
 * branch for standalone apps (linked installs resolve back into the repo).
 */
export function buildCwd(appDir: string): string {
  const root = findMonorepoRoot();
  return root && resolve(appDir).startsWith(root + sep) ? root : appDir;
}
