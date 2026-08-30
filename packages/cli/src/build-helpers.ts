// ============================================================================
// build-helpers.ts — shared build functions used by release.ts + legacy cmds
// ============================================================================
//
// Extracted from the inline `spawnSync("npx", ["electron-vite", "build", ...])`
// calls that were duplicated across `build-games.ts` and `test.ts`, plus the
// `buildMobileWeb()` function from `mobile.ts`. Having a single source of
// truth for the desktop + mobile build steps means `draft release` and the
// legacy commands all exercise the same code path.
//

import { createLogger } from "@downdraft/core";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const log = createLogger();

/**
 * Build a game's desktop bundle via `electron-vite build`.
 *
 * This is the real build step (Vite bundling, minification, etc.) — the old
 * `draft build` command was a naive file-copy that did NOT bundle. This
 * function consolidates the inline `spawnSync` calls that were duplicated in
 * `build-games.ts` and `test.ts`.
 *
 * @param repoRoot  absolute path to the repo root (monorepo layout).
 * @param game      game directory name under `games/`.
 * @returns true if the build succeeded, false otherwise.
 */
export function buildDesktop(repoRoot: string, game: string, env?: Record<string, string>): boolean {
  const configPath = resolve(repoRoot, "games", game, "electron.vite.config.ts");
  if (!existsSync(configPath)) {
    log.error("release:build:desktop", `No electron.vite.config.ts found for game "${game}" at ${configPath}`);
    return false;
  }
  log.info("release:build:desktop", `Building game "${game}" with electron-vite...`);
  const result = spawnSync("npx", ["electron-vite", "build", "--config", configPath], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    log.error("release:build:desktop", `Build failed with exit code ${result.status}`);
    return false;
  }
  // Verify the build output exists.
  const distMain = resolve(repoRoot, "dist", "main", "index.cjs");
  if (!existsSync(distMain)) {
    log.error("release:build:desktop", `Build completed but dist/main/index.cjs not found at ${distMain}`);
    return false;
  }
  log.info("release:build:desktop", "Build succeeded.");
  return true;
}
