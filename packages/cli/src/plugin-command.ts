// ============================================================================
// `dd plugin` — CLI subcommand for plugin management.
//
// Usage:
//   dd plugin new <name> --format <format> --game <game> [options]
//   dd plugin list [--game <game>]
// ============================================================================

import { createLogger } from "@downdraft/engine";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { print } from "./args";
import { findGameDirUpward, findMonorepoRoot } from "./paths";
import { scaffoldPlugin } from "./scaffold-plugin";

const log = createLogger();

export async function pluginCommand(args: string[]): Promise<void> {
  // `dd mod new ...` injects --mod flag so scaffoldPlugin generates mod.json.
  // `dd plugin new ...` defaults to plugin.json (legacy).
  let modMode = false;
  if (args[0] === "--mod") {
    modMode = true;
    args = args.slice(1);
  }
  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case "new":
      await pluginNew(rest, modMode);
      break;
    case "list":
      pluginList(rest);
      break;
    case "help":
    case "--help":
    case "-h":
      printPluginHelp(modMode);
      break;
    default:
      log.error("plugin", `Unknown subcommand: "${subcommand ?? ""}"`);
      printPluginHelp(modMode);
      process.exit(1);
  }
}

async function pluginNew(args: string[], modMode: boolean): Promise<void> {
  // Simple arg parsing: dd plugin new <name> --format <format> --game <game> [--version <ver>] [--author <name>] [--description <desc>] [--target <dir>] [--force] [--mod] [--with <ext>]
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }

  const id = positional[0];
  if (!id) {
    log.error("plugin", `Usage: dd ${modMode ? "mod" : "plugin"} new <name> --format <format> --game <game>`);
    process.exit(1);
  }

  const format = (flags.format as string) ?? (modMode ? "asset" : "worker-js");
  const game = (flags.game as string) ?? "";
  if (!game) {
    log.error("plugin", "--game is required (e.g. --game downdraft-overburden)");
    process.exit(1);
  }

  const validFormats = ["worker-js", "quickjs", "wasm", "asset"];
  if (!validFormats.includes(format)) {
    log.error("plugin", `Invalid format "${format}". Valid: ${validFormats.join(", ")}`);
    process.exit(1);
  }

  const name = (flags.name as string) ?? id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const version = (flags.version as string) ?? "1.0.0";
  const author = flags.author as string | undefined;
  const description = flags.description as string | undefined;
  const targetDir = (flags.target as string) ?? ".";
  const force = flags.force === true;

  // Parse --with <ext> for mod extensions (repeatable).
  const withFlags: string[] = [];
  if (flags.with) {
    if (typeof flags.with === "string") withFlags.push(flags.with);
    // Also scan args for repeated --with
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--with" && i + 1 < args.length && !args[i + 1].startsWith("--")) {
        if (!withFlags.includes(args[i + 1])) withFlags.push(args[i + 1]);
      }
    }
  }
  const validExtensions = ["assets", "maps", "physics", "shader-postfx", "shader-material"];
  withFlags.forEach((ext) => {
    if (!validExtensions.includes(ext)) {
      log.error("plugin", `Invalid --with extension "${ext}". Valid: ${validExtensions.join(", ")}`);
      process.exit(1);
    }
  });

  await scaffoldPlugin({
    id,
    name,
    format: format as any,
    game,
    version,
    author,
    description,
    targetDir,
    force,
    mod: modMode,
    extensions: withFlags.length > 0 ? withFlags as any : undefined,
  });
}

function pluginList(args: string[]): void {
  // Find all games/*/plugins/*/{plugin.json,mod.json} (monorepo), or
  // <gameDir>/plugins/* when running inside a standalone game repo.
  const monorepoRoot = findMonorepoRoot();
  const filterGame = args.find((a) => !a.startsWith("--"));

  let gameDirs: { name: string; dir: string }[];
  if (monorepoRoot) {
    const gamesDir = join(monorepoRoot, "games");
    if (!existsSync(gamesDir)) {
      log.info("plugin", "No games/ directory found.");
      return;
    }
    gameDirs = readdirSync(gamesDir)
      .filter((g) => existsSync(join(gamesDir, g)))
      .map((g) => ({ name: g, dir: join(gamesDir, g) }));
  } else {
    const gameDir = findGameDirUpward();
    if (!gameDir) {
      log.info("plugin", "No games/ directory found and not inside a game repo.");
      return;
    }
    gameDirs = [{ name: basename(gameDir), dir: gameDir }];
  }

  let found = 0;

  for (let _i = 0, _it = gameDirs, _n = _it.length; _i < _n; _i++) { const { name: game, dir: gameDirPath } = _it[_i];
    if (filterGame && game !== filterGame) continue;
    const pluginsDir = join(gameDirPath, "plugins");
    if (!existsSync(pluginsDir)) continue;
    for (const plugin of readdirSync(pluginsDir)) {
      // Prefer mod.json, fall back to plugin.json.
      const modPath = join(pluginsDir, plugin, "mod.json");
      const pluginPath = join(pluginsDir, plugin, "plugin.json");
      const manifestPath = existsSync(modPath) ? modPath : existsSync(pluginPath) ? pluginPath : null;
      if (!manifestPath) continue;
      const isMod = manifestPath === modPath;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const extCount = manifest.extensions
          ? Object.values(manifest.extensions).reduce(
              (n: number, v: any) => n + (Array.isArray(v) ? v.length : (v && typeof v === "object" ? Object.keys(v).length : 0)),
              0,
            )
          : 0;
        const extLabel = isMod && extCount > 0 ? ` (${extCount} ext)` : "";
        log.info("plugin", `  ${game}/${plugin} — ${manifest.name ?? plugin} v${manifest.version ?? "?"} [${manifest.format ?? "?"}/${manifest.tier ?? "?"}]${isMod ? " [mod]" : ""}${extLabel}`);
        found++;
      } catch {
        log.warn("plugin", `  ${game}/${plugin} — invalid ${isMod ? "mod.json" : "plugin.json"}`);
      }
    }
  }

  if (found === 0) {
    log.info("plugin", "No plugins or mods found.");
  } else {
    log.info("plugin", `Found ${found} plugin(s)/mod(s).`);
  }
}

function printPluginHelp(modMode: boolean): void {
  const cmd = modMode ? "mod" : "plugin";
  print(`
dd ${cmd} — manage user-authored ${modMode ? "mods" : "plugins"}

Usage:
  dd ${cmd} new <name> --format <format> --game <game> [options]
  dd ${cmd} list [--game <game>]

Commands:
  new     Scaffold a new ${modMode ? "mod" : "plugin"} directory
  list    List discovered ${modMode ? "mods + plugins" : "plugins + mods"} in games/*/plugins/*

Options for 'new':
  --format <format>     Plugin format: worker-js, quickjs, wasm, asset${modMode ? " (default: asset)" : " (default: worker-js)"}
  --game <game>         Target game appId (required, e.g. downdraft-overburden)
  --name <name>         Display name (default: derived from id)
  --version <ver>       Plugin version (default: 1.0.0)
  --author <name>       Author name
  --description <desc>  Short description
  --target <dir>        Target directory (default: current dir)
  --force               Overwrite if directory exists${modMode ? `
  --with <ext>          Include extension bucket (repeatable): assets, maps, physics, shader-postfx, shader-material` : ""}
`);
}
