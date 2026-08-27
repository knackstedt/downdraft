#!/usr/bin/env bun
import { createLogger } from "@downdraft/core";
import { assets } from "./assets";
import { build } from "./build";
import { debug } from "./debug";
import { dev } from "./dev";
import { dist } from "./dist";
import { exportGame } from "./export";
import { newProject } from "./new";
import { runTest } from "./test";

const log = createLogger();

const command = process.argv[2];

async function main() {
  switch (command) {
    case "new":
      await newProject(process.argv.slice(3));
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
    case "dist":
      await dist(process.argv.slice(3));
      break;
    case "export":
      await exportGame(process.argv.slice(3));
      break;
    case "assets":
      await assets(process.argv.slice(3));
      break;
    case "test":
      await runTest(process.argv.slice(3));
      break;
    default:
      log.info("CLI", `DownDraft Engine CLI

Usage: draft <command> [options]

Commands:
  new [path] [opts] Scaffold a new game project (--template, --ai-companion)
  dev [options]     Start dev server with HMR
  debug [options]   Run engine in debug mode with profiling/visualization
  build [options]   Build for target platform
  dist [options]    Package a game for distribution via electron-builder
  export [options]  Package for distribution
  assets <cmd>      Manage remote asset packs (pull, push, list, init, add)
  test [options]    Run e2e tests via MCP automation (SwiftShader + deterministic by default)

Options:
  --verbose, -v     Enable verbose logging
  --no-devtools     Disable devtools overlay
  --inspector       Enable Node inspector

Test options:
  --game <name>       Game to test (default: to-the-ocean)
  --spec <path>       Spec file to run (default: tests/e2e/<game>-smoke.spec.ts)
  --port <n>          MCP port (default: 9976)
  --renderer <gpu|cpu>  WebGPU backend: cpu=SwiftShader (default), gpu=hardware
  --headed            Show the window instead of running headless
  --no-deterministic  Disable fixed seed / render loop pause
  --build             Build the game with electron-vite before testing (tests the packaged app)
  --build-only        Only test the built app (skip dev server; requires prior build)

Dist options:
  --game <name>       Game to package (default: DOWNDRAFT_GAME or to-the-ocean)
  --target <plat>     Target platform: win, linux, mac, or all (default: all)
  --config <path>     Explicit path to a build.config.ts / config file
  --project-dir <p>   Override the project directory (default: repo root)
`);
      process.exit(1);
  }
}

main();
