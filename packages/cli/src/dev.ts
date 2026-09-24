import { createLogger } from "@downdraft/engine";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs, print, renderHelp } from "./args";
import { formatGamesList } from "./list-games";
import { buildCwd, findMonorepoRoot } from "./paths";
import { killProcessTree } from "./process-utils";
import { getCommand } from "./usage";

const log = createLogger();
const GAME_CONFIG = "downdraft.config.json";
const NATIVE_ENTRY = "src/native-entry.ts";

/**
 * Resolve the game directory by walking up from `process.cwd()` looking for
 * `downdraft.config.json`, falling back to `src/native-entry.ts` presence.
 * This lets games run `draft dev` from their own directory (the scaffolded
 * `package.json` already sets `"dev": "draft dev"`).
 *
 * Returns `{ game, gameDir }` or `null` if no game could be found.
 */
function resolveGameDir(): { game: string; gameDir: string } | null {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(resolve(dir, GAME_CONFIG)) || existsSync(resolve(dir, NATIVE_ENTRY))) {
      return { game: basename(dir), gameDir: dir };
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

  // Native is the only active runtime — the Electron path is dormant.
  if (parsed.flags.electron as boolean) {
    log.error("DownDraft", "The Electron runtime is disabled. The engine runs on the native runtime (Bun + SDL + wgpu-native).");
    log.error("DownDraft", "Run \"draft dev\" without --electron.");
    process.exit(1);
  }
  return devNative(parsed);
}

/**
 * Native dev mode — runs the game with Bun + SDL + wgpu-native instead of
 * Electron + Chrome. Looks for `src/native-entry.ts` in the game directory.
 */
async function devNative(parsed: any): Promise<void> {
  const resolved = resolveGameDir();
  if (!resolved) {
    log.error("DownDraft", `No game directory found (looking for downdraft.config.json or src/native-entry.ts from "${process.cwd()}").`);
    log.error("DownDraft", `Run "draft dev" from a game directory.`);
    print(formatGamesList(findMonorepoRoot() ?? process.cwd()));
    process.exit(1);
  }

  const { game, gameDir } = resolved;
  const nativeEntry = resolve(gameDir, NATIVE_ENTRY);

  if (!existsSync(nativeEntry)) {
    log.error("DownDraft", `No native entry point found at "${nativeEntry}".`);
    log.error("DownDraft", `The game "${game}" needs a src/native-entry.ts to run on the native runtime.`);
    process.exit(1);
  }

  const verbose = parsed.flags.verbose as boolean;

  log.info("DownDraft", "Starting in native mode (Bun + SDL + wgpu-native)...");
  log.info("DownDraft", `  Game: ${game}`);
  log.info("DownDraft", `  Entry: ${nativeEntry}`);
  if (verbose) log.info("DownDraft", "  Verbose: on");

  const env = { ...process.env };
  const port = parsed.flags.port as number;
  if (port) env.MCP_PORT = String(port);

  const child = spawn("bun", ["run", nativeEntry], {
    cwd: buildCwd(gameDir),
    stdio: ["inherit", "pipe", "pipe"],
    env,
    detached: true,
  });

  child.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));

  return new Promise<void>((resolvePromise, reject) => {
    child.on("error", (err) => {
      log.error("DownDraft", `Failed to spawn bun: ${err.message}`);
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
