import { createLogger } from "@downdraft/core";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs, print, renderHelp } from "./args";
import { formatGamesList } from "./list-games";
import { killProcessTree, killStaleInstance } from "./process-utils";
import { getCommand } from "./usage";

const log = createLogger();
const ROOT = resolve(import.meta.dir, "../../..");
const CONFIG_FILE = "electron.vite.config.ts";

/**
 * Resolve the game's `electron.vite.config.ts` path by walking up from
 * `process.cwd()` looking for the config file. This lets games run `draft dev`
 * from their own directory (the scaffolded `package.json` already sets
 * `"dev": "draft dev"`).
 *
 * Returns `{ game, gameDir, configPath }` or `null` if no config could be
 * found.
 */
function resolveGameConfig(): { game: string; gameDir: string; configPath: string } | null {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, CONFIG_FILE);
    if (existsSync(candidate)) {
      return { game: basename(dir), gameDir: dir, configPath: candidate };
    }
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

  const resolved = resolveGameConfig();
  if (!resolved) {
    log.error("DownDraft", `No electron.vite.config.ts found in "${process.cwd()}" (or any parent directory).`);
    log.error("DownDraft", `Run "draft dev" from a game directory.`);
    print(formatGamesList(ROOT));
    process.exit(1);
  }

  const { game, gameDir, configPath: gameConfig } = resolved;

  const port = parsed.flags.port as number;
  const noHmr = parsed.flags["no-hmr"] as boolean;
  const noBake = parsed.flags["no-bake"] as boolean;
  const verbose = parsed.flags.verbose as boolean;
  const devEntry = parsed.flags.entry as string;

  // Kill any stale Electron instance from a previous dev run before spawning.
  // VS Code's task runner doesn't reliably tear down the detached electron
  // process group when a task is stopped, so orphaned game windows accumulate
  // and hold the per-game userData LevelDB locks. This replaces the per-game
  // bash pgrep/kill loop that used to live in .vscode/tasks.json.
  const killed = killStaleInstance(gameDir);
  if (killed > 0) {
    log.info("DownDraft", `Killed ${killed} stale process(es) from a previous run of "${game}".`);
  }

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

  // Spawn in a new session (detached) so the child becomes a process-group
  // leader. This protects it from signals sent to the parent's process group
  // (e.g. when VS Code's task runner or the exec tool backgrounds the parent).
  //
  // We pipe stdout/stderr instead of inheriting them: with `stdio: "inherit"`
  // + `detached: true`, the child tries to use the pty directly from a new
  // session, which fails in VS Code's task runner (the child exits
  // immediately). By piping, the parent — which IS connected to the pty —
  // reads the child's output and writes it to its own stdout/stderr. This is
  // the same pattern the e2e harness uses (tests/e2e/harness.ts).
  const child = spawn("npx", childArgs, {
    cwd: ROOT,
    stdio: ["inherit", "pipe", "pipe"],
    env,
    detached: true,
  });

  // Forward piped output to the parent's stdout/stderr.
  child.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));

  // Wait for the child to exit before resolving. Without this, the CLI entry
  // point (index.ts) calls `process.exit(0)` in its `main().then()` handler
  // immediately after `dev()` returns, killing the parent before the child
  // can produce any output.
  return new Promise<void>((resolvePromise, reject) => {
    child.on("error", (err) => {
      log.error("DownDraft", `Failed to spawn electron-vite: ${err.message}`);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
      }
      process.exit(code ?? 0);
    });

    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("DownDraft", "Shutting down...");
      // Kill the child's process group (works because detached: true made the
      // child a group leader). Falls back to a descendant tree-walk for any
      // helpers that called setsid.
      try { child.kill("SIGINT"); } catch {}
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
      }
      setTimeout(() => {
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch {}
          killProcessTree(child.pid);
        }
        process.exit(130);
      }, 2000);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGHUP", shutdown);
  });
}
