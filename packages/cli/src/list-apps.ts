import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { APP_CONFIG_FILE } from "./paths";

/**
 * List available app names from the monorepo `apps/` directory.
 * A directory counts as an app if it contains `downdraft.config.json` or
 * `src/native-entry.ts` (same predicate as `isAppDir` in paths.ts).
 * Returns an empty array if the `apps/` directory doesn't exist.
 */
export function listApps(repoRoot: string): string[] {
  // apps/ holds tracked in-repo apps; games/ holds local clones (gitignored).
  const out = new Set<string>();
  for (let _i = 0, _it = ["apps", "games"], _n = _it.length; _i < _n; _i++) { const base = _it[_i];
    const appsDir = resolve(repoRoot, base);
    if (!existsSync(appsDir)) continue;
    for (const entry of readdirSync(appsDir)) {
      const dir = resolve(appsDir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(resolve(dir, APP_CONFIG_FILE)) || existsSync(resolve(dir, "src/native-entry.ts"))) {
        out.add(entry);
      }
    }
  }
  return [...out].sort();
}

/**
 * Format the available-apps list for an error message.
 */
export function formatAppsList(repoRoot: string): string {
  const apps = listApps(repoRoot);
  if (apps.length === 0) return "  (no apps found in apps/ or games/)";
  return apps.map((g) => `  - ${g}`).join("\n");
}
