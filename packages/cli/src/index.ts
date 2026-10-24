#!/usr/bin/env bun
import { createLogger, getLogTheme } from "@downdraft/engine";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArgError, print, renderHelp } from "./args";
import { assets } from "./assets";
import { debug } from "./debug";
import { dev } from "./dev";
import { devtools } from "./devtools";
import { mcp } from "./mcp";
import { newProject } from "./new";
import { pluginCommand } from "./plugin-command";
import { release } from "./release";
import { runTest } from "./test";
import { getCommand, renderTopLevelHelp } from "./usage";

const log = createLogger();

// Detect the log theme once against the real TTY and hand it to every
// spawned child (dev shell, games, test runner) — their piped stdout can't
// answer the OSC-11 probe, so without this they re-run blocking
// gsettings/dbus probes per process. An explicit DD_LOG_THEME wins.
process.env.DD_LOG_THEME ??= getLogTheme();

// Read the CLI package version for --version output.
function getCliVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dir, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const command = process.argv[2];

async function main() {
  // Global flags handled before command dispatch.
  if (command === "--version" || command === "-V") {
    print(`draft ${getCliVersion()}`);
    return;
  }
  if (command === "--help" || command === "-h" || command === undefined) {
    print(renderTopLevelHelp(getCliVersion()));
    if (command === undefined) process.exit(1);
    return;
  }

  // `help [command]` action.
  if (command === "help") {
    const target = process.argv[3];
    if (!target) {
      print(renderTopLevelHelp(getCliVersion()));
      return;
    }
    const entry = getCommand(target);
    if (!entry) {
      log.error("draft", `Unknown command: ${target}`);
      log.info("draft", `Run 'draft --help' for the list of commands.`);
      process.exit(1);
    }
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  try {
    switch (command) {
      case "new":
        await newProject(process.argv.slice(3));
        break;
      case "release":
        await release(process.argv.slice(3));
        break;
      case "dev":
        await dev(process.argv.slice(3));
        break;
      case "devtools":
        await devtools(process.argv.slice(3));
        break;
      case "debug":
        await debug(process.argv.slice(3));
        break;
      case "build":
      case "build-games":
      case "dist":
      case "export":
      case "mobile":
        log.error("draft", `\`draft ${command}\` was removed — use \`draft release\` (see \`draft help release\`).`);
        process.exit(1);
      case "assets":
        await assets(process.argv.slice(3));
        break;
      case "test":
        await runTest(process.argv.slice(3));
        break;
      case "mcp":
        await mcp(process.argv.slice(3));
        break;
      case "plugin":
        await pluginCommand(process.argv.slice(3));
        break;
      case "mod":
        // `draft mod` is an alias for `draft plugin` but defaults to mod.json format.
        await pluginCommand(["--mod", ...process.argv.slice(3)]);
        break;
      default:
        print(renderTopLevelHelp(getCliVersion()));
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof ArgError) {
      log.error("draft", err.message);
      const entry = getCommand(command);
      if (entry) {
        print("");
        print(renderHelp(entry.usage, entry.schema));
      }
      process.exit(1);
    }
    throw err;
  }
}

main().then(() => {
  // Explicit exit — the logger may hold open stream handles that keep
  // the event loop alive after main() returns.
  process.exit(0);
});
