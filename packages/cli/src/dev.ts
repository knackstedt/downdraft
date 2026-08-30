import { createLogger } from "@downdraft/core";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs, print, renderHelp } from "./args";
import { formatGamesList } from "./list-games";
import { getCommand } from "./usage";

const log = createLogger();
const ROOT = resolve(import.meta.dir, "../../..");
const CONFIG_FILE = "electron.vite.config.ts";

/**
 * Resolve the game's `electron.vite.config.ts` path.
 *
 * Resolution order:
 *  1. `--game <name>` — explicit; resolves `games/<name>/electron.vite.config.ts`
 *     relative to the engine root (back-compat with root-level invocation).
 *  2. cwd inference — walk up from `process.cwd()` looking for
 *     `electron.vite.config.ts`. This lets games run `draft dev` from their
 *     own directory (the scaffolded `package.json` already sets
 *     `"dev": "draft dev"`).
 *
 * Returns `{ game, configPath }` or `null` if no config could be found.
 */
function resolveGameConfig(gameArg: string | undefined): { game: string; configPath: string } | null {
  // 1. Explicit --game: resolve against the engine root's games/ directory.
  if (gameArg) {
    const configPath = resolve(ROOT, "games", gameArg, CONFIG_FILE);
    if (existsSync(configPath)) return { game: gameArg, configPath };
    return null;
  }

  // 2. Cwd inference: walk up looking for electron.vite.config.ts.
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, CONFIG_FILE);
    if (existsSync(candidate)) return { game: basename(dir), configPath: candidate };
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

export async function dev(args: string[]): Promise<void> {
  const entry = getCommand("dev")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  const gameArg = (parsed.flags.game as string) || undefined;
  const resolved = resolveGameConfig(gameArg);
  if (!resolved) {
    if (gameArg) {
      log.error("DownDraft", `No electron.vite.config.ts found for game "${gameArg}" at ${resolve(ROOT, "games", gameArg, CONFIG_FILE)}`);
    } else {
      log.error("DownDraft", `No electron.vite.config.ts found in "${process.cwd()}" (or any parent directory).`);
      log.error("DownDraft", `Run "draft dev" from a game directory, or use "--game <name>" from the engine root.`);
    }
    print(formatGamesList(ROOT));
    process.exit(1);
  }

  const { game, configPath: gameConfig } = resolved;

  const port = parsed.flags.port as number;
  const noHmr = parsed.flags["no-hmr"] as boolean;
  const noBake = parsed.flags["no-bake"] as boolean;
  const verbose = parsed.flags.verbose as boolean;
  const devEntry = parsed.flags.entry as string;

  log.info("DownDraft", "Starting in dev mode...");
  log.info("DownDraft", `  Game: ${game}`);
  log.info("DownDraft", `  Config: ${gameConfig}`);
  log.info("DownDraft", `  HMR:  ${noHmr ? "disabled" : "enabled"}`);
  if (port) log.info("DownDraft", `  MCP port: ${port}`);
  if (devEntry) log.info("DownDraft", `  Entry: ${devEntry}`);
  if (verbose) log.info("DownDraft", "  Verbose: on");

  const childArgs = ["electron-vite", "dev", "--config", gameConfig];
  if (noHmr) childArgs.push("--no-watch");

  const env: Record<string, string> = { ...process.env };
  if (port) env.MCP_PORT = String(port);
  if (devEntry) env.DOWNDRAFT_DEV_ENTRY = devEntry;
  if (noBake) env.DOWNDRAFT_BAKE = "0";
  // Critical: Electron must NOT run as Node.js.
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn("npx", childArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env,
    detached: true,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("DownDraft", "Shutting down...");
    child.kill("SIGINT");
    setTimeout(() => {
      // Kill entire process group (child + renderer) as fallback
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      process.exit(130);
    }, 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
