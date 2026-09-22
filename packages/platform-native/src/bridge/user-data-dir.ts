// ============================================================================
// user-data-dir.ts — per-game userData directory resolution for the native host
//
// Mirrors Electron's `app.setPath("userData", join(appData, appId))` behavior
// (app/src/main/storage.ts): each game gets an isolated directory for saves,
// import cache, window state, and debug artifacts.
// ============================================================================

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the per-game userData directory from an `appId`, following the
 * platform conventions Electron uses for `app.getPath("appData")`:
 *   linux:   $XDG_CONFIG_HOME/<appId>   (~/.config/<appId>)
 *   darwin:  ~/Library/Application Support/<appId>
 *   win32:   %APPDATA%/<appId>
 */
export function resolveNativeUserDataDir(appId: string): string {
  const home = homedir();
  switch (process.platform) {
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), appId);
    case "darwin":
      return join(home, "Library", "Application Support", appId);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), appId);
  }
}
