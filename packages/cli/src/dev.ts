import { createLogger } from "@downdraft/engine";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, print, renderHelp } from "./args";
import { formatGamesList } from "./list-games";
import { buildCwd, findMonorepoRoot } from "./paths";
import { killProcessTree } from "./process-utils";
import { getCommand } from "./usage";

const log = createLogger();
const GAME_CONFIG = "downdraft.config.json";
const NATIVE_ENTRY = "src/native-entry.ts";

/**
 * Exit code the dev shell uses to request a clean process restart
 * (Tier-5: dev-shell/loader/config changes, unrecoverable teardown failure).
 * Duplicated from platform-native's dev-constants.mjs — the CLI cannot import
 * engine package internals at type-check time in every layout, so keep the
 * literal in sync.
 */
const DD_RESTART_EXIT = 75;

/** Resolve packages/platform-native/src/dev/ — via package resolution first
 *  (standalone installs), then the monorepo layout. */
function resolveDevShellDir(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@downdraft/platform-native/package.json");
    const dir = join(dirname(pkgJson), "src", "dev");
    if (existsSync(join(dir, "dev-shell.mjs"))) return dir;
  } catch { /* fall through to monorepo guess */ }
  const root = findMonorepoRoot();
  if (root) return join(root, "packages/platform-native/src/dev");
  return join(dirname(fileURLToPath(import.meta.url)), "../../platform-native/src/dev");
}

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

  return devNative(parsed);
}

/**
 * Native dev mode — runs the game with winit + wgpu under Bun, Node, or Deno.
 * Looks for `src/native-entry.ts` in the game directory.
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
  const noHmr = parsed.flags["no-hmr"] as boolean;

  const env = { ...process.env };
  const port = parsed.flags.port as number;
  if (port) env.MCP_PORT = String(port);

  // Signal handling lives outside the respawn loop — each spawn registers
  // itself as the current child so SIGINT/SIGTERM always hit the live one.
  let currentChild: import("child_process").ChildProcess | null = null;
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("DownDraft", "Shutting down...");
    const child = currentChild;
    try { child?.kill("SIGINT"); } catch {}
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    setTimeout(() => {
      if (child?.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        killProcessTree(child.pid);
      }
      process.exit(130);
    }, 2000);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  // ── Legacy path: --no-hmr spawns the entry directly under Bun (no watcher,
  //    no ModuleRunner — the pre-HMR behavior, kept as an escape hatch). ──
  if (noHmr) {
    log.info("DownDraft", "Starting in native mode — direct spawn, no HMR (--no-hmr)...");
    log.info("DownDraft", `  Game: ${game}`);
    log.info("DownDraft", `  Entry: ${nativeEntry}`);
    const code = await spawnAndForward("bun", ["run", nativeEntry], buildCwd(gameDir), env, {
      onChild: (c) => { currentChild = c; },
    });
    if (!shuttingDown) process.exit(code);
    return;
  }

  // ── HMR path: spawn the dev shell under the selected JS runtime. ──
  const devDir = resolveDevShellDir();
  const devShell = join(devDir, "dev-shell.mjs");
  if (!existsSync(devShell)) {
    log.error("DownDraft", `Dev shell not found at "${devShell}".`);
    log.error("DownDraft", "Is @downdraft/platform-native installed? Try `draft dev --no-hmr` for the legacy path.");
    process.exit(1);
  }

  // Runtime detection is delegated to the dev package (it owns the matrix).
  const { detectRuntime, spawnArgsFor, findDenoConfig } =
    await import(resolve(devDir, "runtime-detect.mjs"));

  const requested = (parsed.flags.runtime as string | undefined) ?? process.env.DD_RUNTIME;
  const runtime = detectRuntime(requested);
  if (!runtime) {
    if (requested) {
      log.error("DownDraft", `Requested runtime "${requested}" is not available on PATH.`);
    } else {
      log.error("DownDraft", "No JS runtime found — need one of: bun, node, deno.");
    }
    process.exit(1);
  }

  env.DD_GAME_DIR = gameDir;
  env.DD_ENTRY = nativeEntry;
  env.DD_RUNTIME = runtime;
  env.DD_HMR = "1";
  env.DOWNDRAFT_DEV = "1";
  if (verbose) env.DD_VERBOSE = "1";
  const repoRoot = findMonorepoRoot();
  if (repoRoot) env.DD_REPO_ROOT = repoRoot;

  const { cmd, args } = spawnArgsFor(runtime, devShell, {
    configPath: runtime === "deno" ? findDenoConfig(gameDir, repoRoot) : undefined,
  });

  log.info("DownDraft", `Starting in native mode (${runtime} + SDL + wgpu-native, HMR on)...`);
  log.info("DownDraft", `  Game: ${game}`);
  log.info("DownDraft", `  Entry: ${nativeEntry}`);
  log.info("DownDraft", `  Runtime: ${cmd} ${args.join(" ")}`);
  if (verbose) log.info("DownDraft", "  Verbose: on");

  // Respawn loop: the dev shell exits with DD_RESTART_EXIT when a changed
  // file affects the loader/config layer (Tier-5) — respawn in place.
  for (;;) {
    const code = await spawnAndForward(cmd, args, buildCwd(gameDir), env, {
      onChild: (c) => { currentChild = c; },
    });
    if (shuttingDown) return; // signal handler already owns exit
    if (code === DD_RESTART_EXIT) {
      log.info("DownDraft", "Restarting dev shell (infrastructure change)...");
      continue;
    }
    process.exit(code);
  }
}

/** Spawn `cmd args`, forward stdio, resolve the exit code (signal exits are
 *  mapped to 128+n so the caller's respawn loop can distinguish them). */
function spawnAndForward(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: { onChild?: (child: import("child_process").ChildProcess) => void } = {},
): Promise<number> {
  const child = spawn(cmd, args, {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    env,
    detached: true,
  });
  opts.onChild?.(child);

  child.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));

  return new Promise<number>((resolvePromise, reject) => {
    child.on("error", (err) => {
      log.error("DownDraft", `Failed to spawn ${cmd}: ${err.message}`);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        resolvePromise(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}
