// ============================================================================
// `dd plugin` — CLI subcommand for plugin management.
//
// Usage:
//   dd plugin new <name> --format <format> --game <game> [options]
//   dd plugin list [--game <game>]
// ============================================================================

import { createLogger } from "@downdraft/core";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { print } from "./args";
import { scaffoldPlugin } from "./scaffold-plugin";

const log = createLogger();

export async function pluginCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case "new":
      await pluginNew(rest);
      break;
    case "list":
      pluginList(rest);
      break;
    case "help":
    case "--help":
    case "-h":
      printPluginHelp();
      break;
    default:
      log.error("plugin", `Unknown subcommand: "${subcommand ?? ""}"`);
      printPluginHelp();
      process.exit(1);
  }
}

async function pluginNew(args: string[]): Promise<void> {
  // Simple arg parsing: dd plugin new <name> --format <format> --game <game> [--version <ver>] [--author <name>] [--description <desc>] [--target <dir>] [--force]
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
    log.error("plugin", "Usage: dd plugin new <name> --format <format> --game <game>");
    process.exit(1);
  }

  const format = (flags.format as string) ?? "worker-js";
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
  });
}

function pluginList(args: string[]): void {
  // Find all games/*/plugins/*/plugin.json
  const cwd = resolve(".");
  const gamesDir = join(cwd, "games");
  if (!existsSync(gamesDir)) {
    log.info("plugin", "No games/ directory found.");
    return;
  }

  const filterGame = args.find((a) => !a.startsWith("--"));
  let found = 0;

  for (const game of readdirSync(gamesDir)) {
    if (filterGame && game !== filterGame) continue;
    const pluginsDir = join(gamesDir, game, "plugins");
    if (!existsSync(pluginsDir)) continue;
    for (const plugin of readdirSync(pluginsDir)) {
      const manifestPath = join(pluginsDir, plugin, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        log.info("plugin", `  ${game}/${plugin} — ${manifest.name ?? plugin} v${manifest.version ?? "?"} [${manifest.format ?? "?"}/${manifest.tier ?? "?"}]`);
        found++;
      } catch {
        log.warn("plugin", `  ${game}/${plugin} — invalid plugin.json`);
      }
    }
  }

  if (found === 0) {
    log.info("plugin", "No plugins found.");
  } else {
    log.info("plugin", `Found ${found} plugin(s).`);
  }
}

function printPluginHelp(): void {
  print(`
dd plugin — manage user-authored plugins

Usage:
  dd plugin new <name> --format <format> --game <game> [options]
  dd plugin list [--game <game>]

Commands:
  new     Scaffold a new plugin directory
  list    List discovered plugins in games/*/plugins/*

Options for 'new':
  --format <format>     Plugin format: worker-js, quickjs, wasm, asset (default: worker-js)
  --game <game>         Target game appId (required, e.g. downdraft-overburden)
  --name <name>         Display name (default: derived from id)
  --version <ver>       Plugin version (default: 1.0.0)
  --author <name>       Author name
  --description <desc>  Short description
  --target <dir>        Target directory (default: current dir)
  --force               Overwrite if directory exists
`);
}
