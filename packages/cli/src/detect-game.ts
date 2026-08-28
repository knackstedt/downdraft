import { basename, resolve } from "node:path";

/**
 * Detect which game to operate on, in priority order:
 *   1. `DOWNDRAFT_GAME` env var (set by `bun run dev` / `draft dev`).
 *   2. The current working directory — if it is (or is inside) a
 *      `games/<name>/` directory, use `<name>`.
 *   3. `null` if no game can be detected — the caller should error with a
 *      list of available games.
 */
export function detectGame(): string | null {
  // 1. Env var
  const envGame = process.env.DOWNDRAFT_GAME;
  if (envGame) return envGame;

  // 2. CWD detection — walk up looking for a `games/<name>` path segment.
  //    Also handle the case where CWD *is* the game directory (basename match).
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const parent = resolve(dir, "..");
    if (parent === dir) break; // reached filesystem root
    if (basename(parent) === "games") {
      const name = basename(dir);
      if (name) return name;
    }
    dir = parent;
  }

  return null;
}
