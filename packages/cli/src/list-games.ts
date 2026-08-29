import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * List available game names from the monorepo `games/` directory.
 * A directory counts as a game if it contains an `electron.vite.config.ts`.
 * Returns an empty array if the `games/` directory doesn't exist.
 */
export function listGames(repoRoot: string): string[] {
  const gamesDir = resolve(repoRoot, "games");
  if (!existsSync(gamesDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(gamesDir)) {
    const dir = resolve(gamesDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(resolve(dir, "electron.vite.config.ts"))) {
      out.push(entry);
    }
  }
  return out.sort();
}

/**
 * Format the available-games list for an error message.
 */
export function formatGamesList(repoRoot: string): string {
  const games = listGames(repoRoot);
  if (games.length === 0) return "  (no games found in games/)";
  return games.map((g) => `  - ${g}`).join("\n");
}
