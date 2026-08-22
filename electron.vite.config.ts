// ============================================================================
// Root electron.vite.config.ts — DOWNDRAFT_GAME dispatcher
// ============================================================================
//
// This root config delegates to the selected game's configuration via the
// createDowndraftViteConfig() factory. Each game also has its own
// electron.vite.config.ts for standalone builds (cd games/<game> && npx
// electron-vite build).
//
// Games that need custom options (workerPlugins, extraRollupInputs, etc.)
// can provide a `vite-options.ts` file in the game root that exports a
// FACTORY FUNCTION. The factory receives any plugins it needs (e.g. the
// Solid plugin) as parameters, so the root config can resolve them from
// the game's node_modules — the root workspace doesn't necessarily have
// them as dependencies.
//
// Usage: DOWNDRAFT_GAME=<game-name> bun run dev

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DowndraftViteConfigOptions } from "./packages/app/src/vite/index";
import { createDowndraftViteConfig } from "./packages/app/src/vite/index";

const game = process.env.DOWNDRAFT_GAME ?? "to-the-ocean";
const gameRoot = existsSync(resolve("games", game))
  ? resolve("games", game)
  : resolve("examples", game);

// If the game has a vite-options.ts file, load it and call the factory.
// We resolve any required plugins (e.g. vite-plugin-solid) from the game's
// node_modules using createRequire, then pass them to the factory.
const viteOptionsPath = resolve(gameRoot, "vite-options.ts");
let gameOptions: Partial<DowndraftViteConfigOptions> = {};
if (existsSync(viteOptionsPath)) {
  try {
    const { createRequire } = await import("node:module");
    // Create a require relative to the game root so require.resolve
    // searches the game's node_modules.
    const gameRequire = createRequire(resolve(gameRoot, "package.json"));

    // Load the factory function via createRequire (CJS, resolves from game root)
    const factory = gameRequire(viteOptionsPath).default;

    // Resolve vite-plugin-solid from the game's node_modules and load it.
    // Using require() (CJS) avoids ESM resolution issues from the temp dir.
    // The CJS export is the plugin function directly (no .default).
    const solid = gameRequire("vite-plugin-solid");

    gameOptions = factory(solid);
  } catch (e) {
    console.warn(`[root config] Failed to load vite-options.ts for ${game}:`, e);
  }
}

export default createDowndraftViteConfig({
  root: gameRoot,
  game,
  ...gameOptions,
});
