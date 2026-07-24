#!/usr/bin/env bun
import { init } from "./init.ts";
import { dev } from "./dev.ts";
import { debug } from "./debug.ts";
import { build } from "./build.ts";
import { exportGame } from "./export.ts";

const command = process.argv[2];

async function main() {
  switch (command) {
    case "init":
      await init(process.argv[3] ?? ".");
      break;
    case "dev":
      await dev(process.argv.slice(3));
      break;
    case "debug":
      await debug(process.argv.slice(3));
      break;
    case "build":
      await build(process.argv.slice(3));
      break;
    case "export":
      await exportGame(process.argv.slice(3));
      break;
    default:
      console.log(`DownDraft Engine CLI

Usage: draft <command> [options]

Commands:
  init [path]       Scaffold a new game project
  dev [options]     Start dev server with HMR
  debug [options]   Run engine in debug mode with profiling/visualization
  build [options]   Build for target platform
  export [options]  Package for distribution

Options:
  --verbose, -v     Enable verbose logging
  --no-devtools     Disable devtools overlay
  --inspector       Enable Node inspector
`);
      process.exit(1);
  }
}

main();
