import { createLogger } from "@downdraft/core";
import { spawn } from "child_process";
import { resolve } from "path";
import { parseArgs, print, renderHelp } from "./args";
import { detectGame } from "./detect-game";
import { getCommand } from "./usage";

const log = createLogger();
const ROOT = resolve(import.meta.dir, "../../..");

export async function dev(args: string[]): Promise<void> {
  const entry = getCommand("dev")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  const game = (parsed.flags.game as string) || detectGame() || "to-the-ocean";
  const port = parsed.flags.port as number;
  const noHmr = parsed.flags["no-hmr"] as boolean;
  const verbose = parsed.flags.verbose as boolean;
  const devEntry = parsed.flags.entry as string;

  log.info("DownDraft", "Starting in dev mode...");
  log.info("DownDraft", `  Game: ${game}`);
  log.info("DownDraft", `  HMR:  ${noHmr ? "disabled" : "enabled"}`);
  if (port) log.info("DownDraft", `  MCP port: ${port}`);
  if (devEntry) log.info("DownDraft", `  Entry: ${devEntry}`);
  if (verbose) log.info("DownDraft", "  Verbose: on");

  // The root electron.vite.config.ts is a DOWNDRAFT_GAME dispatcher that
  // loads the selected game's vite-options.ts. Always pass the root config;
  // DOWNDRAFT_GAME (set below) selects the game.
  const rootConfig = resolve(ROOT, "electron.vite.config.ts");
  const childArgs = ["electron-vite", "dev", "--config", rootConfig];
  if (noHmr) childArgs.push("--no-watch");

  const env: Record<string, string> = {
    ...process.env,
    DOWNDRAFT_GAME: game,
  };
  if (port) env.MCP_PORT = String(port);
  if (devEntry) env.DOWNDRAFT_DEV_ENTRY = devEntry;
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
