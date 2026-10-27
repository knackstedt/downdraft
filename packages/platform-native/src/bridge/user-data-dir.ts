// ============================================================================
// user-data-dir.ts — per-app userData directory resolution for the native host
//
// Each app gets an isolated directory for saves, import cache, window
// state, and debug artifacts.
// ============================================================================

import type { AppPaths } from "@downdraft/engine/app/shared/types";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the platform application directories for an `appId`, split by
 * purpose — config (user settings), data (saves/state), cache (disposable):
 *   linux:   $XDG_CONFIG_HOME / $XDG_DATA_HOME / $XDG_CACHE_HOME
 *            (~/.config, ~/.local/share, ~/.cache)
 *   darwin:  ~/Library/Application Support (config+data) / ~/Library/Caches
 *   win32:   %APPDATA% (config+data) / %LOCALAPPDATA% (cache)
 */
export function resolveAppDirs(appId: string): AppPaths {
  const home = homedir();
  switch (process.platform) {
    case "win32": {
      const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      return {
        configDir: join(roaming, appId),
        dataDir: join(roaming, appId),
        cacheDir: join(local, appId),
      };
    }
    case "darwin": {
      const appSupport = join(home, "Library", "Application Support", appId);
      return {
        configDir: appSupport,
        dataDir: appSupport,
        cacheDir: join(home, "Library", "Caches", appId),
      };
    }
    default:
      return {
        configDir: join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), appId),
        dataDir: join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), appId),
        cacheDir: join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), appId),
      };
  }
}

/**
 * Resolve the per-app userData directory — the legacy single-dir contract
 * (saves, import cache, window state, singleton lock). Equivalent to
 * `resolveAppDirs(appId).configDir`; new code should consume `downdraft.paths`
 * and pick the right directory per artifact.
 */
export function resolveNativeUserDataDir(appId: string): string {
  return resolveAppDirs(appId).configDir;
}
