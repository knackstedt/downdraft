import { createLogger } from "@downdraft/engine";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";
import { parseArgs, print, renderHelp } from "./args";
import { findMonorepoRoot, resolveGameDir } from "./paths";
import { getCommand } from "./usage";

const log = createLogger();

type Renderer = "gpu" | "cpu";

/** Grab an OS-assigned free TCP port so e2e runs don't collide with a
 *  running dev instance on the old pinned port (9976). */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port assigned"))));
    });
    srv.on("error", reject);
  });
}

interface TestArgs {
  game: string;
  mcpPort: number;
  spec: string | null;
  renderer: Renderer;
  deterministic: boolean;
  headed: boolean;
  verbose: boolean;
  /** Removed flags kept in the schema so they hard-error instead of being
   *  silently ignored by the arg parser. */
  runtime: string;
  build: boolean;
  buildOnly: boolean;
}

function parseTestArgs(args: string[]): TestArgs {
  const entry = getCommand("test")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    process.exit(0);
  }
  const port = parsed.flags.port as number;
  return {
    game: parsed.flags.game as string,
    mcpPort: port,
    spec: (parsed.flags.spec as string) || null,
    renderer: parsed.flags.renderer as Renderer,
    deterministic: !(parsed.flags["no-deterministic"] as boolean),
    headed: parsed.flags.headed as boolean,
    verbose: parsed.flags.verbose as boolean,
    runtime: parsed.flags.runtime as string,
    build: parsed.flags.build as boolean,
    buildOnly: parsed.flags["build-only"] as boolean,
  };
}

/**
 * Check whether xvfb-run is available on the system.
 */
function hasXvfb(): boolean {
  try {
    return existsSync("/usr/bin/xvfb-run") || existsSync("/usr/local/bin/xvfb-run");
  } catch {
    return false;
  }
}



export async function runTest(args: string[]): Promise<void> {
  const opts = parseTestArgs(args);
  const monorepoRoot = findMonorepoRoot();
  const gameDir = resolveGameDir(opts.game || undefined);

  if (!opts.game && gameDir) {
    opts.game = basename(gameDir);
  }
  if (!opts.game) {
    log.error("test", `No game specified and none could be inferred from "${process.cwd()}".`);
    log.error("test", `Run "draft test --game=<name>" or pass --spec=<path>.`);
    process.exit(1);
  }

  // Hard-error stubs — the Electron/electron-vite lanes are gone.
  if (opts.runtime === "electron") {
    log.error("test", "The Electron runtime is removed. Re-run without --runtime=electron (native is the only runtime).");
    process.exit(1);
  }
  if (opts.build || opts.buildOnly) {
    log.error("test", "--build/--build-only used the removed electron-vite pipeline.");
    log.error("test", "Native packaging is handled by `draft release` (scripts/package-native.mjs).");
    process.exit(1);
  }

  // Default spec: <monorepo>/tests/e2e/<game>-smoke.spec.ts, or the standalone
  // game's own tests/e2e dir. When neither exists, require --spec.
  let specPath = opts.spec ? resolve(opts.spec) : null;
  if (!specPath) {
    const candidates = [
      monorepoRoot ? resolve(monorepoRoot, "tests", "e2e", `${opts.game}-smoke.spec.ts`) : null,
      gameDir ? resolve(gameDir, "tests", "e2e", `${opts.game}-smoke.spec.ts`) : null,
    ].filter((p): p is string => !!p);
    specPath = candidates.find((p) => existsSync(p)) ?? candidates[0];
  }
  if (!specPath || !existsSync(specPath)) {
    log.error("test", `No test spec found for game "${opts.game}".`);
    log.error("test", `Looked in: tests/e2e/${opts.game}-smoke.spec.ts`);
    log.error("test", `Pass --spec=<path> to specify a spec file.`);
    process.exit(1);
  }

  if (!opts.mcpPort) {
    opts.mcpPort = await findFreePort();
  }

  log.info("test", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — E2E Test Runner     ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("test", `  Game:          ${opts.game}`);
  log.info("test", `  Spec:          ${specPath}`);
  log.info("test", `  MCP port:      ${opts.mcpPort}`);
  log.info("test", `  Renderer:      ${opts.renderer === "cpu" ? "SwiftShader (software)" : "hardware GPU"}`);
  log.info("test", `  Deterministic: ${opts.deterministic}`);
  log.info("test", `  Headed:        ${opts.headed}`);
  if (opts.verbose) log.info("test", `  Verbose:       on`);
  log.info("test", "");

  const env: Record<string, string> = {
    ...process.env,
    MCP_PORT: String(opts.mcpPort),
    MCP_TIMEOUT_MS: "120000",
  };

  if (opts.renderer === "cpu") {
    env.DOWNDRAFT_GPU = "swiftshader";
  } else {
    env.DOWNDRAFT_GPU = "hardware";
  }
  if (opts.deterministic) {
    env.DOWNDRAFT_DETERMINISTIC = "1";
  }
  if (opts.headed) {
    // Show the window instead of running headless.
    env.DOWNDRAFT_HEADED = "1";
  }

  // If no display is available, wrap in xvfb-run (common in CI).
  let cmd = "bun";
  let cmdArgs = ["test", specPath];
  const noDisplay = !env.DISPLAY;
  if (noDisplay && hasXvfb()) {
    log.info("test", "No DISPLAY detected — wrapping in xvfb-run");
    cmd = "xvfb-run";
    cmdArgs = ["-a", "--", "bun", "test", specPath];
  } else if (noDisplay) {
    log.warn("test", "No DISPLAY and xvfb-run not found — the native window may fail to start.");
    log.warn("test", "Install xvfb with: sudo apt install xvfb");
  }

  const child = spawn(cmd, cmdArgs, {
    cwd: monorepoRoot ?? gameDir ?? process.cwd(),
    stdio: "inherit",
    env,
  });

  const shutdown = () => {
    try { child.kill("SIGINT"); } catch {}
    setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      process.exit(130);
    }, 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Await the child process so `draft test` blocks until the spec (and the
  // spawned game) fully finishes + cleans up. Without this, the async
  // function resolves immediately after spawning while the game is still
  // booting, and the next sequential e2e run starts concurrently — colliding
  // on the MCP port.
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      log.error("test", `Failed to spawn test process: ${err.message}`);
      resolve(1);
    });
  });

  if (exitCode === 0) {
    log.info("test", "All tests passed.");
  } else {
    log.error("test", `Tests failed with exit code ${exitCode}.`);
  }
  process.exit(exitCode);
}
