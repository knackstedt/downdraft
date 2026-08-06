// ============================================================================
// Root electron.vite.config.ts — DOWNDRAFT_GAME dispatcher
// ============================================================================
//
// This root config delegates to the selected game's configuration via the
// createDowndraftViteConfig() factory. Each game also has its own
// electron.vite.config.ts for standalone builds.
//
// Usage: DOWNDRAFT_GAME=<game-name> bun run dev

import { existsSync } from "node:fs";
import { resolve } from "path";
import { createDowndraftViteConfig } from "./packages/app/src/vite/index";

const game = process.env.DOWNDRAFT_GAME ?? "to-the-ocean";
const gameRoot = existsSync(resolve("games", game))
  ? resolve("games", game)
  : resolve("examples", game);

export default createDowndraftViteConfig({ root: gameRoot, game });
